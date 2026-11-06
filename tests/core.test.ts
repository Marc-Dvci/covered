import { beforeEach, describe, expect, it } from "vitest";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { makePayPal, refreshIfIdle, seedIfEmpty } from "../server/core.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { SandboxPayPal } from "../server/paypal/sandbox.ts";
import { LocalRunner } from "../server/runner.ts";
import { hm, members, seedVisits, STORY } from "../shared/seed.ts";

const THU = 3 * 1440;
const IDLE_MS = 30 * 60_000;
const NOW = 1_800_000_000_000;

let app: App;
let pp: FakePayPal;

beforeEach(async () => {
  pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dbFile: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
});

describe("configuration", () => {
  it("defaults to a file database, the demo on, and the recorded model", () => {
    expect(config({})).toMatchObject({
      dbFile: "var/covered.db",
      currency: "USD",
      publicUrl: "http://localhost:8787",
      demo: true,
      demoIdleMinutes: 30,
      demoResetsPerDay: 60,
      linkSecret: "dev-only-secret",
      modelFallbacks: ["gemini-3.5-flash", "gemini-3-flash-preview"],
      aiDailyCalls: 600,
      port: 8787,
    });
  });

  it("uses an in-memory database when asked for the memory store", () => {
    expect(config({ COVERED_DB_FILE: "memory" }).dbFile).toBeNull();
  });

  it("takes the public URL without its trailing slash", () => {
    expect(config({ COVERED_PUBLIC_URL: "https://covered.example/" }).publicUrl).toBe("https://covered.example");
  });

  it("splits the model fallbacks on commas and drops the empty ones", () => {
    expect(config({ COVERED_MODEL_FALLBACKS: " model-a , ,model-b " }).modelFallbacks).toEqual(["model-a", "model-b"]);
  });

  it("turns the demo off only for the value 0", () => {
    expect(config({ COVERED_DEMO: "0" }).demo).toBe(false);
    expect(config({ COVERED_DEMO: "1" }).demo).toBe(true);
    expect(config({}).demo).toBe(true);
  });

  it("treats empty credentials as absent", () => {
    const c = config({ PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", GEMINI_API_KEY: "" });
    expect(c.paypalClientId).toBeUndefined();
    expect(c.paypalSecret).toBeUndefined();
    expect(c.geminiKey).toBeUndefined();
  });
});

describe("choosing PayPal", () => {
  it("uses the stand-in when there are no keys", () => {
    const p = makePayPal(config({}));
    expect(p).toBeInstanceOf(FakePayPal);
    expect(p.live).toBe(false);
    expect(p.currency).toBe("USD");
  });

  it("uses the sandbox when both keys are set", () => {
    const p = makePayPal({ ...config({}), paypalClientId: "client", paypalSecret: "secret" });
    expect(p).toBeInstanceOf(SandboxPayPal);
    expect(p.live).toBe(true);
  });

  it("uses the stand-in when only one key is set", () => {
    expect(makePayPal({ ...config({}), paypalClientId: "client" })).toBeInstanceOf(FakePayPal);
  });
});

describe("sweep and seeding", () => {
  it("starts nothing when no visit is inside its notice window", async () => {
    await app.store.reset();
    await app.store.setClock(0);
    expect(await sweep(app)).toEqual([]);
    await app.runner.idle();
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("scheduled");
  });

  it("loads the demo week on an empty database and starts its first holds", async () => {
    await seedIfEmpty(app);
    await app.runner.idle();
    expect(await app.store.members()).toHaveLength(members.length);
    expect(await app.store.visits()).toHaveLength(seedVisits().length);
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("held");
  });

  it("does nothing the second time, so the clock and the visits are left as they are", async () => {
    await seedIfEmpty(app);
    await app.runner.idle();
    await app.store.setClock(42);
    const before = (await app.store.visits()).map((v) => `${v.id}:${v.state}`);
    await seedIfEmpty(app);
    await app.runner.idle();
    expect(await app.store.now()).toBe(42);
    expect((await app.store.visits()).map((v) => `${v.id}:${v.state}`)).toEqual(before);
  });
});

describe("the idle reload", () => {
  beforeEach(async () => {
    await app.store.reset();
  });

  it("does nothing when nobody has used the demo yet", async () => {
    expect(await refreshIfIdle(app, NOW)).toBe(false);
  });

  it("does nothing when the demo was used recently", async () => {
    await app.store.setClock(THU + hm("12:00"));
    await app.store.kvSet("demo_used_at", NOW);
    expect(await refreshIfIdle(app, NOW + IDLE_MS - 1)).toBe(false);
    expect(await app.store.now()).toBe(THU + hm("12:00"));
  });

  it("reloads the week once the demo has been quiet for demoIdleMinutes", async () => {
    await app.store.setClock(THU + hm("12:00"));
    await app.store.updateVisit("v-thu-weber", { state: "cancelled" });
    await app.store.kvSet("demo_used_at", NOW);
    expect(await refreshIfIdle(app, NOW + IDLE_MS)).toBe(true);
    await app.runner.idle();
    expect(await app.store.now()).toBe(STORY.messageAt);
    expect((await app.store.visit("v-thu-weber"))!.state).toBe("held");
    expect(await app.store.kvGet("demo_used_at")).toBeNull();
  });

  it("does not reload again straight after a reload, because the fresh week has no used mark", async () => {
    await app.store.kvSet("demo_used_at", NOW);
    expect(await refreshIfIdle(app, NOW + IDLE_MS * 4)).toBe(true);
    await app.runner.idle();
    expect(await refreshIfIdle(app, NOW + IDLE_MS * 4)).toBe(false);
  });

  it("never reloads a server that is not in demo mode", async () => {
    app.cfg.demo = false;
    await app.store.setClock(THU + hm("12:00"));
    await app.store.kvSet("demo_used_at", NOW);
    expect(await refreshIfIdle(app, NOW + IDLE_MS * 4)).toBe(false);
    expect(await app.store.now()).toBe(THU + hm("12:00"));
  });
});

describe("reset keeps the model allowance and the reset count", () => {
  it("a reset keeps the daily model allowance and the reset count, so it cannot refill them", async () => {
    await app.store.reset();
    await app.store.kvSet("ai_calls:2026-11-06", 600);
    await app.store.kvSet("demo_resets:2026-11-06", 3);
    await app.store.reset();
    expect(await app.store.kvGet("ai_calls:2026-11-06")).toBe(600);
    expect(await app.store.kvGet("demo_resets:2026-11-06")).toBe(3);
  });

  it("a reset clears the other keys: the used mark, armed crashes, repairs and the clock", async () => {
    await app.store.reset();
    await app.store.kvSet("demo_used_at", NOW);
    await app.store.kvSet("crash-after-capture:v-thu-weber", true);
    await app.store.kvSet("repair:okafor", "SETUP-1");
    await app.store.kvSet("setup:a-1", "SETUP-2");
    await app.store.setClock(9_999);
    await app.store.reset();
    expect(await app.store.kvGet("demo_used_at")).toBeNull();
    expect(await app.store.kvGet("crash-after-capture:v-thu-weber")).toBeNull();
    expect(await app.store.kvGet("repair:okafor")).toBeNull();
    expect(await app.store.kvGet("setup:a-1")).toBeNull();
    expect(await app.store.now()).toBe(STORY.messageAt);
  });
});
