import { beforeEach, describe, expect, it } from "vitest";
import { activeAbsences, canMove } from "../server/actions.ts";
import { config, makeApp, type App } from "../server/context.ts";
import { activeProposal, guards, NEEDS_COVER, toCrud } from "../server/crud.ts";
import { openDisruption, type Proposal } from "../server/dispatch/agent.ts";
import type { Plan } from "../server/dispatch/solver.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";
import type { VisitRow } from "../server/store.ts";
import { hm, households, members, seedVisits, STORY } from "../shared/seed.ts";
import type { VisitState } from "../shared/domain.ts";

const THU = 3 * 1440;

const rows = (): VisitRow[] =>
  seedVisits().map(
    (v) =>
      ({
        ...v,
        hold: null,
        capture: null,
        void: null,
        payout: null,
        outcome: null,
        settlement: null,
        checkinAt: null,
        checkoutAt: null,
        pendingMember: null,
      }) as VisitRow,
  );

const assign = (visitId: string, memberId: string | null, consent = false): Plan["assignments"][number] => ({
  visitId,
  memberId,
  consent,
  language: true,
  familiar: false,
  travelIn: 0,
});

const planOf = (assignments: Plan["assignments"]): Plan => ({
  rank: 1,
  assignments,
  covered: assignments.filter((a) => a.memberId).length,
  consent: 0,
  language: 0,
  familiar: 0,
  addedTravel: 0,
});

describe("proposals and pending covers on the board", () => {
  it("a proposal adds a dashed event for each member it assigns, which cannot be dragged", () => {
    const crud = toCrud(members, households, rows(), {
      proposal: planOf([assign("v-thu-weber", "marek"), assign("v-thu-okafor", "marek", true), assign("v-thu-santos", null)]),
    });
    expect(crud.events.rows.find((e) => e.id === "proposed-v-thu-weber-marek")).toMatchObject({
      kind: "proposed",
      cls: "proposed",
      draggable: false,
      visitId: "v-thu-weber",
      asked: false,
      postamble: "0 minutes",
    });
    expect(crud.assignments.rows).toContainEqual({ id: "proposed-v-thu-weber-marek:marek", event: "proposed-v-thu-weber-marek", resource: "marek" });
    expect(crud.events.rows.find((e) => e.id === "proposed-v-thu-okafor-marek")).toMatchObject({ asked: true });
    expect(crud.events.rows.some((e) => e.id.startsWith("proposed-v-thu-santos"))).toBe(false);
  });

  it("a visit waiting for its household's answer shows a dashed event for the member asked", () => {
    const visits = rows();
    visits.find((v) => v.id === "v-thu-okafor")!.pendingMember = "marek";
    const crud = toCrud(members, households, visits);
    expect(crud.events.rows.find((e) => e.id === "proposed-v-thu-okafor-marek")).toMatchObject({ asked: true, draggable: false });
    expect(crud.events.rows.find((e) => e.id === "v-thu-okafor")).toMatchObject({ pendingMember: "marek", draggable: true });
  });

  it("a visit with no member goes on the needs-cover row", () => {
    const visits = rows();
    visits.find((v) => v.id === "v-thu-weber")!.memberIds = [];
    const crud = toCrud(members, households, visits);
    expect(crud.resources.rows.find((r) => r.id === NEEDS_COVER)).toMatchObject({ name: "Needs cover" });
    expect(crud.assignments.rows).toContainEqual({ id: "v-thu-weber:needs-cover", event: "v-thu-weber", resource: NEEDS_COVER });
  });

  it.each<[string, (visits: VisitRow[]) => void]>([
    ["every visit has a member", () => {}],
    [
      "the only visit with no member is cancelled",
      (visits) => {
        const v = visits.find((x) => x.id === "v-thu-weber")!;
        v.memberIds = [];
        v.state = "cancelled";
      },
    ],
  ])("the needs-cover row is left out when %s", (_label, change) => {
    const visits = rows();
    change(visits);
    const crud = toCrud(members, households, visits);
    expect(crud.resources.rows.some((r) => r.id === NEEDS_COVER)).toBe(false);
    expect(crud.assignments.rows.some((a) => a.resource === NEEDS_COVER)).toBe(false);
  });

  it("an absence becomes a resource time range for that member", () => {
    const crud = toCrud(members, households, rows(), { absences: [{ memberId: "sam", from: THU + hm("09:00"), to: 5760 }] });
    expect(crud.resourceTimeRanges.rows).toEqual([
      {
        id: "out-0-sam",
        resourceId: "sam",
        startDate: "2026-11-19T09:00:00",
        endDate: "2026-11-20T00:00:00",
        name: "Out today",
        cls: "out-of-office",
      },
    ]);
  });

  it("the demo clock becomes one now line, and there is none without a clock", () => {
    const crud = toCrud(members, households, rows(), { now: THU + hm("07:10") });
    expect(crud.timeRanges.rows).toEqual([{ id: "now", name: "now 07:10", startDate: "2026-11-19T07:10:00", cls: "now-line" }]);
    expect(toCrud(members, households, rows()).timeRanges.rows).toEqual([]);
  });

  it.each<VisitState>(["in_progress", "settling", "captured", "paid_out", "done", "cancelled", "late_cancel", "voided"])(
    "a visit that is %s cannot be dragged",
    (state) => {
      const visits = rows();
      visits.find((v) => v.id === "v-thu-weber")!.state = state;
      const crud = toCrud(members, households, visits);
      expect(crud.events.rows.find((e) => e.id === "v-thu-weber")).toMatchObject({ state, draggable: false });
    },
  );

  it.each<VisitState>(["scheduled", "holding", "held", "at_risk"])("a visit that is %s can be dragged", (state) => {
    const visits = rows();
    visits.find((v) => v.id === "v-thu-weber")!.state = state;
    const crud = toCrud(members, households, visits);
    expect(crud.events.rows.find((e) => e.id === "v-thu-weber")).toMatchObject({ draggable: true });
  });

  it("the active proposal is the plan of the one disruption still proposed", () => {
    const plan = planOf([assign("v-thu-weber", "marek")]);
    const with_ = (status: "open" | "proposed" | "approved" | "dismissed") => ({ status, proposal: { plan } as Proposal });
    expect(activeProposal([{ status: "open", proposal: null }, with_("proposed")])).toBe(plan);
    expect(activeProposal([with_("approved"), with_("dismissed")])).toBeNull();
    expect(activeProposal([])).toBeNull();
  });
});

