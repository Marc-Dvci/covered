import { beforeEach, describe, expect, it } from "vitest";
import { checkIn, checkOut } from "../server/actions.ts";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { LocalRunner } from "../server/runner.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { landlordView, openShare, share, statement } from "../server/statements.ts";

let app: App;
beforeEach(async () => {
  const pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dbFile: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5 }, 5);
  await app.store.reset();
});

describe("landlord link", () => {
  it("opens with the right secret before it expires", async () => {
    const { token } = await share(app.store, "s3cret", "marek");
    expect((await openShare(app.store, "s3cret", token))?.memberId).toBe("marek");
  });

  it("refuses an expired link, a wrong secret and a tampered token", async () => {
    const old = await share(app.store, "s3cret", "marek", -1);
    expect(await openShare(app.store, "s3cret", old.token)).toBeNull();
    const { token } = await share(app.store, "s3cret", "marek");
    expect(await openShare(app.store, "other", token)).toBeNull();
    const [id, mac] = token.split(".");
    expect(await openShare(app.store, "s3cret", `${id}.${mac!.slice(0, -1)}${mac!.endsWith("A") ? "B" : "A"}`)).toBeNull();
  });

  it("shows Marek's paid visit with no household name", async () => {
    await sweep(app);
    await app.runner.idle();
    const v = (await app.store.visit("v-thu-lindqvist"))!;
    const ctx = { store: app.store, runner: app.runner };
    await app.store.setClock(v.start);
    await checkIn(ctx, v.id, "marek");
    await app.store.setClock(v.start + v.minutes);
    await checkOut(ctx, v.id, "marek", false);
    await app.runner.idle();
    const view = landlordView(await statement(app.store, app.paypal, "marek"));
    const households = (await app.store.households()).map((h) => h.name);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.transactionId).toBeTruthy();
    const text = JSON.stringify(view);
    for (const n of households) expect(text).not.toContain(n);
  });
});
