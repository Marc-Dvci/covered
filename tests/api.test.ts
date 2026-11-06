import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { routes } from "../server/api.ts";
import { activeAbsences } from "../server/actions.ts";
import { Gemini } from "../server/ai/gemini.ts";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { activeProposal, toCrud } from "../server/crud.ts";
import { listDisruptions } from "../server/dispatch/agent.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";
import { hm, households, members, seedVisits, STORY } from "../shared/seed.ts";

const THU = 3 * 1440;
const at = (hhmm: string) => THU + hm(hhmm);
const thursdayVisits = seedVisits().filter((v) => Math.floor(v.start / 1440) === 3);

interface Board {
  weekStart: string;
  timeZone: string;
  now: number;
  members: { id: string; bookedMinutes: number }[];
  households: Record<string, unknown>[];
  visits: { id: string; payment: string }[];
  disruptions: unknown[];
  events: { type: string }[];
  crud: unknown;
}

let app: App;
let pp: FakePayPal;

beforeEach(async () => {
  pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dbFile: null, webhookId: "WH-ID" }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
  await app.store.reset();
});

const server = () => {
  const s = new Hono();
  routes(s, app, new Gemini({ ...app.cfg, geminiKey: undefined }, app.store));
  return s;
};

const send = (path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) =>
  server().request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

const read = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const holdAll = async () => {
  await sweep(app);
  await app.runner.idle();
};

const webhookDelivery = async () => ({
  id: "WH-1",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP-1", invoice_id: `covered-${await app.store.payRef("v-thu-weber")}` },
});

const draftComplete = async (): Promise<string> => {
  const d = await read<{ id: string }>(await send("/api/agreements/draft", "POST", {
    householdName: "The Test Family", area: "Ballard", language: "en", jobText: "Kitchen and bathrooms", memberLanguage: "en",
  }));
  const r = await send(`/api/agreements/${d.id}/update`, "POST", {
    scope: ["Kitchen", "Bathrooms"], location: "12 Pine Street", schedule: { weekday: 4, start: "10:00", minutes: 180, frequency: "weekly" }, rateCentsPerHour: 2500,
  });
  expect(await read<{ missing: unknown[] }>(r)).toMatchObject({ missing: [] });
  return d.id;
};

describe("health and the board", () => {
  it("reports the stand-in PayPal, the recorded model and the demo flag", async () => {
    const r = await send("/api/health", "GET");
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ ok: true, paypal: "stand-in", currency: "USD", runner: "local", ai: "recorded", demo: true });
  });

  it("returns the week, with the board data built from the store", async () => {
    const r = await send("/api/board", "GET");
    expect(r.status).toBe(200);
    const body = await read<Board>(r);
    expect(body).toMatchObject({ weekStart: "2026-11-16", timeZone: "America/Los_Angeles", now: at("07:10") });
    expect(body.members).toHaveLength(members.length);
    expect(body.households).toHaveLength(households.length);
    expect(body.visits).toHaveLength(seedVisits().length);
    expect(body.households[0]).not.toHaveProperty("vaultId");
    expect(body.households[0]).toHaveProperty("paypalSaved", true);
    const lena = body.members.find((m) => m.id === "lena");
    expect(lena?.bookedMinutes).toBe(seedVisits().filter((v) => v.memberIds.includes("lena")).reduce((a, v) => a + v.minutes, 0));
    expect(body.visits.find((v) => v.id === "v-thu-weber")?.payment).toBe("not held yet");
    expect(body.crud).toEqual(toCrud(
      await app.store.members(),
      await app.store.households(),
      await app.store.visits(),
      { proposal: activeProposal((await listDisruptions(app.store)).slice(0, 5)), now: await app.store.now(), absences: await activeAbsences(app.store) },
    ));
  });

  it("returns the drag guard's verdicts for one day", async () => {
    const r = await send("/api/board/guards?day=3", "GET");
    expect(r.status).toBe(200);
    const body = await read<Record<string, Record<string, { ok: boolean; reasons: string[] }>>>(r);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["v-thu-okafor", "v-thu-weber"]));
    expect(Object.keys(body).every((id) => thursdayVisits.some((v) => v.id === id))).toBe(true);
    expect(body["v-thu-weber"]?.joy?.ok).toBe(false);
    expect(body["v-thu-weber"]?.joy?.reasons).toContain("does not work that day");
    expect(body["v-thu-weber"]?.lena?.ok).toBe(true);
  });
});

