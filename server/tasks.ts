// The money steps of a visit. Each one reads the visit, does only what is not yet done, and records
// what it did, so a retried run (Cloudflare Workflows retries a failed step) never charges or pays twice:
// PayPal-Request-Id, the invoice id and the payout's sender batch id are derived from the visit id and the
// run tag of the last demo reset.
import { dollars } from "../shared/domain.ts";
import { holdAtMinutesBefore, holdCents, settle } from "../shared/rules/settle.ts";
import { PayPalError, type PayPal } from "./paypal/types.ts";
import type { Store, VisitRow } from "./store.ts";

export interface TaskDeps {
  store: Store;
  paypal: PayPal;
  payoutPollMs?: number;
  payoutWaitMs?: number;
}

export type TaskName = "placeHold" | "settleVisit";

export const PAYOUT_WAIT_MS = 120_000;
const FINAL = ["SUCCESS", "DENIED", "CANCELED"];

export async function placeHold(d: TaskDeps, visitId: string): Promise<string> {
  const v = await d.store.visit(visitId);
  if (!v) return "no such visit";
  if (v.hold || !["scheduled", "holding", "at_risk"].includes(v.state)) return `nothing to do (${v.state})`;
  const h = await d.store.household(v.householdId);
  if (!h?.vaultId) {
    await d.store.updateVisit(v.id, { state: "at_risk" });
    await d.store.event("hold.failed", v.id, "workflow", { issue: "NO_SAVED_PAYPAL" });
    return "no saved PayPal";
  }
  const cents = holdCents(v.terms);
  const ref = await d.store.payRef(v.id);
  await d.store.updateVisit(v.id, { state: "holding" });
  try {
    const hold = await d.paypal.authorize(h.vaultId, cents, ref, `Home cleaning, ${h.name}`, `covered-${ref}`);
    // placed when it fell due on the board's clock (the demo clock can jump past that moment)
    const placedAt = Math.min(await d.store.now(), v.start - holdAtMinutesBefore(v.terms));
    await d.store.updateVisit(v.id, {
      state: "held",
      hold: { orderId: hold.orderId, authorizationId: hold.authorizationId, cents, placedAt, status: hold.status },
    });
    await d.store.money(v.id, "hold", cents, v.id, hold.authorizationId, hold.status);
    await d.store.event("hold.placed", v.id, "workflow", { cents, authorizationId: hold.authorizationId });
    return `held ${dollars(cents)}`;
  } catch (e) {
    if (e instanceof PayPalError && e.status < 500) {
      await d.store.updateVisit(v.id, { state: "at_risk" });
      await d.store.event("hold.failed", v.id, "workflow", { issue: e.issue, debugId: e.debugId });
      return `refused: ${e.issue}`;
    }
    await d.store.updateVisit(v.id, { state: "scheduled" });
    throw e; // transient: let the runner retry
  }
}

const settled = (v: VisitRow) =>
  ["paid_out", "cancelled", "voided", "late_cancel"].includes(v.state) && Boolean(v.payout?.finalAt || !v.settlement?.captureCents);

/** First half of a settlement: capture or void per the outcome, then send the members' payout. Safe to repeat. */
export async function settleMoney(d: TaskDeps, visitId: string): Promise<string> {
  let v = await d.store.visit(visitId);
  if (!v) return "no such visit";
  if (!v.outcome) return "no outcome yet";
  if (settled(v)) return `already settled (${v.state})`;

  const s = settle(v.terms, v.outcome, v.hold ? "placed" : "failed");
  const ref = await d.store.payRef(v.id);
  v = await d.store.updateVisit(v.id, { settlement: s, state: "settling" });

  if (s.captureCents > 0 && !v.capture && v.hold) {
    const c = await d.paypal.capture(v.hold.authorizationId, s.captureCents, ref, `covered-${ref}`, true);
    v = await d.store.updateVisit(v.id, { capture: { captureId: c.captureId, cents: c.grossCents, feeCents: c.paypalFeeCents, at: await d.store.now() } });
    await d.store.money(v.id, "capture", c.grossCents, v.id, c.captureId, c.status, { feeCents: c.paypalFeeCents, releasedCents: s.releaseCents });
    await d.store.event("payment.captured", v.id, "workflow", { cents: c.grossCents, releasedCents: s.releaseCents, captureId: c.captureId });
  } else if (s.captureCents === 0 && v.hold && !v.void) {
    try {
      const r = await d.paypal.void(v.hold.authorizationId, ref);
      v = await d.store.updateVisit(v.id, { void: { at: await d.store.now(), status: r.status } });
    } catch (e) {
      if (!(e instanceof PayPalError && e.issue.includes("VOID"))) throw e;
      v = await d.store.updateVisit(v.id, { void: { at: await d.store.now(), status: e.issue } });
    }
    await d.store.money(v.id, "void", v.hold!.cents, v.id, v.hold!.authorizationId, "VOIDED");
    await d.store.event("payment.voided", v.id, "workflow", { cents: v.hold!.cents });
  }

  // test hook for the durability check: fail once, after the capture and before the payout
  if (await d.store.kvTake(`crash-after-capture:${v.id}`)) {
    await d.store.event("task.crashed", v.id, "workflow", { step: "after capture", injected: true });
    throw new Error("injected crash after capture");
  }

  const shares = Object.entries(s.members).filter(([, c]) => c > 0);
  if (shares.length && !v.payout) {
    const members = await d.store.members();
    const h = await d.store.household(v.householdId);
    const items = shares.map(([memberId, cents]) => {
      const m = members.find((x) => x.id === memberId)!;
      return { itemId: `${v!.id}-${memberId}`, receiver: m.payout.receiver, wallet: m.payout.wallet, cents, note: `${h?.name ?? "Visit"}: ${s.reason}` };
    });
    const sender = `covered-${ref}`;
    try {
      const p = await d.paypal.payout(sender, items, "Your pay from the cooperative");
      v = await d.store.updateVisit(v.id, {
        payout: {
          batchId: p.batchId,
          senderBatchId: sender,
          status: p.status,
          sentAt: await d.store.now(),
          sentMs: Date.now(),
          items: items.map((i, k) => ({
            memberId: shares[k]![0],
            cents: i.cents,
            wallet: i.wallet,
            status: p.items[k]?.status,
            transactionId: p.items[k]?.transactionId,
          })),
        },
      });
      for (const [memberId, cents] of shares) await d.store.money(v.id, "payout", cents, `${sender}-${memberId}`, p.batchId, p.status, { memberId });
      await d.store.event("payout.sent", v.id, "workflow", { batchId: p.batchId, items: shares });
    } catch (e) {
      if (!(e instanceof PayPalError && (e.issue.includes("DUPLICATE") || e.issue.includes("already exists")))) throw e;
      // sent by an earlier attempt whose record was lost: PayPal refused to pay twice
      v = await d.store.updateVisit(v.id, {
        payout: {
          batchId: "",
          senderBatchId: sender,
          status: "SENT_EARLIER",
          sentAt: await d.store.now(),
          items: shares.map(([memberId, cents]) => ({ memberId, cents, wallet: "" })),
        },
      });
      await d.store.event("payout.duplicate_refused", v.id, "workflow", { sender });
    }
  }
  return `money moved: captured ${dollars(s.captureCents)}, released ${dollars(s.releaseCents)}`;
}

