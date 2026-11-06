import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { keepsNumbers } from "../server/agreements.ts";
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
  app = await makeApp({ ...config({}), dbFile: null }, pp);
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

describe("read-back check", () => {
  const en = "The Parks and the cooperative agree on home cleaning at Capitol Hill. Every Sat at 10:00, for 3 hours. Each visit: kitchen; bathrooms; floors; changing sheets. Rate $38.00 an hour, so $114.00 a visit. 24 hours before each visit, $133.00 is held on your PayPal (the visit plus up to 30 extra minutes, which you approve at the end). The visit is paid when it ends and the rest is released. Cancel more than 24 hours ahead: nothing to pay. Cancel later: $57.00 (50%). If nobody can let the cleaner in: 100% of the visit. You asked for the same cleaner every time. If that person is out, you will be asked before anyone else comes. You can stop the arrangement at any time from your page; holds stop at once.";
  const text = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { output: { text: string } }).output.text;

  it("rejects the live Portuguese answer that turned the $133.00 hold into $114.00", () => {
    const pt = text("tests/fixtures/readback-pt-changed-hold.json");
    expect(pt).toContain("$114.00 são retidos");
    expect(keepsNumbers(en, pt)).toBe(false);
  });

  it("accepts every recorded read-back of the demo agreement", () => {
    const recorded = JSON.parse(readFileSync("data/ai-recordings.json", "utf8")) as Record<string, { output: { text: string } }>;
    const readbacks = Object.entries(recorded).filter(([k]) => k.startsWith("agreement-readback/"));
    expect(readbacks.length).toBeGreaterThan(0);
    for (const [k, r] of readbacks) expect(keepsNumbers(en, r.output.text), k).toBe(true);
  });
});

describe("gateway without a key", () => {
  it("refuses live calls and the callers fall back", async () => {
    const ai = new Gemini({ ...config({}), geminiKey: undefined }, app.store);
    const d = await openDisruption(app.store, ai, "sam", STORY.message);
    expect(d.kind).toBe("out_today");
  });
});