describe("demo clock", () => {
  it("moves forward and starts the holds that fall due, not for visits already started", async () => {
    const r = await send("/api/clock", "POST", { at: at("09:30") });
    expect(r.status).toBe(200);
    const body = await read<{ now: number; holdsStarted: string[] }>(r);
    expect(body.now).toBe(at("09:30"));
    expect(body.holdsStarted).toContain("v-thu-santos");
    expect(body.holdsStarted).not.toContain("v-thu-okafor");
    await app.runner.idle();
    expect((await app.store.visit("v-thu-santos"))!.state).toBe("held");
  });

  it("refuses to move backward", async () => {
    await app.store.setClock(at("09:00"));
    const r = await send("/api/clock", "POST", { at: at("08:00") });
    expect(r.status).toBe(409);
    expect(await read(r)).toMatchObject({ error: expect.stringContaining("only moves forward") });
    expect(await app.store.now()).toBe(at("09:00"));
  });

  it.each([
    ["past the last minute of the week", { at: 7 * 1440 }],
    ["a negative minute", { at: -1 }],
    ["a fraction of a minute", { at: 10.5 }],
    ["no minute at all", {}],
  ])("refuses a clock value %s with 400", async (_label, body) => {
    const r = await send("/api/clock", "POST", body);
    expect(r.status).toBe(400);
  });

  it("is refused with 403 when the server is not in demo mode", async () => {
    app.cfg.demo = false;
    const r = await send("/api/clock", "POST", { at: at("08:00") });
    expect(r.status).toBe(403);
    expect(await read(r)).toEqual({ error: "demo only" });
    expect(await app.store.now()).toBe(at("07:10"));
  });
});

describe("demo reset", () => {
  it("reloads the week and starts a hold for each Thursday visit", async () => {
    await app.store.setClock(at("15:00"));
    const r = await send("/api/demo/reset", "POST");
    expect(r.status).toBe(200);
    expect(await read(r)).toEqual({ ok: true, holdsStarted: thursdayVisits.length });
    await app.runner.idle();
    expect(await app.store.now()).toBe(at("07:10"));
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("held");
  });

  it("refuses resets past the daily allowance, and the count survives each reset", async () => {
    app.cfg.demoResetsPerDay = 2;
    expect((await send("/api/demo/reset", "POST")).status).toBe(200);
    expect((await send("/api/demo/reset", "POST")).status).toBe(200);
    const refused = await send("/api/demo/reset", "POST");
    expect(refused.status).toBe(429);
    expect(await read(refused)).toMatchObject({ error: expect.stringContaining("reset many times today") });
    const counts = await app.store.db.query<{ value: number }>("select value from kv where key like 'demo_resets:%'");
    expect(counts.map((c) => c.value)).toEqual([2]);
  });

  it("is refused with 403 when the server is not in demo mode", async () => {
    app.cfg.demo = false;
    const r = await send("/api/demo/reset", "POST");
    expect(r.status).toBe(403);
    expect(await read(r)).toEqual({ error: "demo only" });
  });

  it("does not mark the demo as used, even though it is a POST", async () => {
    await send("/api/demo/reset", "POST");
    expect(await app.store.kvGet("demo_used_at")).toBeNull();
  });

  it("arms a crash that fires once inside the next settlement, and the retry completes it", async () => {
    await holdAll();
    const armed = await send("/api/demo/crash-next-settle", "POST", { visitId: "v-thu-weber" });
    expect(armed.status).toBe(200);
    expect(await read(armed)).toEqual({ armed: "v-thu-weber" });
    await send("/api/clock", "POST", { at: at("10:00") });
    expect((await send("/api/visits/v-thu-weber/checkin", "POST", { memberId: "lena" })).status).toBe(200);
    await send("/api/clock", "POST", { at: at("13:00") });
    expect((await send("/api/visits/v-thu-weber/checkout", "POST", { memberId: "lena" })).status).toBe(200);
    await app.runner.idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("paid_out");
    expect((await app.store.events(60, "v-thu-weber")).map((e) => e.type)).toContain("task.crashed");
    expect((await app.store.moneyRows("v-thu-weber")).filter((m) => m.kind === "capture")).toHaveLength(1);
  });

  it("refuses the crash hook with 403 when the server is not in demo mode", async () => {
    app.cfg.demo = false;
    const r = await send("/api/demo/crash-next-settle", "POST", { visitId: "v-thu-weber" });
    expect(r.status).toBe(403);
  });
});

