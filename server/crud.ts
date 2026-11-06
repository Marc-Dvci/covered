// The week in Bryntum CrudManager load format, for the Scheduler board: members are resources with their
// availability as recurring calendars, visits are events coloured by money state, and the travel time to
// the member's next home that day is the event's postamble buffer. The agent's proposal travels the same
// way, as extra events that the board draws dashed. Dates are written without an offset so the board shows
// the cooperative's local time.
import { chipText } from "../shared/chip.ts";
import { clock, WEEK_DAYS, type Household, type Member } from "../shared/domain.ts";
import { holdCents, priceCents } from "../shared/rules/settle.ts";
import { WEEK_START_ISO } from "../shared/seed.ts";
import { travelMinutes } from "../shared/travel.ts";
import { holdText, type Absence } from "./actions.ts";
import type { Disruption } from "./dispatch/agent.ts";
import { readableReasons, solve, type Plan } from "./dispatch/solver.ts";
import type { VisitRow } from "./store.ts";

const GONE = new Set(["cancelled", "late_cancel", "voided"]);
const LOCKED = new Set(["in_progress", "settling", "captured", "paid_out", "done", ...GONE]);

/** The row for visits nobody can do yet. It appears only while there are some. */
export const NEEDS_COVER = "needs-cover";

export function localIso(t: number): string {
  const d = new Date(`${WEEK_START_ISO}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + t);
  return d.toISOString().slice(0, 19);
}

export const activeProposal = (disruptions: Pick<Disruption, "status" | "proposal">[]): Plan | null =>
  disruptions.find((d) => d.status === "proposed")?.proposal?.plan ?? null;

export interface CrudExtras {
  proposal?: Plan | null;
  /** The demo clock, drawn as the board's now line. */
  now?: number;
  absences?: Pick<Absence, "memberId" | "from" | "to">[];
}

export function toCrud(members: Member[], households: Household[], visits: VisitRow[], { proposal = null, now, absences = [] }: CrudExtras = {}) {
  const home = (v: VisitRow) => households.find((h) => h.id === v.householdId)!;
  const postamble = (v: VisitRow): number => {
    const m = v.memberIds[0];
    if (!m || GONE.has(v.state)) return 0;
    const end = v.start + v.minutes;
    const next = visits
      .filter(
        (x) => x.id !== v.id && x.memberIds.includes(m) && !GONE.has(x.state) && x.start >= end && Math.floor(x.start / 1440) === Math.floor(v.start / 1440),
      )
      .sort((a, b) => a.start - b.start)[0];
    return next ? travelMinutes(home(v).at, home(next).at) : 0;
  };
  const uncovered = visits.filter((v) => v.memberIds.length === 0 && !GONE.has(v.state));
  const event = (v: VisitRow) => {
    const h = home(v);
    return {
      id: v.id,
      name: h.name,
      startDate: localIso(v.start),
      endDate: localIso(v.start + v.minutes),
      manuallyScheduled: true,
      // the bar shows the booked time; whether the member can work it is the guard's question
      ignoreResourceCalendar: true,
      postamble: `${postamble(v)} minutes`,
      cls: `s-${v.state}`,
      state: v.state,
      payment: holdText(v),
      chip: chipText({ ...v, priceCents: priceCents(v.terms) }),
      priceCents: priceCents(v.terms),
      holdCents: holdCents(v.terms),
      area: h.area,
      needs: h.needs,
      sameCleaner: h.sameCleaner,
      pendingMember: v.pendingMember,
      // the hold has already paid out or been released, so the visit can no longer move
      draggable: !LOCKED.has(v.state),
      resizable: false,
      kind: "visit",
    };
  };
  // dashed bars: what the agent proposes, and a cover waiting for the household's answer
  const ghosts = [
    ...(proposal?.assignments ?? []).filter((a) => a.memberId).map((a) => ({ visitId: a.visitId, memberId: a.memberId!, asked: a.consent })),
    ...visits.filter((v) => v.pendingMember).map((v) => ({ visitId: v.id, memberId: v.pendingMember!, asked: true })),
  ].flatMap((g) => {
    const v = visits.find((x) => x.id === g.visitId);
    return v ? [{ ...g, v }] : [];
  });

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
      rows: [
        ...(uncovered.length ? [{ id: NEEDS_COVER, name: "Needs cover", languages: [] as string[], skills: [] as string[], weeklyHoursCap: 0, area: "" }] : []),
        ...members.map((m) => ({
          id: m.id,
          name: m.name,
          calendar: `cal-${m.id}`,
          languages: m.languages as string[],
          skills: m.skills as string[],
          weeklyHoursCap: m.weeklyHoursCap,
          area: m.area,
        })),
      ],
    },
    events: {
      rows: [
        ...visits.map(event),
        ...ghosts.map(({ v, memberId, asked }) => ({
          ...event(v),
          id: ghostId(v.id, memberId),
          postamble: "0 minutes",
          cls: "proposed",
          draggable: false,
          kind: "proposed",
          visitId: v.id,
          asked,
        })),
      ],
    },
    assignments: {
      rows: [
        ...visits.flatMap((v) =>
          (v.memberIds.length ? v.memberIds : uncovered.includes(v) ? [NEEDS_COVER] : []).map((m) => ({ id: `${v.id}:${m}`, event: v.id, resource: m })),
        ),
        ...ghosts.map(({ v, memberId }) => ({ id: `${ghostId(v.id, memberId)}:${memberId}`, event: ghostId(v.id, memberId), resource: memberId })),
      ],
    },
    resourceTimeRanges: {
      rows: absences.map((a, i) => ({
        id: `out-${i}-${a.memberId}`,
        resourceId: a.memberId,
        startDate: localIso(a.from),
        endDate: localIso(a.to),
        name: "Out today",
        cls: "out-of-office",
      })),
    },
    timeRanges: {
      rows: now === undefined ? [] : [{ id: "now", name: `now ${clock(now)}`, startDate: localIso(now), cls: "now-line" }],
    },
  };
}

export const ghostId = (visitId: string, memberId: string) => `proposed-${visitId}-${memberId}`;

export interface Guard {
  ok: boolean;
  reasons: string[];
  consent: boolean;
}

/**
 * The drag guard's answers for one day, ahead of the drag: for each visit that can still move, every member's
 * verdict from the same solver the agent uses. The board reads them while the bar is in the air; the
 * server checks again on the drop.
 */
export function guards(
  members: Member[],
  households: Household[],
  visits: VisitRow[],
  absences: Absence[],
  day: number,
): Record<string, Record<string, Guard>> {
  const out: Record<string, Record<string, Guard>> = {};
  for (const v of visits) {
    if (Math.floor(v.start / 1440) !== day || LOCKED.has(v.state)) continue;
    const others = visits.map((x) => (x.id === v.id ? { ...x, memberIds: [] } : x));
    const { candidates } = solve({ members, households, visits: others, absences, affected: [v.id], maxPlans: 1 });
    out[v.id] = Object.fromEntries(
      (candidates[v.id] ?? []).map((c) => [c.memberId, { ok: c.ok, reasons: readableReasons(c.reasons, visits, households), consent: c.consent }]),
    );
  }
  return out;
}