/** Ask PayPal once where the payout is. True when there is nothing more to wait for. */
export async function pollPayout(d: TaskDeps, visitId: string): Promise<boolean> {
  let v = await d.store.visit(visitId);
  if (!v?.payout?.batchId || v.payout.finalAt) return true;
  const waited = Date.now() - (v.payout.sentMs ?? Date.now());
  const wait = d.payoutWaitMs ?? PAYOUT_WAIT_MS;
  const p = await d.paypal.getPayout(v.payout.batchId);
  const final = FINAL.includes(p.status);
  const items = mergePayoutItems(v.id, v.payout.items, p.items);
  // transaction ids can trail the batch's SUCCESS by a few seconds
  const complete = final && (p.status !== "SUCCESS" || items.every((i) => i.transactionId) || waited >= wait);
  v = await d.store.updateVisit(v.id, {
    payout: { ...v.payout, status: p.status, items, ...(complete ? { finalAt: await d.store.now(), finalMs: waited } : {}) },
  });
  for (const i of items)
    await d.store.money(v.id, "payout", i.cents, `${v.payout!.senderBatchId}-${i.memberId}`, v.payout!.batchId, p.status, {
      memberId: i.memberId,
      transactionId: i.transactionId,
    });
  if (complete) await d.store.event("payout.final", v.id, "workflow", { status: p.status });
  return complete || waited >= wait;
}

/** Last step of a settlement: the visit's state now that the money has moved. */
export async function finishVisit(d: TaskDeps, visitId: string): Promise<string> {
  const v = await d.store.visit(visitId);
  if (!v?.settlement) return "nothing to finish";
  const s = v.settlement;
  const state =
    s.captureCents === 0
      ? v.outcome?.type === "member_absent"
        ? "voided"
        : "cancelled"
      : v.outcome?.type === "cancel"
        ? "late_cancel"
        : v.payout
          ? "paid_out"
          : "captured";
  await d.store.updateVisit(v.id, { state });
  return `${state}: captured ${dollars(s.captureCents)}, released ${dollars(s.releaseCents)}`;
}

/** The whole settlement in one call, for the in-process runner. Workflows run the same three parts as durable steps. */
export async function settleVisit(d: TaskDeps, visitId: string): Promise<string> {
  const moved = await settleMoney(d, visitId);
  if (!moved.startsWith("money moved")) return moved;
  while (!(await pollPayout(d, visitId))) await new Promise((r) => setTimeout(r, d.payoutPollMs ?? 3000));
  return finishVisit(d, visitId);
}

/** Match PayPal's items to ours by sender_item_id (`<visit>-<member>`), never by position. */
export function mergePayoutItems(
  visitId: string,
  ours: NonNullable<VisitRow["payout"]>["items"],
  theirs: { itemId: string; transactionId?: string; status?: string }[],
): NonNullable<VisitRow["payout"]>["items"] {
  return ours.map((i) => {
    const t = theirs.find((x) => x.itemId === `${visitId}-${i.memberId}`);
    return { ...i, status: t?.status ?? i.status, transactionId: t?.transactionId ?? i.transactionId };
  });
}

/** Visits whose hold is due: start minus (notice + lead) has passed, and the visit has not started. */
export async function dueForHold(store: Store, now: number): Promise<VisitRow[]> {
  return (await store.visits()).filter(
    (v) => v.state === "scheduled" && v.memberIds.length > 0 && v.start - holdAtMinutesBefore(v.terms) <= now && v.start > now,
  );
}