describe("visit views", () => {
  it("returns a visit with its money rows and events", async () => {
    const r = await send("/api/visits/v-thu-weber", "GET");
    expect(r.status).toBe(200);
    const body = await read<{ visit: Record<string, unknown>; money: unknown[]; events: unknown[] }>(r);
    expect(body.visit).toMatchObject({ id: "v-thu-weber", priceCents: 10500, holdCents: 12250, payment: "not held yet", state: "scheduled" });
    expect(body.money).toEqual([]);
    expect(body.events).toEqual([]);
  });

  it("answers 404 for a visit that does not exist", async () => {
    const r = await send("/api/visits/v-nope/cancel-preview", "GET");
    expect(r.status).toBe(404);
    expect(await read(await send("/api/visits/v-nope", "GET"))).toEqual({ error: "no such visit" });
  });

  it("returns the evidence file for a visit, and 404 for an unknown one", async () => {
    const ok = await send("/api/visits/v-thu-weber/evidence", "GET");
    expect(ok.status).toBe(200);
    expect(await read(ok)).toMatchObject({ visitId: "v-thu-weber", members: ["Lena Petrova"] });
    const missing = await send("/api/visits/v-nope/evidence", "GET");
    expect(missing.status).toBe(404);
    expect(await read(missing)).toEqual({ error: "no such visit" });
  });
});

describe("moving a visit", () => {
  it("check-move says whether a member can take a visit", async () => {
    const r = await send("/api/visits/v-thu-weber/check-move", "POST", { memberId: "marek" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ ok: true, reasons: [], consent: false });
  });

  it("check-move gives the reasons when a member cannot take a visit", async () => {
    const r = await send("/api/visits/v-thu-weber/check-move", "POST", { memberId: "joy" });
    expect(r.status).toBe(200);
    const body = await read<{ ok: boolean; reasons: string[] }>(r);
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("does not work that day");
  });

  it("check-move reports an unknown member as a reason, not a failure", async () => {
    const r = await send("/api/visits/v-thu-weber/check-move", "POST", { memberId: "nobody" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ ok: false, reasons: ["unknown member"] });
  });

  it("move reassigns a visit a member can take", async () => {
    const r = await send("/api/visits/v-thu-weber/move", "POST", { memberId: "marek" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ visit: { id: "v-thu-weber", memberIds: ["marek"] }, pendingConsent: false });
  });

  it("move is refused with 409 and the reasons when the member cannot take the visit", async () => {
    const r = await send("/api/visits/v-thu-weber/move", "POST", { memberId: "joy" });
    expect(r.status).toBe(409);
    expect(await read(r)).toMatchObject({ error: expect.stringContaining("does not work that day") });
    expect((await app.store.visit("v-thu-weber"))!.memberIds).toEqual(["lena"]);
  });

  it("move to a same-cleaner household waits for the household's answer", async () => {
    const r = await send("/api/visits/v-thu-okafor/move", "POST", { memberId: "marek" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ visit: { memberIds: ["sam"], pendingMember: "marek" }, pendingConsent: true });
  });

  it("a household answers only for its own visit, and only when something is pending", async () => {
    await send("/api/visits/v-thu-okafor/move", "POST", { memberId: "marek" });
    const wrongHome = await send("/api/visits/v-thu-okafor/consent", "POST", { householdId: "weber", approve: true });
    expect(wrongHome.status).toBe(403);
    expect(await read(wrongHome)).toEqual({ error: "not your visit" });
    expect((await app.store.visit("v-thu-okafor"))!.pendingMember).toBe("marek");
  });

  it("a household's decline keeps the regular cleaner", async () => {
    await send("/api/visits/v-thu-okafor/move", "POST", { memberId: "marek" });
    const r = await send("/api/visits/v-thu-okafor/consent", "POST", { householdId: "okafor", approve: false });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ memberIds: ["sam"], pendingMember: null });
  });

  it("a household's approval gives the visit to the member asked", async () => {
    await send("/api/visits/v-thu-okafor/move", "POST", { memberId: "marek" });
    const r = await send("/api/visits/v-thu-okafor/consent", "POST", { householdId: "okafor", approve: true });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ memberIds: ["marek"], pendingMember: null });
  });

  it("an answer with nothing pending is a conflict", async () => {
    const r = await send("/api/visits/v-thu-okafor/consent", "POST", { householdId: "okafor", approve: true });
    expect(r.status).toBe(409);
    expect(await read(r)).toEqual({ error: "nothing to approve" });
  });
});

