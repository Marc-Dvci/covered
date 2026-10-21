import { describe, expect, it } from "vitest";
import { localIso, toCrud } from "../server/crud.ts";
import type { VisitRow } from "../server/store.ts";
import { households, members, seedVisits } from "../shared/seed.ts";
import { travelMinutes } from "../shared/travel.ts";

const visits = seedVisits().map((v) => ({ ...v, hold: null, capture: null, void: null, payout: null, outcome: null, settlement: null, checkinAt: null, checkoutAt: null, pendingMember: null }) as VisitRow);
const crud = toCrud(members, households, visits);

describe("board data in CrudManager format", () => {
  it("writes local times from the week start", () => {
    expect(localIso(0)).toBe("2026-11-16T00:00:00");
    expect(localIso(3 * 1440 + 9 * 60 + 30)).toBe("2026-11-19T09:30:00");
  });

  it("has one resource and one calendar per member, and an assignment per visit member", () => {
    expect(crud.resources.rows.map((r) => r.id)).toEqual(members.map((m) => m.id));
    expect(crud.calendars.rows).toHaveLength(members.length);
    expect(crud.assignments.rows).toHaveLength(visits.reduce((a, v) => a + v.memberIds.length, 0));
    const ids = new Set(crud.events.rows.map((e) => e.id));
    for (const a of crud.assignments.rows) expect(ids.has(a.event)).toBe(true);
  });

  it("turns availability windows into recurring working intervals", () => {
    const m = members[0]!;
    const cal = crud.calendars.rows.find((c) => c.id === `cal-${m.id}`)!;
    expect(cal.intervals).toHaveLength(m.availability.length);
    expect(cal.intervals[0]!.recurrentStartDate).toMatch(/^on (Mon|Tue|Wed|Thu|Fri|Sat|Sun) at \d\d:\d\d$/);
  });

  it("buffers each visit with the travel time to the member's next home that day", () => {
    const at = (id: string) => households.find((h) => h.id === id)!.at;
    let checked = 0;
    for (const v of visits) {
      const m = v.memberIds[0];
      const next = visits.filter((x) => x.memberIds.includes(m!) && x.start >= v.start + v.minutes && Math.floor(x.start / 1440) === Math.floor(v.start / 1440)).sort((a, b) => a.start - b.start)[0];
      const e = crud.events.rows.find((x) => x.id === v.id)!;
      expect(e.postamble).toBe(`${next ? travelMinutes(at(v.householdId), at(next.householdId)) : 0} minutes`);
      if (next) checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});
