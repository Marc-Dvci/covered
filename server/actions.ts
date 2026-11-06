// What people do to a visit: check in, check out, cancel, report a lock-out, move it to another member.
// Each action checks the visit's state, stores the outcome, and hands the money to a task.
import { dollars, type Household, type Member } from "../shared/domain.ts";
import { holdAtMinutesBefore, priceCents, settle, type Outcome } from "../shared/rules/settle.ts";
import { readableReasons, solve } from "./dispatch/solver.ts";
import type { Runner } from "./runner.ts";
import type { Store, VisitRow } from "./store.ts";

export class ActionError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

export interface Ctx {
  store: Store;
  runner: Runner;
}

async function need(store: Store, id: string): Promise<VisitRow> {
  const v = await store.visit(id);
  if (!v) throw new ActionError("no such visit", 404);
  return v;
}

export async function checkIn(c: Ctx, id: string, memberId: string): Promise<VisitRow> {
  const v = await need(c.store, id);
  if (!v.memberIds.includes(memberId)) throw new ActionError("this visit is assigned to someone else", 403);
  if (!["held", "at_risk", "scheduled"].includes(v.state)) throw new ActionError(`cannot check in a visit that is ${v.state}`);
  const out = await c.store.updateVisit(id, { state: "in_progress", checkinAt: await c.store.now() });
  await c.store.event("visit.checked_in", id, memberId);
  return out;
}

/** The member checks out. Extra time is billed only if the household approves it. */
export async function checkOut(c: Ctx, id: string, memberId: string, extraApproved: boolean): Promise<VisitRow> {
  const v = await need(c.store, id);
  if (v.state !== "in_progress") throw new ActionError(`cannot check out a visit that is ${v.state}`);
  if (!v.memberIds.includes(memberId)) throw new ActionError("this visit is assigned to someone else", 403);
  const now = await c.store.now();
  const worked = Math.max(0, now - (v.checkinAt ?? v.start));
  const share = Object.fromEntries(v.memberIds.map((m) => [m, Math.round(worked)])) as Record<string, number>;
  const outcome: Outcome = { type: "checkout", worked: share, extraApproved };
  const out = await c.store.updateVisit(id, { state: "settling", checkoutAt: now, outcome });
  await c.store.event("visit.checked_out", id, memberId, { worked, extraApproved });
  await c.runner.start("settleVisit", id);
  return out;
}

export async function cancelPreview(c: Ctx, id: string) {
  const v = await need(c.store, id);
  const now = await c.store.now();
  const minutesBefore = v.start - now;
  if (minutesBefore <= 0 || !["scheduled", "holding", "held", "at_risk"].includes(v.state)) {
    return {
      minutesBefore,
      late: false,
      feeCents: 0,
      releaseCents: 0,
      heldCents: v.hold?.cents ?? 0,
      lateFeeCents: 0,
      noticeHours: v.terms.noticeHours,
      closed: true,
    };
  }
  const s = settle(v.terms, { type: "cancel", by: "household", minutesBefore, assigned: v.memberIds }, v.hold ? "placed" : "failed");
  const lateFee = Math.round((priceCents(v.terms) * v.terms.lateCancelPct) / 100);
  return {
    minutesBefore,
    late: minutesBefore <= v.terms.noticeHours * 60,
    feeCents: v.hold ? s.captureCents : s.dueCents,
    releaseCents: s.releaseCents,
    heldCents: v.hold?.cents ?? 0,
    lateFeeCents: lateFee,
    noticeHours: v.terms.noticeHours,
    closed: false,
  };
}

export async function cancel(c: Ctx, id: string, by: "household" | "cooperative", actor: string): Promise<VisitRow> {
  const v = await need(c.store, id);
  if (!["scheduled", "holding", "held", "at_risk"].includes(v.state)) throw new ActionError(`cannot cancel a visit that is ${v.state}`);
  const now = await c.store.now();
  if (now >= v.start) throw new ActionError("the visit has started");
  const outcome: Outcome = { type: "cancel", by, minutesBefore: v.start - now, assigned: v.memberIds };
  const out = await c.store.updateVisit(id, { state: "settling", outcome });
  await c.store.event("visit.cancelled", id, actor, { by, minutesBefore: v.start - now });
  await c.runner.start("settleVisit", id);
  return out;
}

export async function lockout(c: Ctx, id: string, memberId: string): Promise<VisitRow> {
  const v = await need(c.store, id);
  if (!v.memberIds.includes(memberId)) throw new ActionError("this visit is assigned to someone else", 403);
  if (!["held", "at_risk"].includes(v.state)) throw new ActionError(`cannot report a lock-out on a visit that is ${v.state}`);
  const out = await c.store.updateVisit(id, { state: "settling", outcome: { type: "lockout", assigned: v.memberIds } });
  await c.store.event("visit.lockout", id, memberId);
  await c.runner.start("settleVisit", id);
  return out;
}