describe("check-in, check-out and the money", () => {
  it("check-in by someone else is 403, and checking in twice is 409", async () => {
    await holdAll();
    const wrong = await send("/api/visits/v-thu-weber/checkin", "POST", { memberId: "sam" });
    expect(wrong.status).toBe(403);
    expect((await send("/api/visits/v-thu-weber/checkin", "POST", { memberId: "lena" })).status).toBe(200);
    const again = await send("/api/visits/v-thu-weber/checkin", "POST", { memberId: "lena" });
    expect(again.status).toBe(409);
    expect(await read(again)).toEqual({ error: "cannot check in a visit that is in_progress" });
  });

  it("check-out before check-in is 409", async () => {
    await holdAll();
    const r = await send("/api/visits/v-thu-weber/checkout", "POST", { memberId: "lena" });
    expect(r.status).toBe(409);
  });

  it("a checked-out visit is captured and paid, and the statement lists its PayPal transaction", async () => {
    await holdAll();
    await send("/api/clock", "POST", { at: at("10:00") });
    await send("/api/visits/v-thu-weber/checkin", "POST", { memberId: "lena" });
    await send("/api/clock", "POST", { at: at("13:00") });
    const r = await send("/api/visits/v-thu-weber/checkout", "POST", { memberId: "lena", extraApproved: false });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ state: "settling" });
    await app.runner.idle();
    expect((await app.store.visit("v-thu-weber"))!.state).toBe("paid_out");
    const st = await read<{ lines: { transactionId: string | null; reconciled: string }[]; totalCents: number }>(await send("/api/members/lena/statement", "GET"));
    expect(st.totalCents).toBe(9975);
    expect(st.lines).toHaveLength(1);
    expect(st.lines[0]?.transactionId).toBeTruthy();
    expect(st.lines[0]?.reconciled).toBe("matched");
  });

  it("cancel-preview shows the late fee inside the notice and the release", async () => {
    await holdAll();
    await app.store.setClock(at("08:30"));
    const r = await send("/api/visits/v-thu-weber/cancel-preview", "GET");
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ late: true, minutesBefore: 90, feeCents: 5250, releaseCents: 7000, heldCents: 12250, lateFeeCents: 5250, closed: false });
  });

  it("cancel-preview is closed once the visit has started", async () => {
    await holdAll();
    await app.store.setClock(at("10:00"));
    expect(await read(await send("/api/visits/v-thu-weber/cancel-preview", "GET"))).toMatchObject({ closed: true });
  });

  it("a cancellation with notice settles to cancelled with no money moved", async () => {
    const r = await send("/api/visits/v-fri-haddad/cancel", "POST", { by: "household", actor: "haddad" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ state: "settling" });
    await app.runner.idle();
    expect((await app.store.visit("v-fri-haddad"))!.state).toBe("cancelled");
    expect(await app.store.moneyRows("v-fri-haddad")).toHaveLength(0);
  });

  it("a late cancellation keeps the fee and settles as late_cancel", async () => {
    await holdAll();
    await app.store.setClock(at("08:30"));
    const r = await send("/api/visits/v-thu-weber/cancel", "POST", { by: "household", actor: "lena" });
    expect(r.status).toBe(200);
    await app.runner.idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("late_cancel");
    expect(v.capture?.cents).toBe(5250);
  });

  it("cancelling after the start is 409, and so is cancelling a visit that is done", async () => {
    await holdAll();
    await app.store.setClock(at("10:00"));
    const started = await send("/api/visits/v-thu-weber/cancel", "POST", { by: "household", actor: "lena" });
    expect(started.status).toBe(409);
    expect(await read(started)).toEqual({ error: "the visit has started" });
    const done = await send("/api/visits/v-mon-larsen/cancel", "POST", { by: "household", actor: "larsen" });
    expect(done.status).toBe(409);
    expect(await read(done)).toEqual({ error: "cannot cancel a visit that is done" });
  });

  it("a lock-out by the assigned member captures the lock-out fee", async () => {
    await holdAll();
    await app.store.setClock(at("10:05"));
    const r = await send("/api/visits/v-thu-weber/lockout", "POST", { memberId: "lena" });
    expect(r.status).toBe(200);
    await app.runner.idle();
    expect((await app.store.visit("v-thu-weber"))!.capture?.cents).toBe(10500);
  });

  it("a lock-out by someone else is 403, and on a visit with no hold yet it is 409", async () => {
    await holdAll();
    expect((await send("/api/visits/v-thu-weber/lockout", "POST", { memberId: "sam" })).status).toBe(403);
    const r = await send("/api/visits/v-fri-haddad/lockout", "POST", { memberId: "lena" });
    expect(r.status).toBe(409);
    expect(await read(r)).toEqual({ error: "cannot report a lock-out on a visit that is scheduled" });
  });

  it("release without cover voids the hold, and a second release is 409", async () => {
    await holdAll();
    const r = await send("/api/visits/v-thu-weber/release", "POST");
    expect(r.status).toBe(200);
    await app.runner.idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("voided");
    expect(v.void).not.toBeNull();
    const again = await send("/api/visits/v-thu-weber/release", "POST");
    expect(again.status).toBe(409);
    expect(await read(again)).toEqual({ error: "cannot release a visit that is voided" });
  });
});

