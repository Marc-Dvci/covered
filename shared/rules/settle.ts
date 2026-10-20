// What each visit outcome moves, in cents. Pure: the same terms and event always give the same split.
// The hold covers the price plus the extra-time allowance; what is not captured is released.
import type { Terms } from "../domain.ts";

export type Outcome =
  | { type: "checkout"; worked: Record<string, number>; extraApproved: boolean }
  | { type: "cancel"; by: "household" | "cooperative"; minutesBefore: number; assigned: string[] }
  | { type: "lockout"; assigned: string[] }
  | { type: "member_absent" };

export interface Settlement {
  holdCents: number;
  captureCents: number;
  releaseCents: number;
  coopCents: number;
  members: Record<string, number>;
  /** Owed but not collectable because no hold exists (the hold failed). */
  dueCents: number;
  reason: string;
}

/** Half-up rounding of a non-negative rational a/b to an integer. */
function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

export function priceCents(t: Terms): number {
  return roundDiv(t.rateCentsPerHour * t.bookedMinutes, 60);
}

export function holdCents(t: Terms): number {
  return roundDiv(t.rateCentsPerHour * (t.bookedMinutes + t.extraAllowanceMinutes), 60);
}

/** Minutes before the start at which the hold is placed. */
export function holdAtMinutesBefore(t: Terms): number {
  return t.noticeHours * 60 + t.holdLeadMinutes;
}

export function isLate(t: Terms, minutesBefore: number): boolean {
  return minutesBefore <= t.noticeHours * 60;
}

/** Split `cents` by integer weights, largest remainder, ties to the earlier key. */
export function split(cents: number, weights: [string, number][]): Record<string, number> {
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const out: Record<string, number> = {};
  if (cents <= 0 || total <= 0) return out;
  const parts = weights.map(([k, w], i) => ({ k, i, floor: Math.floor((cents * w) / total), rem: (cents * w) % total }));
  let left = cents - parts.reduce((a, p) => a + p.floor, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break;
    p.floor += 1;
    left -= 1;
  }
  for (const p of parts) if (p.floor > 0) out[p.k] = p.floor;
  return out;
}

export function settle(t: Terms, o: Outcome, hold: "placed" | "failed" | "auto" = "auto"): Settlement {
  const price = priceCents(t);
  const full = holdCents(t);
  let held: number;
  if (hold === "failed") held = 0;
  else if (hold === "placed") held = full;
  else held = o.type === "cancel" && o.minutesBefore > holdAtMinutesBefore(t) ? 0 : full;

  let owed = 0;
  let weights: [string, number][] = [];
  let reason: string;
  if (o.type === "checkout") {
    const worked = Object.values(o.worked).reduce((a, b) => a + b, 0);
    const extra = o.extraApproved ? Math.max(0, worked - t.bookedMinutes) : 0;
    const steps = Math.floor(Math.min(extra, t.extraAllowanceMinutes) / t.extraStepMinutes) * t.extraStepMinutes;
    owed = roundDiv(t.rateCentsPerHour * (t.bookedMinutes + steps), 60);
    weights = Object.entries(o.worked);
    if (weights.every(([, w]) => w <= 0)) weights = weights.map(([k]) => [k, 1]);
    reason = steps ? `visit completed, ${steps} extra minutes approved` : "visit completed";
  } else if (o.type === "cancel") {
    if (o.by === "household" && isLate(t, o.minutesBefore)) {
      owed = roundDiv(price * t.lateCancelPct, 100);
      weights = o.assigned.map((m) => [m, 1]);
      reason = `cancelled ${o.minutesBefore} minutes before, inside the ${t.noticeHours}-hour notice`;
    } else {
      reason = o.by === "cooperative" ? "cancelled by the cooperative" : "cancelled with notice";
    }
  } else if (o.type === "lockout") {
    owed = roundDiv(price * t.lockoutPct, 100);
    weights = o.assigned.map((m) => [m, 1]);
    reason = "member could not get in";
  } else {
    reason = "member absent and no cover";
  }

  if (held === 0) {
    return { holdCents: 0, captureCents: 0, releaseCents: 0, coopCents: 0, members: {}, dueCents: hold === "failed" ? owed : 0, reason };
  }
  const capture = Math.min(owed, held);
  const coop = Math.floor((capture * t.coopShareBps) / 10_000);
  return {
    holdCents: held,
    captureCents: capture,
    releaseCents: held - capture,
    coopCents: coop,
    members: split(capture - coop, weights),
    dueCents: 0,
    reason,
  };
}
