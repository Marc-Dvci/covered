// The settlement engine's edges, beyond the 40 hand-worked cases: the reason each household and member reads on a
// payment, the hold's three modes, and how a split treats zero weights. Found by mutation testing the engine.
import { describe, expect, it } from "vitest";
import { holdAtMinutesBefore, holdCents, isLate, priceCents, settle, split, type Outcome } from "../shared/rules/settle.ts";
import type { Terms } from "../shared/domain.ts";

const terms: Terms = {
  rateCentsPerHour: 3500,
  bookedMinutes: 240,
  noticeHours: 24,
  holdLeadMinutes: 10,
  lateCancelPct: 50,
  lockoutPct: 100,
  extraAllowanceMinutes: 30,
  extraStepMinutes: 15,
  coopShareBps: 500,
};
const cancel = (minutesBefore: number, by: "household" | "cooperative" = "household"): Outcome => ({ type: "cancel", by, minutesBefore, assigned: ["marek"] });

describe("the reason on a payment", () => {
  it.each<[string, Outcome, string]>([
    ["a visit on time", { type: "checkout", worked: { marek: 240 }, extraApproved: false }, "visit completed"],
    ["approved extra time", { type: "checkout", worked: { marek: 255 }, extraApproved: true }, "visit completed, 15 extra minutes approved"],
    ["a late cancellation", cancel(30), "cancelled 30 minutes before, inside the 24-hour notice"],
    ["a cancellation with notice", cancel(1500), "cancelled with notice"],
    ["the cooperative cancelling", cancel(30, "cooperative"), "cancelled by the cooperative"],
    ["a lock-out", { type: "lockout", assigned: ["marek"] }, "member could not get in"],
    ["nobody to cover", { type: "member_absent" }, "member absent and no cover"],
  ])("%s says so", (_name, outcome, reason) => {
    expect(settle(terms, outcome, "placed").reason).toBe(reason);
  });
});

describe("the hold's three modes", () => {
  it("auto: a cancellation before the hold falls due finds nothing held", () => {
    const at = holdAtMinutesBefore(terms);
    expect(settle(terms, cancel(at + 1)).holdCents).toBe(0);
    expect(settle(terms, cancel(at)).holdCents).toBe(holdCents(terms));
  });

  it("auto: every other outcome finds the hold in place", () => {
    expect(settle(terms, { type: "lockout", assigned: ["marek"] }).holdCents).toBe(holdCents(terms));
    expect(settle(terms, { type: "member_absent" }).releaseCents).toBe(holdCents(terms));
  });

  it("placed: a hold already there is released in full by a cancellation with notice", () => {
    const s = settle(terms, cancel(holdAtMinutesBefore(terms) + 60), "placed");
    expect(s).toMatchObject({ holdCents: holdCents(terms), captureCents: 0, releaseCents: holdCents(terms) });
  });

  it("failed: nothing moves, and what is owed is recorded as due", () => {
    const s = settle(terms, { type: "lockout", assigned: ["marek"] }, "failed");
    expect(s).toMatchObject({ holdCents: 0, captureCents: 0, releaseCents: 0, coopCents: 0, members: {}, dueCents: priceCents(terms) });
  });
});

describe("the notice boundary", () => {
  it.each([
    [24 * 60 - 1, true],
    [24 * 60, true],
    [24 * 60 + 1, false],
  ])("%i minutes before: late is %s", (minutes, late) => {
    expect(isLate(terms, minutes)).toBe(late);
  });
});

describe("a split", () => {
  it("hands out nothing when there is nothing to hand out or nobody to pay", () => {
    expect(split(0, [["a", 1]])).toEqual({});
    expect(split(-5, [["a", 1]])).toEqual({});
    expect(split(100, [])).toEqual({});
    expect(split(100, [["a", 0]])).toEqual({});
  });

  it("leaves out a member with no share", () => {
    expect(
      split(100, [
        ["a", 1],
        ["b", 0],
      ]),
    ).toEqual({ a: 100 });
  });

  it("gives a tied odd cent to the earlier member, whatever the order of the ties", () => {
    expect(
      split(101, [
        ["a", 1],
        ["b", 1],
      ]),
    ).toEqual({ a: 51, b: 50 });
    expect(
      split(102, [
        ["a", 1],
        ["b", 1],
        ["c", 1],
        ["d", 1],
      ]),
    ).toEqual({ a: 26, b: 26, c: 25, d: 25 });
  });

  it("pays evenly when a checkout records no minutes for anyone", () => {
    const s = settle(terms, { type: "checkout", worked: { a: 0, b: 0 }, extraApproved: false }, "placed");
    expect(s.members).toEqual({ a: 6650, b: 6650 });
  });

  it("pays by minutes when only one of two members recorded any", () => {
    const s = settle(terms, { type: "checkout", worked: { a: 240, b: 0 }, extraApproved: false }, "placed");
    expect(s.members).toEqual({ a: 13300 });
  });
});