describe("messages and the cover agent", () => {
  it("a sick message from Sam opens a disruption for his three visits", async () => {
    const r = await send("/api/messages", "POST", { memberId: "sam", text: STORY.message });
    expect(r.status).toBe(200);
    const d = await read<{ id: string; kind: string; status: string; affected: string[] }>(r);
    expect(d).toMatchObject({ kind: "out_today", status: "open" });
    expect([...d.affected].sort()).toEqual(["v-thu-murphy", "v-thu-okafor", "v-thu-santos"]);
  });

  it("an empty message is 400", async () => {
    const r = await send("/api/messages", "POST", { memberId: "sam", text: "" });
    expect(r.status).toBe(400);
    expect(await read<{ error: string }>(r)).toMatchObject({ error: expect.stringContaining("text") });
  });

  it("a message that moves nothing opens a disruption with no visits affected", async () => {
    const before = (await app.store.visit("v-thu-hassan"))!;
    const r = await send("/api/messages", "POST", { memberId: "teresa", text: "Bus is slow, I'll be there at 9:05" });
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ kind: "other", affected: [] });
    const after = (await app.store.visit("v-thu-hassan"))!;
    expect(after.state).toBe(before.state);
    expect(after.memberIds).toEqual(["teresa"]);
  });

  it("propose, approve and dismiss walk one disruption through the agent", async () => {
    const d = await read<{ id: string }>(await send("/api/messages", "POST", { memberId: "sam", text: STORY.message }));
    const p = await send(`/api/disruptions/${d.id}/propose`, "POST");
    expect(p.status).toBe(200);
    expect(await read(p)).toMatchObject({ source: "template", plan: { covered: 3, consent: 1 } });
    const a = await send(`/api/disruptions/${d.id}/approve`, "POST");
    expect(a.status).toBe(200);
    const moved = await read<{ moved: string[]; asked: string[]; released: string[] }>(a);
    expect(moved.asked).toEqual(["v-thu-okafor"]);
    expect([...moved.moved].sort()).toEqual(["v-thu-murphy", "v-thu-santos"]);
    expect((await app.store.visit("v-thu-santos"))!.memberIds).toEqual(["teresa"]);
    const board = await read<Board>(await send("/api/board", "GET"));
    expect(board.events.map((e) => e.type)).toContain("disruption.approved");
    expect(board.events.map((e) => e.type)).not.toContain("message.sent");
    const dismissed = await send(`/api/disruptions/${d.id}/dismiss`, "POST");
    expect(await read(dismissed)).toEqual({ ok: true });
    expect(await read(await send(`/api/disruptions/${d.id}`, "GET"))).toMatchObject({ status: "dismissed" });
  });

  it("a disruption that does not exist is 404", async () => {
    const r = await send("/api/disruptions/d-missing", "GET");
    expect(r.status).toBe(404);
    expect(await read(r)).toEqual({ error: "not found" });
  });
});

