import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Gemini } from "../server/ai/gemini.ts";
import { routes } from "../server/api.ts";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";

let app: App;
const server = () => {
  const s = Fastify();
  routes(s, app, new Gemini({ ...app.cfg, geminiKey: undefined }, app.store));
  return s;
};
const delivery = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", invoice_id: "covered-v-thu-weber" } };

beforeEach(async () => {
  const pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dataDir: null, webhookId: "WH-ID" }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
  await app.store.reset();
  await sweep(app);
  await app.runner.idle();
});

describe("PayPal webhooks", () => {
  it("keeps a verified delivery and ties it to the visit by invoice id", async () => {
    const r = await server().inject({ method: "POST", url: "/api/paypal/webhook", payload: delivery, headers: { "paypal-transmission-sig": "stand-in:WH-ID" } });
    expect(r.statusCode).toBe(200);
    const e = (await app.store.events(5)).find((x) => x.type === "paypal.webhook")!;
    expect(e).toMatchObject({ visit_id: "v-thu-weber", data: { type: "PAYMENT.CAPTURE.COMPLETED", verified: true } });
  });

  it("refuses a forged delivery and records the refusal", async () => {
    const r = await server().inject({ method: "POST", url: "/api/paypal/webhook", payload: delivery, headers: { "paypal-transmission-sig": "forged" } });
    expect(r.statusCode).toBe(400);
    const types = (await app.store.events(5)).map((x) => x.type);
    expect(types).toContain("paypal.webhook_rejected");
    expect(types).not.toContain("paypal.webhook");
  });

  it("refuses every delivery when no webhook id is configured", async () => {
    app.cfg.webhookId = undefined;
    const r = await server().inject({ method: "POST", url: "/api/paypal/webhook", payload: delivery, headers: { "paypal-transmission-sig": "stand-in:WH-ID" } });
    expect(r.statusCode).toBe(400);
  });
});
