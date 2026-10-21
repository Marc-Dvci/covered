import { beforeEach, describe, expect, it } from "vitest";
import { answerConsent, cancel, cancelPreview, canMove, checkIn, checkOut, lockout, move } from "../server/actions.ts";
import { config, makeApp, sweep, type App } from "../server/context.ts";
import { evidence } from "../server/evidence.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { LocalRunner } from "../server/runner.ts";
import { hm } from "../shared/seed.ts";

const THU = 3 * 1440;
let app: App;
let pp: FakePayPal;

beforeEach(async () => {
  pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dataDir: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 5, payoutWaitMs: 2000 }, 5);
  await app.store.reset();
});

const ctx = () => ({ store: app.store, runner: app.runner });
const idle = () => app.runner.idle();

describe("visit money lifecycle", () => {
  it("places holds only for visits inside the notice window", async () => {
    const due = await sweep(app);
    await idle();
    const visits = await app.store.visits();
    const now = THU + hm("07:10");
    for (const v of visits) {
      const inWindow = v.start > now && v.start - (24 * 60 + 10) <= now;
      expect(due.includes(v.id)).toBe(inWindow);
      expect(v.state).toBe(inWindow ? "held" : v.start + v.minutes <= now ? "done" : "scheduled");
    }
    expect(due).toContain("v-thu-okafor");
  });

  it("captures at check-out and pays the member once", async () => {
    await sweep(app);
    await idle();
    await app.store.setClock(THU + hm("10:00"));
    await checkIn(ctx(), "v-thu-weber", "lena");
    await app.store.setClock(THU + hm("13:00"));
    await checkOut(ctx(), "v-thu-weber", "lena", false);
    await idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("paid_out");
    expect(v.capture?.cents).toBe(10500);
    expect(v.settlement?.releaseCents).toBe(1750);
    expect(v.payout?.items).toEqual([expect.objectContaining({ memberId: "lena", cents: 9975, status: "SUCCESS" })]);
  });

  it("answers a dispute from the ledger: terms, attendance and every PayPal id", async () => {
    await sweep(app);
    await idle();
    await app.store.setClock(THU + hm("10:02"));
    await checkIn(ctx(), "v-thu-weber", "lena");
    await app.store.setClock(THU + hm("13:01"));
    await checkOut(ctx(), "v-thu-weber", "lena", false);
    await idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    const e = (await evidence(app.store, "v-thu-weber"))!;
    expect(e.attendance).toMatchObject({ checkIn: expect.stringContaining("10:02"), checkOut: expect.stringContaining("13:01"), minutesOnSite: 179, extraApproved: false });
    expect(e.money.map((m) => m.step)).toEqual(["hold", "capture", "payout to Lena Petrova"]);
    expect(e.money.find((m) => m.step === "capture")?.paypalId).toBe(v.capture!.captureId);
    expect(e.money.find((m) => m.step === "hold")?.paypalId).toBe(v.hold!.authorizationId);
    expect(e.timeline.map((t) => t.what)).toEqual(expect.arrayContaining(["Member checked in at the door", expect.stringMatching(/^Captured \$105\.00/)]));
    expect(e.summary).toContain(v.capture!.captureId);
    expect(await evidence(app.store, "no-such-visit")).toBeNull();
  });

  it("moves real money again after a demo reset: PayPal ids carry the reset's run tag", async () => {
    const run = async () => {
      await sweep(app);
      await idle();
      await app.store.setClock(THU + hm("10:00"));
      await checkIn(ctx(), "v-thu-weber", "lena");
      await app.store.setClock(THU + hm("13:00"));
      await checkOut(ctx(), "v-thu-weber", "lena", false);
      await idle();
      return (await app.store.visit("v-thu-weber"))!;
    };
    const a = await run();
    await app.store.reset();
    const b = await run();
    expect(b.state).toBe("paid_out");
    expect(b.payout?.status).toBe("SUCCESS");
    expect(b.payout?.batchId).not.toBe(a.payout?.batchId);
    expect(b.hold?.authorizationId).not.toBe(a.hold?.authorizationId);
    expect(b.capture?.captureId).not.toBe(a.capture?.captureId);
  });

  it("survives a crash between capture and payout: one capture, one payout", async () => {
    await sweep(app);
    await idle();
    await app.store.setClock(THU + hm("10:00"));
    await checkIn(ctx(), "v-thu-weber", "lena");
    await app.store.kvSet("crash-after-capture:v-thu-weber", true);
    await app.store.setClock(THU + hm("13:00"));
    await checkOut(ctx(), "v-thu-weber", "lena", false);
    await idle();
    const money = await app.store.moneyRows("v-thu-weber");
    expect(money.filter((m) => m.kind === "capture")).toHaveLength(1);
    expect(new Set(money.filter((m) => m.kind === "payout").map((m) => m.paypal_id)).size).toBe(1);
    const runs = (await app.store.events(50, "v-thu-weber")).filter((e) => e.type === "task.run").map((e) => e.data.status);
    expect(runs).toEqual(["succeeded", "retrying", "succeeded"]); // newest first: settle ok, settle crashed, hold ok
    expect((await app.store.visit("v-thu-weber"))!.state).toBe("paid_out");
  });

  it("charges the late-cancel fee inside the window and releases the rest", async () => {
    await sweep(app);
    await idle();
    await app.store.setClock(THU + hm("08:30"));
    const p = await cancelPreview(ctx(), "v-thu-weber");
    expect(p).toMatchObject({ late: true, feeCents: 5250, releaseCents: 7000, minutesBefore: 90 });
    await cancel(ctx(), "v-thu-weber", "household", "weber");
    await idle();
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("late_cancel");
    expect(v.capture?.cents).toBe(5250);
    expect(v.payout?.items[0]).toMatchObject({ memberId: "lena", cents: 4988 });
  });

  it("charges nothing for a cancellation with notice", async () => {
    await cancel(ctx(), "v-fri-haddad", "household", "haddad"); // Friday 10:00, 27 hours away, no hold yet
    await idle();
    const v = (await app.store.visit("v-fri-haddad"))!;
    expect(v.state).toBe("cancelled");
    expect(v.capture).toBeNull();
    expect(await app.store.moneyRows("v-fri-haddad")).toHaveLength(0);
  });

  it("marks a visit at risk when PayPal refuses the hold", async () => {
    pp.refuse.add("DEMO-VAULT");
    await sweep(app);
    await idle();
    expect((await app.store.visit("v-thu-okafor"))!.state).toBe("at_risk");
  });

  it("captures the lock-out fee", async () => {
    await sweep(app);
    await idle();
    await app.store.setClock(THU + hm("10:05"));
    await lockout(ctx(), "v-thu-weber", "lena");
    await idle();
    expect((await app.store.visit("v-thu-weber"))!.capture?.cents).toBe(10500);
  });

  it("guards a move and asks a same-cleaner household first", async () => {
    await sweep(app);
    await idle();
    expect((await canMove(ctx(), "v-thu-okafor", "joy")).reasons).toEqual(expect.arrayContaining(["does not work that day", "no pets"]));
    const r = await move(ctx(), "v-thu-okafor", "marek", "dana");
    expect(r.pendingConsent).toBe(true);
    expect((await app.store.visit("v-thu-okafor"))!.memberIds).toEqual(["sam"]);
    await answerConsent(ctx(), "v-thu-okafor", "okafor", true);
    const v = (await app.store.visit("v-thu-okafor"))!;
    expect(v.memberIds).toEqual(["marek"]);
    expect(v.hold?.cents).toBe(15750); // the hold stays with the visit
  });

  it("refuses check-out by someone else", async () => {
    await sweep(app);
    await idle();
    await expect(checkIn(ctx(), "v-thu-weber", "sam")).rejects.toThrow(/someone else/);
  });
});