describe("phone views", () => {
  it("a member's phone shows today's visits and their households", async () => {
    const r = await send("/api/members/lena/today", "GET");
    expect(r.status).toBe(200);
    const body = await read<{ member: { id: string }; today: { id: string }[]; week: unknown[] }>(r);
    expect(body.member.id).toBe("lena");
    expect(body.today.map((v) => v.id)).toContain("v-thu-weber");
    expect(body.week).toHaveLength(seedVisits().filter((v) => v.memberIds.includes("lena")).length);
  });

  it("a member's phone for an unknown member is 404", async () => {
    const r = await send("/api/members/nobody/today", "GET");
    expect(r.status).toBe(404);
    expect(await read(r)).toEqual({ error: "no such member" });
  });

  it("a household's phone shows its visits and no vault details", async () => {
    const r = await send("/api/households/okafor", "GET");
    expect(r.status).toBe(200);
    const body = await read<{ household: Record<string, unknown>; agreement: unknown; visits: { householdId: string }[] }>(r);
    expect(body.household).toMatchObject({ id: "okafor", paypalSaved: true });
    expect(body.household).not.toHaveProperty("vaultId");
    expect(body.household).not.toHaveProperty("vaultEmail");
    expect(body.agreement).toBeNull();
    expect(body.visits.every((v) => v.householdId === "okafor")).toBe(true);
  });

  it("a household's phone for an unknown household is 404", async () => {
    const r = await send("/api/households/nobody", "GET");
    expect(r.status).toBe(404);
    expect(await read(r)).toEqual({ error: "no such household" });
  });
});

