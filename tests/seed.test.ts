import { describe, expect, it } from "vitest";
import { households, members, seedVisits } from "../shared/seed.ts";
import { violations } from "../eval/oracle.ts";

describe("seed week", () => {
  it("breaks no constraint", () => {
    expect(violations({ members, households }, seedVisits(), [])).toEqual([]);
  });
  it("has unique visit ids and known households", () => {
    const v = seedVisits();
    expect(new Set(v.map((x) => x.id)).size).toBe(v.length);
    for (const x of v) expect(households.some((h) => h.id === x.householdId)).toBe(true);
  });
});
