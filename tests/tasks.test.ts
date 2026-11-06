import { beforeEach, describe, expect, it, vi } from "vitest";
import { config, makeApp, type App } from "../server/context.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { PayPalError, type Hold } from "../server/paypal/types.ts";
import { LocalRunner } from "../server/runner.ts";
import { dueForHold, finishVisit, mergePayoutItems, placeHold, pollPayout, settleMoney, type TaskDeps } from "../server/tasks.ts";
import { hm } from "../shared/seed.ts";
import type { VisitState } from "../shared/domain.ts";
import type { Outcome } from "../shared/rules/settle.ts";

const THU = 3 * 1440;
const LEAD = 24 * 60 + 10;

class BusyPayPal extends FakePayPal {
  override async authorize(_vaultId: string, _cents: number, _ref: string, _description: string, _invoiceId: string): Promise<Hold> {
    throw new PayPalError("authorize", 503, "BUSY");
  }
}

class LaggingPayPal extends FakePayPal {
  trailing = true;
  private withoutIds<T extends { items: { transactionId?: string }[] }>(p: T): T {
    return { ...p, items: p.items.map(({ transactionId: _t, ...rest }) => rest) };
  }
  override async payout(senderBatchId: string, items: Parameters<FakePayPal["payout"]>[1]) {
    return this.withoutIds(await super.payout(senderBatchId, items));
  }
  override async getPayout(batchId: string) {
    const p = await super.getPayout(batchId);
    return this.trailing ? this.withoutIds(p) : p;
  }
}

let app: App;
let pp: FakePayPal;
let deps: TaskDeps;

beforeEach(async () => {
  pp = new FakePayPal();
  pp.payoutDelayMs = 0;
  app = await makeApp({ ...config({}), dbFile: null }, pp);
  app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 1 }, 1);
  await app.store.reset();
  deps = { store: app.store, paypal: pp, payoutPollMs: 1 };
});

const checkoutOutcome = (memberId = "lena"): Outcome => ({ type: "checkout", worked: { [memberId]: 180 }, extraApproved: false });

/** The visit has a hold and an outcome, as checking out would leave it. */
async function readyToSettle(id: string, outcome: Outcome) {
  await placeHold(deps, id);
  await app.store.updateVisit(id, { state: "settling", outcome, checkinAt: THU + hm("10:00"), checkoutAt: THU + hm("13:00") });
}

async function settleAndFinish(id: string): Promise<VisitState> {
  await settleMoney(deps, id);
  await pollPayout(deps, id);
  await finishVisit(deps, id);
  return (await app.store.visit(id))!.state;
}

const hasEvent = async (visitId: string, type: string) => (await app.store.events(100, visitId)).some((e) => e.type === type);