export async function noCover(c: Ctx, id: string, actor: string): Promise<VisitRow> {
  const v = await need(c.store, id);
  // only before the work starts: a checked-in member gets paid at check-out, never released
  if (!["scheduled", "held", "at_risk"].includes(v.state)) throw new ActionError(`cannot release a visit that is ${v.state.replace("_", " ")}`);
  const out = await c.store.updateVisit(id, { state: "settling", outcome: { type: "member_absent" } });
  await c.store.event("visit.no_cover", id, actor);
  await c.runner.start("settleVisit", id);
  return out;
}

/** The drag guard: may this visit go to this member? Same checks as the solver, one visit at a time. */
export async function canMove(
  c: Ctx,
  id: string,
  memberId: string,
  start?: number,
): Promise<{ ok: boolean; reasons: string[]; consent: boolean; hold: string }> {
  const v = await need(c.store, id);
  const [members, households, visits] = await Promise.all([c.store.members(), c.store.households(), c.store.visits()]);
  if (["done", "settling", "captured", "paid_out", "cancelled", "voided", "late_cancel", "in_progress"].includes(v.state)) {
    return { ok: false, reasons: [`the visit is ${v.state === "done" ? "over" : v.state.replace("_", " ")}`], consent: false, hold: holdText(v) };
  }
  const moved = visits.map((x) => (x.id === id ? { ...x, memberIds: [], start: start ?? x.start } : x));
  const absences = (await activeAbsences(c.store)).map((a) => ({ memberId: a.memberId, from: a.from, to: a.to }));
  const r = solve({ members, households: households as Household[], visits: moved, absences, affected: [id], maxPlans: 1 });
  const cand = r.candidates[id]!.find((x) => x.memberId === memberId);
  if (!cand) return { ok: false, reasons: ["unknown member"], consent: false, hold: holdText(v) };
  const reasons = readableReasons(cand.reasons, visits, households as Household[]);
  const newStart = start ?? v.start;
  if (start !== undefined && start !== v.start && v.hold) {
    const now = await c.store.now();
    if (newStart - now > holdAtMinutesBefore(v.terms) + 3 * 1440) reasons.push("the hold would expire before the new time");
  }
  return { ok: reasons.length === 0, reasons, consent: cand.consent, hold: holdText(v) };
}

export function holdText(v: VisitRow): string {
  if (v.hold) return `${dollars(v.hold.cents)} held`;
  if (v.state === "at_risk") return "hold refused";
  return "not held yet";
}

/** Apply a move. A same-cleaner household is asked first; the visit waits for its answer. */
export async function move(c: Ctx, id: string, memberId: string, actor: string, start?: number): Promise<{ visit: VisitRow; pendingConsent: boolean }> {
  const check = await canMove(c, id, memberId, start);
  if (!check.ok) throw new ActionError(check.reasons.join("; "));
  const v = await need(c.store, id);
  if (check.consent) {
    const out = await c.store.updateVisit(id, { pendingMember: memberId });
    await c.store.event("visit.consent_requested", id, actor, { memberId });
    return { visit: out, pendingConsent: true };
  }
  const out = await c.store.updateVisit(id, { memberIds: [memberId], pendingMember: null, ...(start !== undefined ? { start } : {}) });
  await c.store.event("visit.reassigned", id, actor, { from: v.memberIds, to: memberId, start });
  return { visit: out, pendingConsent: false };
}

export async function answerConsent(c: Ctx, id: string, householdId: string, approve: boolean): Promise<VisitRow> {
  const v = await need(c.store, id);
  if (v.householdId !== householdId) throw new ActionError("not your visit", 403);
  if (!v.pendingMember) throw new ActionError("nothing to approve");
  if (!approve) {
    const out = await c.store.updateVisit(id, { pendingMember: null });
    await c.store.event("visit.consent_declined", id, householdId, { memberId: v.pendingMember });
    return out;
  }
  const check = await canMove(c, id, v.pendingMember);
  if (!check.ok) {
    await c.store.updateVisit(id, { pendingMember: null });
    await c.store.event("visit.consent_stale", id, householdId, { memberId: v.pendingMember, reasons: check.reasons });
    throw new ActionError(`this member can no longer take the visit: ${check.reasons.join("; ")}`);
  }
  const out = await c.store.updateVisit(id, { memberIds: [v.pendingMember], pendingMember: null });
  await c.store.event("visit.consent_given", id, householdId, { memberId: v.pendingMember });
  await c.store.event("visit.reassigned", id, householdId, { from: v.memberIds, to: v.pendingMember });
  return out;
}

export interface Absence {
  memberId: string;
  from: number;
  to: number;
  disruptionId: string;
}

export async function activeAbsences(store: Store): Promise<Absence[]> {
  const rows = await store.db.query<{ id: string; member_id: string; day: number; from_min: number | null; kind: string }>(
    "select id, member_id, day, from_min, kind from disruptions where status <> 'dismissed'",
  );
  return rows.map((r) => ({ memberId: r.member_id, from: r.day * 1440 + (r.from_min ?? 0), to: r.day * 1440 + 1440, disruptionId: r.id }));
}

export type { Member };
