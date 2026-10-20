import fc from "fast-check";
import { describe, expect, it } from "vitest";
import table from "../shared/rules/cases.json" with { type: "json" };
import { DEFAULT_TERMS, type Terms } from "../shared/domain.ts";
import { holdCents, settle, split, type Outcome } from "../shared/rules/settle.ts";

describe("pay-rule table", () => {
  for (const c of table.cases) {
    it(`${c.id}. ${c.title}`, () => {
      const terms: Terms = { ...DEFAULT_TERMS, ...table.defaults, ...(c as { terms?: Partial<Terms> }).terms };
      const { originallyAssigned: _, ...event } = c.event as Record<string, unknown>;
      const s = settle(terms, event as Outcome, (c as { hold?: "failed" }).hold ?? "auto");
      const { reason: __, ...got } = s;
      expect(got).toEqual(c.expect);
    });
  }
});

const terms = fc.record({
  rateCentsPerHour: fc.integer({ min: 2130, max: 9000 }),
  bookedMinutes: fc.integer({ min: 60, max: 600 }),
  noticeHours: fc.integer({ min: 1, max: 72 }),
  lateCancelPct: fc.integer({ min: 0, max: 100 }),
  lockoutPct: fc.integer({ min: 0, max: 100 }),
  extraAllowanceMinutes: fc.integer({ min: 0, max: 120 }),
  extraStepMinutes: fc.constantFrom(5, 10, 15, 30),
  coopShareBps: fc.integer({ min: 0, max: 2000 }),
  holdLeadMinutes: fc.integer({ min: 0, max: 60 }),
});
const ids = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 4 });
const outcome: fc.Arbitrary<Outcome> = fc.oneof(
  ids.chain((ks) => fc.record({
    type: fc.constant("checkout" as const),
    worked: fc.tuple(...ks.map(() => fc.integer({ min: 0, max: 400 }))).map((ws) => Object.fromEntries(ks.map((k, i) => [k, ws[i]!]))),
    extraApproved: fc.boolean(),
  })),
  fc.record({ type: fc.constant("cancel" as const), by: fc.constantFrom("household" as const, "cooperative" as const), minutesBefore: fc.integer({ min: 0, max: 10_000 }), assigned: ids }),
  fc.record({ type: fc.constant("lockout" as const), assigned: ids }),
  fc.constant({ type: "member_absent" as const }),
);

describe("money is conserved", () => {
  it("capture + release = hold; coop + members = capture; nothing negative; capture never above the hold", () => {
    fc.assert(fc.property(terms, outcome, fc.constantFrom("auto", "placed", "failed") as fc.Arbitrary<"auto" | "placed" | "failed">, (t, o, h) => {
      const s = settle(t, o, h);
      const members = Object.values(s.members);
      expect(s.captureCents + s.releaseCents).toBe(s.holdCents);
      expect(s.coopCents + members.reduce((a, b) => a + b, 0)).toBe(s.captureCents);
      expect(s.captureCents).toBeLessThanOrEqual(holdCents(t));
      for (const x of [s.holdCents, s.captureCents, s.releaseCents, s.coopCents, s.dueCents, ...members]) expect(x).toBeGreaterThanOrEqual(0);
      if (h === "failed") expect(s.captureCents).toBe(0);
    }), { numRuns: 5000 });
  });

  it("the same input always gives the same split", () => {
    fc.assert(fc.property(terms, outcome, (t, o) => {
      expect(settle(t, o)).toEqual(settle(structuredClone(t), structuredClone(o)));
    }), { numRuns: 1000 });
  });

  it("a split hands out exactly the amount, and no part differs from its fair share by a cent or more", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 6 }), (cents, ws) => {
      const weights = ws.map((w, i) => [`m${i}`, w] as [string, number]);
      const out = split(cents, weights);
      expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(cents);
      const total = ws.reduce((a, b) => a + b, 0);
      for (const [k, w] of weights) expect(Math.abs((out[k] ?? 0) - (cents * w) / total)).toBeLessThan(1);
    }), { numRuns: 3000 });
  });
});