describe("placing a hold", () => {
  it("says so for a visit that does not exist", async () => {
    expect(await placeHold(deps, "v-nope")).toBe("no such visit");
  });

  it("leaves a visit that is already held alone", async () => {
    const authorize = vi.spyOn(pp, "authorize");
    expect(await placeHold(deps, "v-thu-weber")).toBe("held $122.50");
    expect(await placeHold(deps, "v-thu-weber")).toBe("nothing to do (held)");
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("marks a visit at risk when the household has no saved PayPal", async () => {
    await app.store.db.query("update households set vault_id = null where id = 'lindqvist'");
    expect(await placeHold(deps, "v-thu-lindqvist")).toBe("no saved PayPal");
    expect((await app.store.visit("v-thu-lindqvist"))!.state).toBe("at_risk");
    expect((await app.store.events(20, "v-thu-lindqvist")).find((e) => e.type === "hold.failed")?.data).toMatchObject({ issue: "NO_SAVED_PAYPAL" });
  });

  it("marks a visit at risk when PayPal refuses the card, and records the reason", async () => {
    pp.refuse.add("DEMO-VAULT");
    expect(await placeHold(deps, "v-thu-weber")).toBe("refused: INSTRUMENT_DECLINED");
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("at_risk");
    expect(v.hold).toBeNull();
    expect((await app.store.events(20, "v-thu-weber")).find((e) => e.type === "hold.failed")?.data).toMatchObject({ issue: "INSTRUMENT_DECLINED" });
  });

  it("puts a visit back to scheduled and rethrows when PayPal is busy, so the runner can retry", async () => {
    const busy: TaskDeps = { ...deps, paypal: new BusyPayPal("USD") };
    await expect(placeHold(busy, "v-thu-weber")).rejects.toThrow(/BUSY/);
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.state).toBe("scheduled");
    expect(v.hold).toBeNull();
    expect(await hasEvent("v-thu-weber", "hold.failed")).toBe(false);
  });
});

describe("settling the money", () => {
  it("a retried settlement captures once and pays once", async () => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    const capture = vi.spyOn(pp, "capture");
    const payout = vi.spyOn(pp, "payout");
    expect(await settleMoney(deps, "v-thu-weber")).toMatch(/^money moved: captured \$105\.00/);
    await settleMoney(deps, "v-thu-weber");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(payout).toHaveBeenCalledTimes(1);
    const money = await app.store.moneyRows("v-thu-weber");
    expect(money.filter((m) => m.kind === "capture")).toHaveLength(1);
    expect(money.filter((m) => m.kind === "payout")).toHaveLength(1);
  });

  it("a settlement repeated after the visit is paid moves no money", async () => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    expect(await settleAndFinish("v-thu-weber")).toBe("paid_out");
    const capture = vi.spyOn(pp, "capture");
    const payout = vi.spyOn(pp, "payout");
    expect(await settleMoney(deps, "v-thu-weber")).toBe("already settled (paid_out)");
    expect(capture).not.toHaveBeenCalled();
    expect(payout).not.toHaveBeenCalled();
  });

  it("says there is no outcome yet for a visit that has not ended", async () => {
    await placeHold(deps, "v-thu-weber");
    expect(await settleMoney(deps, "v-thu-weber")).toBe("no outcome yet");
    expect(await settleMoney(deps, "v-nope")).toBe("no such visit");
  });

  it("a visit whose hold failed captures nothing and records what is owed", async () => {
    await app.store.updateVisit("v-fri-haddad", { state: "settling", outcome: { type: "cancel", by: "household", minutesBefore: 60, assigned: ["lena"] } });
    const capture = vi.spyOn(pp, "capture");
    const voided = vi.spyOn(pp, "void");
    await settleMoney(deps, "v-fri-haddad");
    expect(capture).not.toHaveBeenCalled();
    expect(voided).not.toHaveBeenCalled();
    const v = (await app.store.visit("v-fri-haddad"))!;
    expect(v.capture).toBeNull();
    expect(v.settlement).toMatchObject({ holdCents: 0, captureCents: 0, dueCents: 5250 });
  });

  it("with nobody to cover, voids the hold and records the void", async () => {
    await readyToSettle("v-thu-weber", { type: "member_absent" });
    expect(await settleMoney(deps, "v-thu-weber")).toMatch(/^money moved: captured \$0\.00, released \$122\.50/);
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.void).toMatchObject({ status: "VOIDED" });
    expect((await app.store.moneyRows("v-thu-weber")).filter((m) => m.kind === "void")).toEqual([expect.objectContaining({ cents: 12250, status: "VOIDED" })]);
    expect(await hasEvent("v-thu-weber", "payment.voided")).toBe(true);
  });

  it.each([
    ["an issue that names the void", "AUTHORIZATION_VOIDED"],
    ["a void that PayPal says is not allowed", "VOID_NOT_ALLOWED"],
  ])("a void refused with %s is recorded and not thrown", async (_label, issue) => {
    await readyToSettle("v-thu-weber", { type: "member_absent" });
    vi.spyOn(pp, "void").mockRejectedValueOnce(new PayPalError("void", 422, issue));
    await settleMoney(deps, "v-thu-weber");
    expect((await app.store.visit("v-thu-weber"))!.void).toMatchObject({ status: issue });
  });

  it.each([
    ["DUPLICATE_SENDER_BATCH_ID", "DUPLICATE_SENDER_BATCH_ID"],
    ["a batch that already exists", "sender batch id already exists"],
  ])("a payout refused as %s is recorded as sent earlier", async (_label, issue) => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    vi.spyOn(pp, "payout").mockRejectedValueOnce(new PayPalError("payout", 400, issue));
    expect(await settleMoney(deps, "v-thu-weber")).toMatch(/^money moved/);
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.payout).toMatchObject({ batchId: "", status: "SENT_EARLIER", items: [expect.objectContaining({ memberId: "lena", cents: 9975 })] });
    expect(await hasEvent("v-thu-weber", "payout.duplicate_refused")).toBe(true);
  });

  it("when a payout was made but its record was lost, PayPal refuses the second payout and it is recorded", async () => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    await settleMoney(deps, "v-thu-weber");
    await app.store.updateVisit("v-thu-weber", { payout: null });
    await settleMoney(deps, "v-thu-weber");
    expect((await app.store.visit("v-thu-weber"))!.payout?.status).toBe("SENT_EARLIER");
    expect((await app.store.moneyRows("v-thu-weber")).filter((m) => m.kind === "capture")).toHaveLength(1);
    expect(await hasEvent("v-thu-weber", "payout.duplicate_refused")).toBe(true);
  });

  it("a capture that PayPal refuses is rethrown, and nothing is recorded", async () => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    vi.spyOn(pp, "capture").mockRejectedValueOnce(new PayPalError("capture", 500, "INTERNAL_SERVICE_ERROR"));
    await expect(settleMoney(deps, "v-thu-weber")).rejects.toThrow(/INTERNAL_SERVICE_ERROR/);
    const v = (await app.store.visit("v-thu-weber"))!;
    expect(v.capture).toBeNull();
    expect(v.payout).toBeNull();
  });
});