describe("the drag guard for one day", () => {
  let app: App;

  beforeEach(async () => {
    const pp = new FakePayPal();
    pp.payoutDelayMs = 0;
    app = await makeApp({ ...config({}), dbFile: null }, pp);
    app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
    await app.store.reset();
  });

  it.each([3, 4])("day %i lists only that day's visits that can still move", async (day) => {
    await app.store.updateVisit("v-thu-osei", { state: "settling" });
    const visits = await app.store.visits();
    const g = guards(await app.store.members(), await app.store.households(), visits, await activeAbsences(app.store), day);
    const expected = visits
      .filter((v) => Math.floor(v.start / 1440) === day && v.state === "scheduled")
      .map((v) => v.id)
      .sort();
    expect(Object.keys(g).sort()).toEqual(expected);
  });

  it("each member's verdict is the one canMove gives for the same visit, with Sam out", async () => {
    await openDisruption(app.store, null, "sam", STORY.message);
    const g = guards(await app.store.members(), await app.store.households(), await app.store.visits(), await activeAbsences(app.store), 3);
    const ctx = { store: app.store, runner: app.runner };
    for (const [visitId, verdicts] of Object.entries(g)) {
      for (const m of members) {
        const { ok, reasons, consent } = await canMove(ctx, visitId, m.id);
        expect(verdicts[m.id], `${visitId} for ${m.id}`).toEqual({ ok, reasons, consent });
      }
    }
    expect(Object.values(g).some((byMember) => Object.values(byMember).some((x) => x.reasons.includes("is out")))).toBe(true);
  });
});
