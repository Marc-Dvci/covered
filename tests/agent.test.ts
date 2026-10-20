import { beforeEach, describe, expect, it } from "vitest";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { Gemini, numbersOk } from "../server/ai/gemini.ts";
import { intake, openDisruption, propose } from "../server/dispatch/agent.ts";
import { approve } from "../server/dispatch/approve.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";
import { STORY } from "../shared/seed.ts";

let app: App;
beforeEach(async () => {
  const pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dataDir: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
  await app.store.reset();
  await sweep(app);
  await app.runner.idle();
  await app.store.setClock(STORY.messageAt);
});

describe("cover agent without a model", () => {
  it("reads a sick message with keywords", async () => {
    expect((await intake(null, STORY.message, STORY.messageAt)).kind).toBe("out_today");
    expect((await intake(null, "Running ten minutes late", STORY.messageAt)).kind).toBe("other");
  });

  it("proposes the solver's best plan with template messages in each language", async () => {
    const d = await openDisruption(app.store, null, "sam", STORY.message);
    expect(d.affected.sort()).toEqual(["v-thu-murphy", "v-thu-okafor", "v-thu-santos"]);
    const p = await propose(app.store, null, d.id);
    expect(p.source).toBe("template");
    expect(p.plan.covered).toBe(3);
    expect(p.plan.consent).toBe(1);
    const to = Object.fromEntries(p.messages.map((m) => [m.toId, m.language]));
    expect(to).toMatchObject({ sam: "en", marek: "pl", teresa: "pt", okafor: "en", santos: "pt", murphy: "en" });
  });

  it("approval moves two visits, asks the Okafors, and keeps every hold", async () => {
    const d = await openDisruption(app.store, null, "sam", STORY.message);
    await propose(app.store, null, d.id);
    const r = await approve({ store: app.store, runner: app.runner }, d.id);
    expect(r.asked).toEqual(["v-thu-okafor"]);
    expect(r.moved.sort()).toEqual(["v-thu-murphy", "v-thu-santos"]);
    for (const id of ["v-thu-okafor", "v-thu-santos", "v-thu-murphy"]) expect((await app.store.visit(id))!.hold).not.toBeNull();
    expect((await app.store.visit("v-thu-santos"))!.memberIds).toEqual(["teresa"]);
  });

  it("an ordinary message opens nothing to cover", async () => {
    const d = await openDisruption(app.store, null, "teresa", "Bus is slow, I'll be there at 9:05");
    expect(d.affected).toEqual([]);
  });
});

describe("number check", () => {
  it("accepts numbers the tools gave and rejects invented ones", () => {
    const allowed = ["09:00", "13:00", "$157.50", 4];
    expect(numbersOk("Marek can come at 9:00 until 13:00.", allowed)).toBe(true);
    expect(numbersOk("$157.50 is held.", allowed)).toBe(true);
    expect(numbersOk("Marek can come at 10:00.", allowed)).toBe(false);
    expect(numbersOk("You'll be charged $20.", allowed)).toBe(false);
  });
});

describe("gateway without a key", () => {
  it("refuses live calls and the callers fall back", async () => {
    const ai = new Gemini({ ...config({}), geminiKey: undefined }, app.store);
    const d = await openDisruption(app.store, ai, "sam", STORY.message);
    expect(d.kind).toBe("out_today");
  });
});