describe("waiting for the payout", () => {
  it("is done when there is no payout to wait for", async () => {
    expect(await pollPayout(deps, "v-thu-weber")).toBe(true);
  });

  it("is not done while PayPal still reports the batch pending", async () => {
    pp.payoutDelayMs = 60_000;
    await readyToSettle("v-thu-weber", checkoutOutcome());
    await settleMoney(deps, "v-thu-weber");
    expect(await pollPayout(deps, "v-thu-weber")).toBe(false);
    expect((await app.store.visit("v-thu-weber"))!.payout?.finalAt).toBeUndefined();
  });

  it("is done once the batch is final and every item has its transaction id", async () => {
    await readyToSettle("v-thu-weber", checkoutOutcome());
    await settleMoney(deps, "v-thu-weber");
    expect(await pollPayout(deps, "v-thu-weber")).toBe(true);
    const p = (await app.store.visit("v-thu-weber"))!.payout!;
    expect(p.status).toBe("SUCCESS");
    expect(p.finalAt).toEqual(expect.any(Number));
    expect(p.items).toEqual([expect.objectContaining({ memberId: "lena", status: "SUCCESS", transactionId: expect.any(String) })]);
    expect(await hasEvent("v-thu-weber", "payout.final")).toBe(true);
  });

  it("is done after payoutWaitMs has passed, even when PayPal has not finished", async () => {
    pp.payoutDelayMs = 60_000;
    await readyToSettle("v-thu-weber", checkoutOutcome());
    await settleMoney(deps, "v-thu-weber");
    const v = (await app.store.visit("v-thu-weber"))!;
    await app.store.updateVisit("v-thu-weber", { payout: { ...v.payout!, sentMs: Date.now() - 600_000 } });
    expect(await pollPayout(deps, "v-thu-weber")).toBe(true);
    expect((await app.store.visit("v-thu-weber"))!.payout?.finalAt).toBeUndefined();
  });

  it("keeps polling a SUCCESS batch until its transaction ids arrive", async () => {
    const lag = new LaggingPayPal("USD");
    lag.payoutDelayMs = 0;
    const lagDeps: TaskDeps = { store: app.store, paypal: lag, payoutPollMs: 1 };
    await placeHold(lagDeps, "v-thu-weber");
    await app.store.updateVisit("v-thu-weber", { state: "settling", outcome: checkoutOutcome() });
    await settleMoney(lagDeps, "v-thu-weber");
    expect(await pollPayout(lagDeps, "v-thu-weber")).toBe(false);
    expect((await app.store.visit("v-thu-weber"))!.payout?.finalAt).toBeUndefined();
    lag.trailing = false;
    expect(await pollPayout(lagDeps, "v-thu-weber")).toBe(true);
    expect((await app.store.visit("v-thu-weber"))!.payout?.items[0]?.transactionId).toEqual(expect.any(String));
  });
});