describe("signing up", () => {
  it("lists the areas a household can pick", async () => {
    const r = await send("/api/signup/areas", "GET");
    expect(r.status).toBe(200);
    expect(await read<string[]>(r)).toContain("Capitol Hill");
  });

  it("a draft written by hand, with no model, names what is missing", async () => {
    const r = await send("/api/agreements/draft", "POST", {
      householdName: "The Test Family", area: "Ballard", language: "en", jobText: "Kitchen and bathrooms", memberLanguage: "en",
    });
    expect(r.status).toBe(200);
    const d = await read<{ id: string; source: string; notes: string[]; missing: { field: string }[] }>(r);
    expect(d.id).toMatch(/^a-/);
    expect(d.source).toBe("form");
    expect(d.notes).toContain("The assistant is unavailable; fill the fields by hand.");
    expect(d.missing.map((m) => m.field)).toEqual(["scope", "location", "schedule"]);
    expect(await app.store.db.query<{ status: string }>("select status from agreements where id = $1", [d.id])).toEqual([{ status: "draft" }]);
  });

  it("an update to an unknown agreement is 404", async () => {
    const r = await send("/api/agreements/a-missing/update", "POST", {});
    expect(r.status).toBe(404);
    expect(await read(r)).toEqual({ error: "no such agreement" });
  });

  it("an update changes the fields it is allowed to and ignores the rest", async () => {
    const d = await read<{ id: string }>(await send("/api/agreements/draft", "POST", {
      householdName: "The Test Family", area: "Ballard", language: "en", jobText: "Kitchen", memberLanguage: "en",
    }));
    const r = await send(`/api/agreements/${d.id}/update`, "POST", {
      householdName: "Changed Name", language: "pt", contact: "someone@example.com", scope: ["Kitchen"], rateCentsPerHour: 2500,
    });
    expect(r.status).toBe(200);
    const body = await read<{ agreement: Record<string, unknown> }>(r);
    expect(body.agreement).toMatchObject({ householdName: "The Test Family", language: "en", contact: "", scope: ["Kitchen"], rateCentsPerHour: 2500 });
  });

  it("an agreement that is complete can be signed, and the approval starts the household", async () => {
    const id = await draftComplete();
    const r = await send(`/api/agreements/${id}/sign`, "POST");
    expect(r.status).toBe(200);
    const { approveUrl, householdId } = await read<{ approveUrl: string; householdId: string }>(r);
    expect(householdId).toBe("test-family");
    const token = new URL(approveUrl).searchParams.get("approval_token_id")!;
    const back = await send(`/api/vault/return?agreement=${id}&approval_token_id=${token}`, "GET");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/h/test-family?welcome=1");
    expect((await app.store.household("test-family"))!.vaultId).toBe(`TOKEN-${token.slice(6)}`);
    expect((await app.store.visit("v-test-family-1"))!.state).toBe("scheduled");
    expect(await app.store.db.query<{ status: string }>("select status from agreements where id = $1", [id])).toEqual([{ status: "signed" }]);
  });

  it("the approval return without its parts is 400", async () => {
    const none = await send("/api/vault/return", "GET");
    expect(none.status).toBe(400);
    expect(await read(none)).toEqual({ error: "missing approval" });
    const noToken = await send("/api/vault/return?agreement=a-1", "GET");
    expect(noToken.status).toBe(400);
  });

  it("a household whose PayPal was refused saves it again, and its visit is held", async () => {
    pp.refuse.add("DEMO-VAULT");
    await holdAll();
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("at_risk");
    const start = await send("/api/households/okafor/repair", "POST");
    expect(start.status).toBe(200);
    const { approveUrl } = await read<{ approveUrl: string }>(start);
    const token = new URL(approveUrl).searchParams.get("approval_token_id")!;
    const back = await send(`/api/vault/return?household=okafor&approval_token_id=${token}`, "GET");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/h/okafor?repaired=1");
    await app.runner.idle();
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("held");
  });
});

describe("statements and the landlord link", () => {
  it("a member with no payouts has an empty statement and a template letter", async () => {
    const r = await send("/api/members/lena/statement", "GET");
    expect(r.status).toBe(200);
    expect(await read(r)).toMatchObject({ memberId: "lena", lines: [], totalCents: 0, letter: { source: "template" } });
  });

  it("a landlord link opens the member's statement without household names", async () => {
    const shared = await send("/api/members/marek/share", "POST");
    expect(shared.status).toBe(200);
    const { token, expiresAt } = await read<{ token: string; expiresAt: string }>(shared);
    const r = await send(`/api/share/${encodeURIComponent(token)}`, "GET");
    expect(r.status).toBe(200);
    const body = await read<Record<string, unknown>>(r);
    expect(body).toMatchObject({ name: "Marek Nowak", expiresAt, letter: { source: "template" } });
    const text = JSON.stringify(body);
    for (const h of households) expect(text).not.toContain(h.name);
  });

  it("a landlord link that is not valid is 404", async () => {
    const r = await send("/api/share/nope.nope", "GET");
    expect(r.status).toBe(404);
    expect(await read(r)).toEqual({ error: "this link is not valid or has expired" });
  });
});

