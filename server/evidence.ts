// The cooperative's answer to a household's dispute, built only from the ledger: the agreed terms, who
// came, when they checked in and out, and the hold, capture and payout with their PayPal ids. Nothing
// here comes from a model; every line points at a row the money tasks wrote.
import { clock, dollars } from "../shared/domain.ts";
import { holdCents, priceCents } from "../shared/rules/settle.ts";
import { TIME_ZONE } from "../shared/seed.ts";
import { boardDate } from "./statements.ts";
import type { Store } from "./store.ts";

export interface Evidence {
  visitId: string;
  household: { name: string; area: string };
  members: string[];
  scheduled: { date: string; start: string; end: string; timeZone: string };
  terms: { rate: string; price: string; hold: string; noticeHours: number; lateCancelPct: number; lockoutPct: number; extraAllowanceMinutes: number };
  agreementId: string | null;
  attendance: { checkIn: string | null; checkOut: string | null; minutesOnSite: number | null; extraApproved: boolean | null };
  outcome: string;
  money: { step: string; amount: string; paypalId: string | null; status: string; at: string }[];
  timeline: { at: string; what: string; by: string }[];
  summary: string;
}

const at = (t: number) => `${boardDate(t)} ${clock(t)}`;

const WHAT: Record<string, (d: Record<string, unknown>, name: (id: string) => string) => string> = {
  "visit.scheduled": () => "Visit booked",
  "hold.placed": (d) => `Hold placed on the household's PayPal: ${dollars(Number(d.cents))}`,
  "hold.failed": (d) => `Hold refused by PayPal (${String(d.issue)})`,
  "visit.consent_requested": (d, n) => `Household asked whether ${n(String(d.memberId))} may come instead`,
  "visit.consent_given": (d, n) => `Household agreed to ${n(String(d.memberId))}`,
  "visit.consent_declined": (d, n) => `Household declined ${n(String(d.memberId))}`,
  "visit.reassigned": (d, n) => `Visit given to ${n(String(d.to))}`,
  "visit.no_cover": () => "No cover found; the hold was released",
  "visit.checked_in": () => "Member checked in at the door",
  "visit.checked_out": (d) => `Member checked out after ${Number(d.worked)} minutes${d.extraApproved ? ", extra time approved by the household" : ""}`,
  "visit.cancelled": (d) => `Cancelled by the ${String(d.by)}, ${Math.round(Number(d.minutesBefore))} minutes before the start`,
  "visit.lockout": () => "Member could not get in",
  "payment.captured": (d) => `Captured ${dollars(Number(d.cents))}, released ${dollars(Number(d.releasedCents))}`,
  "payment.voided": (d) => `Hold voided, ${dollars(Number(d.cents))} released`,
  "payout.sent": () => "Payout sent to the member",
  "payout.duplicate_refused": () => "A repeated payout was refused by PayPal (already paid)",
  "payout.final": (d) => `Payout ${String(d.status).toLowerCase()}`,
};

export async function evidence(store: Store, visitId: string): Promise<Evidence | null> {
  const v = await store.visit(visitId);
  if (!v) return null;
  const [h, members, money, events, agreement] = await Promise.all([
    store.household(v.householdId),
    store.members(),
    store.moneyRows(visitId),
    store.events(200, visitId),
    store.db.query<{ agreement_id: string | null }>("select agreement_id from households where id = $1", [v.householdId]),
  ]);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const actor = (id: string) =>
    id === "workflow" ? "cooperative system" : id === "dana" ? "Dana (coordinator)" : id === v.householdId ? (h?.name ?? id) : name(id);
  const t = v.terms;
  const onSite = v.checkinAt !== null && v.checkoutAt !== null ? v.checkoutAt - v.checkinAt : null;
  const extra = v.outcome?.type === "checkout" ? v.outcome.extraApproved : null;
  const outcome = v.settlement?.reason ?? (v.outcome ? v.outcome.type : `not settled (${v.state})`);

  // one row per money step, the newest status of each
  const latest = new Map<string, (typeof money)[number]>();
  for (const m of money) latest.set(`${m.kind}:${m.ref}`, m);
  const steps = [...latest.values()].map((m) => ({
    step: m.kind === "payout" ? `payout to ${name(String((m.detail as { memberId?: string } | null)?.memberId ?? ""))}` : m.kind,
    amount: dollars(m.cents),
    // a payout line names the member's PayPal transaction once PayPal has given one, else the batch
    paypalId:
      m.kind === "payout"
        ? (v.payout?.items.find((i) => i.memberId === (m.detail as { memberId?: string } | null)?.memberId)?.transactionId ?? m.paypal_id)
        : m.paypal_id,
    status: m.status,
    at: at(m.board_at),
  }));

  const timeline = events
    .slice()
    .reverse()
    .filter((e) => WHAT[e.type])
    .map((e) => ({ at: at(e.board_at), what: WHAT[e.type]!(e.data, name), by: actor(e.actor) }));

  const capture = v.capture ? `${dollars(v.capture.cents)} was captured (PayPal capture ${v.capture.captureId})` : "nothing was captured";
  const summary = [
    `${h?.name ?? v.householdId} booked ${t.bookedMinutes / 60} hours at ${dollars(t.rateCentsPerHour)} an hour for ${boardDate(v.start)} ${clock(v.start)}.`,
    v.checkinAt !== null
      ? `${v.memberIds.map(name).join(" and ")} checked in at ${clock(v.checkinAt)}${v.checkoutAt !== null ? ` and out at ${clock(v.checkoutAt)} (${onSite} minutes)` : ""}.`
      : "",
    `${outcome[0]!.toUpperCase()}${outcome.slice(1)}: ${capture}${v.settlement?.releaseCents ? `, and ${dollars(v.settlement.releaseCents)} of the hold was released` : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    visitId: v.id,
    household: { name: h?.name ?? v.householdId, area: h?.area ?? "" },
    members: v.memberIds.map(name),
    scheduled: { date: boardDate(v.start), start: clock(v.start), end: clock(v.start + v.minutes), timeZone: TIME_ZONE },
    terms: {
      rate: dollars(t.rateCentsPerHour),
      price: dollars(priceCents(t)),
      hold: dollars(holdCents(t)),
      noticeHours: t.noticeHours,
      lateCancelPct: t.lateCancelPct,
      lockoutPct: t.lockoutPct,
      extraAllowanceMinutes: t.extraAllowanceMinutes,
    },
    agreementId: agreement[0]?.agreement_id ?? null,
    attendance: {
      checkIn: v.checkinAt !== null ? at(v.checkinAt) : null,
      checkOut: v.checkoutAt !== null ? at(v.checkoutAt) : null,
      minutesOnSite: onSite,
      extraApproved: extra,
    },
    outcome,
    money: steps,
    timeline,
    summary,
  };
}