describe("finishing a visit", () => {
  it("says there is nothing to finish until the visit has settled", async () => {
    expect(await finishVisit(deps, "v-thu-weber")).toBe("nothing to finish");
  });

  it.each<[string, VisitState, () => Promise<void>]>([
    [
      "a late cancellation that kept a fee",
      "late_cancel",
      async () => {
        await readyToSettle("v-thu-weber", { type: "cancel", by: "household", minutesBefore: 60, assigned: ["lena"] });
      },
    ],
    [
      "a visit that was checked out and paid",
      "paid_out",
      async () => {
        await readyToSettle("v-thu-weber", checkoutOutcome());
      },
    ],
    [
      "a cancellation with notice",
      "cancelled",
      async () => {
        await readyToSettle("v-thu-weber", { type: "cancel", by: "household", minutesBefore: 2000, assigned: ["lena"] });
      },
    ],
    [
      "an absence that nobody covered",
      "voided",
      async () => {
        await readyToSettle("v-thu-weber", { type: "member_absent" });
      },
    ],
    [
      "a capture the cooperative keeps whole, with no payout",
      "captured",
      async () => {
        await readyToSettle("v-thu-weber", checkoutOutcome());
        await app.store.updateVisit("v-thu-weber", { terms: { ...(await app.store.visit("v-thu-weber"))!.terms, coopShareBps: 10_000 } });
      },
    ],
  ])("%s finishes as %s", async (_label, state, setup) => {
    await setup();
    expect(await settleAndFinish("v-thu-weber")).toBe(state);
  });
});

describe("matching PayPal's payout items", () => {
  const ours = [
    { memberId: "lena", cents: 9975, wallet: "PAYPAL" as const, status: "PENDING" },
    { memberId: "sam", cents: 100, wallet: "VENMO" as const, status: "PENDING" },
  ];

  it("matches by the sender item id, so the order PayPal answers in does not matter", () => {
    const theirs = [
      { itemId: "v-thu-weber-sam", transactionId: "TXN-SAM", status: "SUCCESS" },
      { itemId: "v-thu-weber-lena", transactionId: "TXN-LENA", status: "SUCCESS" },
    ];
    const merged = mergePayoutItems("v-thu-weber", ours, theirs);
    expect(merged).toEqual([
      expect.objectContaining({ memberId: "lena", transactionId: "TXN-LENA", status: "SUCCESS" }),
      expect.objectContaining({ memberId: "sam", transactionId: "TXN-SAM", status: "SUCCESS" }),
    ]);
  });

  it("keeps our own record for an item PayPal has not reported", () => {
    const merged = mergePayoutItems("v-thu-weber", ours, [{ itemId: "v-thu-weber-lena", transactionId: "TXN-LENA", status: "SUCCESS" }]);
    expect(merged[1]).toEqual(expect.objectContaining({ memberId: "sam", status: "PENDING" }));
    expect(merged[1]?.transactionId).toBeUndefined();
  });
});

describe("the hold window", () => {
  const start = THU + hm("09:00");

  it("counts a visit as due exactly when the window opens", async () => {
    expect((await dueForHold(app.store, start - LEAD)).map((v) => v.id)).toContain("v-thu-okafor");
  });

  it("does not count a visit as due one minute before the window opens", async () => {
    expect((await dueForHold(app.store, start - LEAD - 1)).map((v) => v.id)).not.toContain("v-thu-okafor");
  });

  it("does not count a visit that has already started", async () => {
    expect((await dueForHold(app.store, start)).map((v) => v.id)).not.toContain("v-thu-okafor");
  });

  it("does not count a visit with no member", async () => {
    await app.store.updateVisit("v-thu-okafor", { memberIds: [] });
    expect((await dueForHold(app.store, start - LEAD)).map((v) => v.id)).not.toContain("v-thu-okafor");
  });

  it("does not count a visit that is no longer scheduled", async () => {
    await app.store.updateVisit("v-thu-okafor", { state: "held" });
    expect((await dueForHold(app.store, start - LEAD)).map((v) => v.id)).not.toContain("v-thu-okafor");
  });
});
