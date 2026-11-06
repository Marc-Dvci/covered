import { describe, expect, it } from "vitest";
import { blank, missing, SEATTLE_MIN_RATE_CENTS, type Agreement } from "../shared/agreement.ts";
import { chipText, type ChipVisit } from "../shared/chip.ts";
import { clock, dayOf, dollars, when, type VisitState } from "../shared/domain.ts";
import { nextStep, type GuideState, type Step } from "../shared/guide.ts";
import { hm, households } from "../shared/seed.ts";
import { km, travelMinutes } from "../shared/travel.ts";

const THU = 3 * 1440;
const at = (hhmm: string) => THU + hm(hhmm);

interface StoryInput {
  now?: number;
  sam?: string;
  samAffected?: string[];
  okafor?: Partial<GuideState["visits"][number]>;
  lindqvist?: Partial<GuideState["visits"][number]>;
}

function story(o: StoryInput): GuideState {
  return {
    now: o.now ?? at("07:10"),
    disruptions: o.sam ? [{ memberId: "sam", status: o.sam, affected: o.samAffected ?? ["v-thu-okafor"] }] : [],
    visits: [
      { id: "v-thu-okafor", state: "scheduled", pendingMember: null, ...o.okafor },
      { id: "v-thu-lindqvist", state: "scheduled", pendingMember: null, ...o.lindqvist },
    ],
  };
}

describe("the next step in Thursday's story", () => {
  it.each<[string, StoryInput, { n: number; clockTo?: number; link?: { to: string } }]>([
    ["the message is not sent yet", {}, { n: 1 }],
    ["a message that moves no visit is not Sam's message", { sam: "open", samAffected: [] }, { n: 1 }],
    ["Sam's message is open for the agent", { sam: "open" }, { n: 2 }],
    ["the agent's plan is waiting for approval", { sam: "proposed" }, { n: 3 }],
    ["the Okafors are asked about the same cleaner", { sam: "approved", okafor: { pendingMember: "marek" } }, { n: 4, link: { to: "/h/okafor" } }],
    ["Marek is on his way, before 09:00", { sam: "approved", okafor: { state: "held" }, now: at("07:10") }, { n: 5, clockTo: at("09:00"), link: { to: "/m/marek" } }],
    ["Marek is at the door, from 09:00", { sam: "approved", okafor: { state: "held" }, now: at("09:00") }, { n: 5, link: { to: "/m/marek" } }],
    ["Marek is working, before 13:05", { sam: "approved", okafor: { state: "in_progress" }, now: at("10:00") }, { n: 5, clockTo: at("13:05"), link: { to: "/m/marek" } }],
    ["Marek is done, from 13:05", { sam: "approved", okafor: { state: "in_progress" }, now: at("13:05") }, { n: 5, link: { to: "/m/marek" } }],
    ["the Okafor visit is capturing on PayPal", { sam: "approved", okafor: { state: "settling" } }, { n: 5 }],
    ["Mr. Lindqvist's cancellation comes before 13:30", { sam: "approved", okafor: { state: "paid_out" }, lindqvist: { state: "scheduled" }, now: at("13:00") }, { n: 6, clockTo: at("13:30"), link: { to: "/h/lindqvist" } }],
    ["Mr. Lindqvist cancels from 13:30", { sam: "approved", okafor: { state: "paid_out" }, lindqvist: { state: "held" }, now: at("13:30") }, { n: 6, link: { to: "/h/lindqvist" } }],
    ["the Lindqvist cancellation is capturing", { sam: "approved", okafor: { state: "paid_out" }, lindqvist: { state: "settling" } }, { n: 6 }],
    ["the story is over: the statement", { sam: "approved", okafor: { state: "paid_out" }, lindqvist: { state: "late_cancel" } }, { n: 7, link: { to: "/m/marek/statement" } }],
  ])("%s", (_label, input, expected) => {
    const step = nextStep(story(input));
    expect(step).toMatchObject(expected);
    if (expected.clockTo === undefined) expect(step?.clockTo).toBeUndefined();
    if (expected.link === undefined) expect(step?.link).toBeUndefined();
  });

  it.each([
    ["the Okafor visit is missing", { visits: [{ id: "v-thu-lindqvist", state: "scheduled", pendingMember: null }] }],
    ["the Lindqvist visit is missing", { visits: [{ id: "v-thu-okafor", state: "scheduled", pendingMember: null }] }],
    ["both visits are missing", { visits: [] }],
  ])("there is no step when %s", (_label, change) => {
    expect(nextStep({ ...story({}), ...change })).toBeNull();
  });
});

describe("the chip on a visit's bar", () => {
  const hold = { cents: 12250, placedAt: THU + hm("09:00") };
  const base = (state: VisitState, extra: Partial<ChipVisit> = {}): ChipVisit => ({ state, priceCents: 10500, hold: null, capture: null, payout: null, ...extra });

  it.each<[string, ChipVisit, string]>([
    ["done", base("done"), "before the demo week"],
    ["scheduled", base("scheduled"), "$105.00, held 24 h before"],
    ["holding", base("holding"), "placing hold"],
    ["held", base("held", { hold }), "$122.50 held since Thu 09:00"],
    ["at_risk", base("at_risk"), "hold refused"],
    ["in_progress with a hold", base("in_progress", { hold }), "$122.50 held, in progress"],
    ["in_progress without a hold", base("in_progress"), "in progress"],
    ["settling", base("settling", { hold }), "$122.50 held since Thu 09:00"],
    ["captured", base("captured", { capture: { cents: 10500 } }), "captured $105.00"],
    ["paid_out", base("paid_out", { payout: { items: [{ cents: 9975 }] } }), "paid $99.75"],
    ["late_cancel", base("late_cancel", { capture: { cents: 5250 } }), "fee $52.50"],
    ["cancelled", base("cancelled"), "cancelled"],
    ["voided", base("voided"), "hold released"],
  ])("a visit that is %s shows its money in words", (_label, visit, text) => {
    expect(chipText(visit)).toBe(text);
  });
});