describe("plumbing", () => {
  it("about lists the task runs and the money by kind", async () => {
    await holdAll();
    const r = await send("/api/about", "GET");
    expect(r.status).toBe(200);
    const body = await read<{ mode: { paypal: string }; ai: { live: boolean; dailyCap: number }; taskRuns: { status: string }[]; money: { kind: string; n: number }[] }>(r);
    expect(body.mode.paypal).toBe("stand-in");
    expect(body.ai).toMatchObject({ live: false, dailyCap: 600 });
    expect(body.taskRuns).toEqual(expect.arrayContaining([expect.objectContaining({ status: "succeeded" })]));
    expect(body.money).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "hold", n: thursdayVisits.length })]));
  });

  it("solve-preview returns the candidates and plans for the visits named", async () => {
    const r = await send("/api/solve-preview", "POST", { affected: ["v-thu-okafor"] });
    expect(r.status).toBe(200);
    const body = await read<{ candidates: Record<string, unknown[]>; plans: unknown[] }>(r);
    expect(Object.keys(body.candidates)).toEqual(["v-thu-okafor"]);
    expect(body.plans.length).toBeGreaterThan(0);
  });

  it("solve-preview takes at most eight visits", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `v-x-${i}`);
    const r = await send("/api/solve-preview", "POST", { affected: nine });
    expect(r.status).toBe(400);
  });

  it("a request body over 8 MB is refused with 413", async () => {
    const r = await send("/api/messages", "POST", { memberId: "sam", text: "x".repeat(9 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect(await read(r)).toEqual({ error: "request too large" });
  });

  it("a verified PayPal delivery is kept and tied to its visit", async () => {
    const r = await send("/api/paypal/webhook", "POST", await webhookDelivery(), { "paypal-transmission-sig": "stand-in:WH-ID" });
    expect(r.status).toBe(200);
    const e = (await app.store.events(10)).find((x) => x.type === "paypal.webhook");
    expect(e).toMatchObject({ visit_id: "v-thu-weber" });
  });

  it("a forged PayPal delivery is refused with 400 and recorded", async () => {
    const r = await send("/api/paypal/webhook", "POST", await webhookDelivery(), { "paypal-transmission-sig": "forged" });
    expect(r.status).toBe(400);
    expect(await read(r)).toEqual({ error: "webhook not verified" });
    expect((await app.store.events(10)).map((x) => x.type)).toContain("paypal.webhook_rejected");
  });

  it.each([
    ["a POST that changes the week", "POST", "/api/messages", { memberId: "sam", text: STORY.message }, true],
    ["a POST that moves the clock", "POST", "/api/clock", { at: at("08:00") }, true],
    ["a GET of the board", "GET", "/api/board", undefined, false],
    ["a GET of a visit", "GET", "/api/visits/v-thu-weber", undefined, false],
    ["a GET of the health check", "GET", "/api/health", undefined, false],
    ["a POST to the demo reset", "POST", "/api/demo/reset", undefined, false],
  ])("%s marks the demo as used only when it is a write", async (_label, method, path, body, marks) => {
    await send(path, method as "GET" | "POST", body);
    expect((await app.store.kvGet("demo_used_at")) !== null).toBe(marks);
  });

  it("a verified PayPal delivery does not mark the demo as used", async () => {
    await send("/api/paypal/webhook", "POST", await webhookDelivery(), { "paypal-transmission-sig": "stand-in:WH-ID" });
    expect(await app.store.kvGet("demo_used_at")).toBeNull();
  });
});
