import { beforeEach, describe, expect, it } from "vitest";
import { config, makeApp, type App } from "../server/context.ts";
import { FakePayPal } from "../server/paypal/fake.ts";
import { PayPalError, type Hold } from "../server/paypal/types.ts";
import { LocalRunner, RETRY } from "../server/runner.ts";

class FlakyPayPal extends FakePayPal {
  attempts = 0;
  constructor(private failures: number) {
    super("USD");
  }
  override async authorize(vaultId: string, cents: number, ref: string, description: string, invoiceId: string): Promise<Hold> {
    this.attempts += 1;
    if (this.attempts <= this.failures) throw new PayPalError("authorize", 503, "BUSY");
    return super.authorize(vaultId, cents, ref, description, invoiceId);
  }
}

let app: App;

beforeEach(async () => {
  const pp = new FakePayPal();
  app = await makeApp({ ...config({}), dbFile: null }, pp);
  await app.store.reset();
});

const runnerWith = (pp: FakePayPal) => new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 1 }, 1);

const runLog = async (visitId: string) =>
  (await app.store.events(100, visitId)).filter((e) => e.type === "task.run").reverse().map((e) => e.data);

describe("retrying a failing task", () => {
  it("retries exactly RETRY.maxRetries times, then logs the run as failed", async () => {
    const pp = new FlakyPayPal(Number.POSITIVE_INFINITY);
    const runner = runnerWith(pp);
    await runner.start("placeHold", "v-thu-weber");
    await runner.idle();
    expect(pp.attempts).toBe(RETRY.maxRetries + 1);
    const log = await runLog("v-thu-weber");
    expect(log.map((e) => [e.attempt, e.status])).toEqual([
      ...Array.from({ length: RETRY.maxRetries }, (_, i) => [i, "retrying"]),
      [RETRY.maxRetries, "failed"],
    ]);
    expect(log[RETRY.maxRetries]?.detail).toBe("authorize failed (503 BUSY)");
    expect((await app.store.visit("v-thu-weber"))!.state).toBe("scheduled");
  });

  it("stops retrying once an attempt succeeds, and logs the success", async () => {
    const pp = new FlakyPayPal(2);
    const runner = runnerWith(pp);
    await runner.start("placeHold", "v-thu-weber");
    await runner.idle();
    expect(pp.attempts).toBe(3);
    expect((await runLog("v-thu-weber")).map((e) => [e.attempt, e.status])).toEqual([[0, "retrying"], [1, "retrying"], [2, "succeeded"]]);
    expect((await app.store.visit("v-thu-weber"))!.state).toBe("held");
  });

  it("logs every attempt of one run under the same run id, with the runner's name", async () => {
    const runner = runnerWith(new FlakyPayPal(1));
    await runner.start("placeHold", "v-thu-weber");
    await runner.idle();
    const log = await runLog("v-thu-weber");
    expect(new Set(log.map((e) => e.runId)).size).toBe(1);
    expect(log.every((e) => e.runner === "local" && e.task === "placeHold")).toBe(true);
  });

  it("a task that works first time logs one succeeded attempt with its answer", async () => {
    const runner = runnerWith(new FakePayPal());
    await runner.start("placeHold", "v-thu-weber");
    await runner.idle();
    expect(await runLog("v-thu-weber")).toEqual([expect.objectContaining({ attempt: 0, status: "succeeded", detail: "held $122.50" })]);
  });
});

describe("running several tasks", () => {
  it("startMany runs every visit", async () => {
    const pp = new FakePayPal();
    const runner = runnerWith(pp);
    await runner.startMany("placeHold", ["v-thu-okafor", "v-thu-weber", "v-thu-lindqvist"]);
    await runner.idle();
    for (const id of ["v-thu-okafor", "v-thu-weber", "v-thu-lindqvist"]) expect((await app.store.visit(id))!.state).toBe("held");
  });

  it("idle waits until the started task has finished", async () => {
    const runner = runnerWith(new FakePayPal());
    await runner.start("placeHold", "v-thu-weber");
    await runner.idle();
    expect((await app.store.visit("v-thu-weber"))!.hold).not.toBeNull();
  });

  it("idle returns at once when nothing is running", async () => {
    const runner = runnerWith(new FakePayPal());
    await expect(runner.idle()).resolves.toBeUndefined();
    expect(runner.kind).toBe("local");
  });
});