describe("the display helpers", () => {
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [12250, "$122.50"],
    [-1234, "-$12.34"],
    [123456789, "$1,234,567.89"],
  ])("dollars(%i) is %s", (cents, text) => {
    expect(dollars(cents)).toBe(text);
  });

  it.each([
    [0, "00:00"],
    [605, "10:05"],
    [1440 + 5, "00:05"],
    [-60, "23:00"],
  ])("clock(%i) is %s", (minutes, text) => {
    expect(clock(minutes)).toBe(text);
  });

  it.each([
    [0, 0],
    [1439, 0],
    [1440, 1],
    [THU, 3],
  ])("dayOf(%i) is %i", (minutes, day) => {
    expect(dayOf(minutes)).toBe(day);
  });

  it("when names the day and the clock time of a point in the week", () => {
    expect(when(0)).toBe("Mon 00:00");
    expect(when(at("09:00"))).toBe("Thu 09:00");
  });
});

describe("travel between homes", () => {
  const pairs: [number, number][] = [[0, 1], [3, 9], [12, 20], [25, 4]];

  it.each(pairs)("the trip from home %i to home %i takes as long as the way back", (a, b) => {
    const pa = households[a]!.at;
    const pb = households[b]!.at;
    expect(travelMinutes(pa, pb)).toBe(travelMinutes(pb, pa));
    expect(km(pa, pb)).toBeCloseTo(km(pb, pa), 9);
  });

  it("takes no time between two points at the same address", () => {
    for (const h of households) expect(travelMinutes(h.at, h.at)).toBe(0);
  });

  it.each(pairs)("a trip from home %i to home %i is rounded to five minutes and is at least ten", (a, b) => {
    const t = travelMinutes(households[a]!.at, households[b]!.at);
    expect(t % 5).toBe(0);
    expect(t).toBeGreaterThanOrEqual(10);
  });
});

describe("the agreement checklist", () => {
  const complete = (): Agreement => ({
    ...blank("The Test Family", "en"),
    area: "Ballard",
    scope: ["Kitchen"],
    location: "12 Pine Street",
    schedule: { weekday: 4, start: "10:00", minutes: 180, frequency: "weekly" },
    rateCentsPerHour: 2500,
  });

  it("a complete agreement is missing nothing", () => {
    expect(missing(complete())).toEqual([]);
  });

  it("a blank agreement is missing the scope, the location and the schedule", () => {
    expect(missing(blank("The Test Family", "en"))).toEqual(["scope", "location", "schedule"]);
  });

  it.each<[string, (a: Agreement) => void, string[]]>([
    ["scope", (a) => { a.scope = []; }, ["scope"]],
    ["scope made of blank lines", (a) => { a.scope = ["  "]; }, ["scope"]],
    ["location", (a) => { a.location = " "; }, ["location"]],
    ["day of the week", (a) => { a.schedule.weekday = null; }, ["schedule"]],
    ["start time", (a) => { a.schedule.start = null; }, ["schedule"]],
    ["visit shorter than an hour", (a) => { a.schedule.minutes = 59; }, ["schedule"]],
    ["visit longer than ten hours", (a) => { a.schedule.minutes = 601; }, ["schedule"]],
    ["frequency", (a) => { a.schedule.frequency = null; }, ["schedule"]],
    ["rate", (a) => { a.rateCentsPerHour = null; }, ["rate"]],
    ["rate of zero", (a) => { a.rateCentsPerHour = 0; }, ["rate"]],
    ["payment schedule", (a) => { a.paymentSchedule = ""; }, ["payment_schedule"]],
    ["notice for cancellation", (a) => { a.cancellation.noticeHours = null; }, ["cancellation"]],
    ["late fee above 100%", (a) => { a.cancellation.lateCancelPct = 101; }, ["cancellation"]],
    ["lock-out fee below 0%", (a) => { a.cancellation.lockoutPct = -1; }, ["cancellation"]],
    ["expenses", (a) => { a.expenses = null; }, ["expenses"]],
    ["classification", (a) => { a.classification = " "; }, ["classification"]],
    ["benefits", (a) => { a.benefits = null; }, ["benefits"]],
    ["leave", (a) => { a.leave = ""; }, ["leave"]],
  ])("a missing %s is reported", (_label, change, expected) => {
    const a = complete();
    change(a);
    expect(missing(a)).toEqual(expected);
  });

  it("the Seattle minimum is 21.30 an hour", () => {
    expect(SEATTLE_MIN_RATE_CENTS).toBe(2130);
  });

  it.each([
    [2129, ["rate_floor"]],
    [2130, []],
    [2131, []],
  ])("a rate of %i cents an hour is below the floor only when it is under 2130", (rate, expected) => {
    const a = complete();
    a.rateCentsPerHour = rate;
    expect(missing(a)).toEqual(expected);
  });
});
