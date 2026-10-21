// The week in Bryntum CrudManager load format, for the Scheduler Pro board: members are resources with
// their availability as recurring calendars, visits are events coloured by money state, and the
// travel time to the member's next home that day is the event's postamble buffer. Dates are written
// without an offset so the board shows the cooperative's local time.
import { clock, WEEK_DAYS, type Household, type Member } from "../shared/domain.ts";
import { holdCents, priceCents } from "../shared/rules/settle.ts";
import { WEEK_START_ISO } from "../shared/seed.ts";
import { travelMinutes } from "../shared/travel.ts";
import { holdText } from "./actions.ts";
import type { VisitRow } from "./store.ts";

const GONE = new Set(["cancelled", "late_cancel", "voided"]);

export function localIso(t: number): string {
  const d = new Date(`${WEEK_START_ISO}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + t);
  return d.toISOString().slice(0, 19);
}

export function toCrud(members: Member[], households: Household[], visits: VisitRow[]) {
  const home = (v: VisitRow) => households.find((h) => h.id === v.householdId)!;
  const postamble = (v: VisitRow): number => {
    const m = v.memberIds[0];
    if (!m || GONE.has(v.state)) return 0;
    const end = v.start + v.minutes;
    const next = visits
      .filter((x) => x.id !== v.id && x.memberIds.includes(m) && !GONE.has(x.state) && x.start >= end && Math.floor(x.start / 1440) === Math.floor(v.start / 1440))
      .sort((a, b) => a.start - b.start)[0];
    return next ? travelMinutes(home(v).at, home(next).at) : 0;
  };

  return {
    success: true,
    calendars: {
      rows: members.map((m) => ({
        id: `cal-${m.id}`,
        name: `${m.name} availability`,
        unspecifiedTimeIsWorking: false,
        intervals: m.availability.map((w) => ({
          recurrentStartDate: `on ${WEEK_DAYS[w.day]} at ${clock(w.from)}`,
          recurrentEndDate: `on ${WEEK_DAYS[w.day]} at ${clock(w.to)}`,
          isWorking: true,
        })),
      })),
    },
    resources: {
      rows: members.map((m) => ({ id: m.id, name: m.name, calendar: `cal-${m.id}`, languages: m.languages, skills: m.skills, weeklyHoursCap: m.weeklyHoursCap, area: m.area })),
    },
    events: {
      rows: visits.map((v) => {
        const h = home(v);
        return {
          id: v.id,
          name: h.name,
          startDate: localIso(v.start),
          endDate: localIso(v.start + v.minutes),
          manuallyScheduled: true,
          postamble: `${postamble(v)} minutes`,
          cls: `s-${v.state}`,
          state: v.state,
          payment: holdText(v),
          priceCents: priceCents(v.terms),
          holdCents: holdCents(v.terms),
          area: h.area,
          needs: h.needs,
          sameCleaner: h.sameCleaner,
          pendingMember: v.pendingMember,
          // money states that must not be dragged: the hold already paid or released
          draggable: !["in_progress", "settling", "captured", "paid_out", ...GONE].includes(v.state),
          resizable: false,
        };
      }),
    },
    assignments: {
      rows: visits.flatMap((v) => v.memberIds.map((m) => ({ id: `${v.id}:${m}`, event: v.id, resource: m }))),
    },
  };
}
