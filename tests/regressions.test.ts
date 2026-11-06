// One test per bug found, named after the behaviour it protects.
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { answerConsent, canMove, checkIn, checkOut, move, noCover } from "../server/actions.ts";
import { Gemini } from "../server/ai/gemini.ts";
import { routes } from "../server/api.ts";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";
import { hm } from "../shared/seed.ts";

const THU = 3 * 1440;
let app: App;
const ctx = () => ({ store: app.store, runner: app.runner });
const server = () => {
  const s = new Hono();
  routes(s, app, new Gemini({ ...app.cfg, geminiKey: undefined }, app.store));
  return s;
};
const post = (path: string, body: unknown = {}) =>
  server().request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(async () => {
  const pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dbFile: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
  await app.store.reset();
  await sweep(app);
  await app.runner.idle();
});

describe("found while testing, kept fixed", () => {
  it("a checked-in visit cannot be released, so the member still gets paid at check-out", async () => {
    await app.store.setClock(THU + hm("10:00"));
    await checkIn(ctx(), "v-thu-weber", "lena");
    await expect(noCover(ctx(), "v-thu-weber", "dana")).rejects.toThrow(/in progress/);
    await app.store.setClock(THU + hm("13:00"));
    await checkOut(ctx(), "v-thu-weber", "lena", false);
    await app.runner.idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("paid_out");
    expect(v.void).toBeNull();
  });

  it("a household's yes does not double-book a member who took another visit while it was asked", async () => {
    expect((await move(ctx(), "v-thu-okafor", "marek", "dana")).pendingConsent).toBe(true);
    expect((await move(ctx(), "v-thu-dubois", "marek", "dana")).pendingConsent).toBe(false);
    await expect(answerConsent(ctx(), "v-thu-okafor", "okafor", true)).rejects.toThrow(/can no longer take/);
    const v = (await app.store.visit("v-thu-okafor"))!;
    expect(v.memberIds).toEqual(["sam"]);
    expect(v.pendingMember).toBeNull();
  });

  it("a signed agreement cannot be edited back to a draft", async () => {
    const draft = (await (
      await post("/api/agreements/draft", {
        householdName: "The Abernathys",
        area: "Capitol Hill",
        language: "en",
        jobText: "A small flat",
        memberLanguage: "en",
        memberText: "$25 an hour, 24 hours notice, half the visit if late",
      })
    ).json()) as { id: string };
    await post(`/api/agreements/${draft.id}/update`, {
      scope: ["floors"],
      location: "Capitol Hill",
      rateCentsPerHour: 2500,
      schedule: { weekday: 5, start: "10:00", minutes: 180, frequency: "weekly" },
      cancellation: { noticeHours: 24, lateCancelPct: 50, lockoutPct: 100 },
    });
    const signing = await post(`/api/agreements/${draft.id}/sign`);
    expect(signing.status).toBe(200);
    const edit = await post(`/api/agreements/${draft.id}/update`, { rateCentsPerHour: 2000 });
    expect(edit.status).toBe(409);
    const rows = await app.store.db.query<{ data: { rateCentsPerHour: number }; status: string }>("select data, status from agreements where id = $1", [
      draft.id,
    ]);
    expect(rows[0]).toMatchObject({ status: "signing", data: { rateCentsPerHour: 2500 } });
  });

  it("a visit from earlier in the week cannot be moved or released", async () => {
    const past = (await app.store.visits()).find((v) => v.state === "done")!;
    const other = (await app.store.members()).find((m) => !past.memberIds.includes(m.id))!;
    const check = await canMove(ctx(), past.id, other.id);
    expect(check).toMatchObject({ ok: false, reasons: ["the visit is over"] });
    await expect(move(ctx(), past.id, other.id, "dana")).rejects.toThrow(/over/);
    await expect(noCover(ctx(), past.id, "dana")).rejects.toThrow(/cannot release/);
    expect((await app.store.visit(past.id))!.state).toBe("done");
  });

  it.each([
    [
      "approving a disruption with no proposal yet",
      "POST",
      async () => {
        const d = (await (await post("/api/messages", { memberId: "sam", text: "my son has a fever, I can't come in" })).json()) as { id: string };
        return `/api/disruptions/${d.id}/approve`;
      },
      409,
    ],
    ["a statement for an unknown member", "GET", async () => "/api/members/nobody/statement", 404],
    ["signing an agreement that does not exist", "POST", async () => "/api/agreements/nothing/sign", 404],
  ])("a client error is not a server error: %s", async (_name, method, path, status) => {
    const url = await path();
    const r = method === "POST" ? await post(url) : await server().request(url);
    expect(r.status).toBe(status);
  });

  it("signing an incomplete agreement is refused as the client's error", async () => {
    const draft = (await (
      await post("/api/agreements/draft", {
        householdName: "The Abernathys",
        area: "Capitol Hill",
        language: "en",
        jobText: "A small flat",
        memberLanguage: "en",
      })
    ).json()) as { id: string };
    expect((await post(`/api/agreements/${draft.id}/sign`)).status).toBe(409);
  });
});
