// Durability check against the PayPal sandbox: the settlement task crashes once after the capture and
// before the payout, the runner retries it, and PayPal itself is then asked to repeat each money step.
// Writes docs/durability-sandbox.json.
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… COVERED_DEMO_VAULT_ID=… COVERED_SANDBOX_PAYOUTS="*=PAYPAL:receiver@example.com" npx tsx scripts/durability.ts
import { writeFileSync } from "node:fs";
import { checkIn, checkOut } from "../server/actions.ts";
import { config, loadEnv, makeApp } from "../server/context.ts";
import { SandboxPayPal } from "../server/paypal/sandbox.ts";
import { PayPalError } from "../server/paypal/types.ts";
import { LocalRunner } from "../server/runner.ts";

loadEnv();
const cfg = { ...config(), dataDir: null };
if (!cfg.paypalClientId || !cfg.paypalSecret || !cfg.demoVaultId || !cfg.sandboxPayouts) {
  console.error("needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, COVERED_DEMO_VAULT_ID and COVERED_SANDBOX_PAYOUTS");
  process.exit(2);
}
const pp = new SandboxPayPal(cfg.paypalClientId, cfg.paypalSecret, cfg.currency);
const app = await makeApp(cfg, pp);
app.runner = new LocalRunner({ store: app.store, paypal: pp, payoutPollMs: 3000 }, 2000);
await app.store.reset(cfg.demoVaultId, cfg.sandboxPayouts);
const ctx = { store: app.store, runner: app.runner };

const id = "v-thu-weber";
const v0 = (await app.store.visit(id))!;
const member = v0.memberIds[0]!;
const t0 = Date.now();
await app.runner.start("placeHold", id);
await app.runner.idle();
await app.store.setClock(v0.start);
await checkIn(ctx, id, member);
await app.store.kvSet(`crash-after-capture:${id}`, true);
await app.store.setClock(v0.start + v0.minutes);
await checkOut(ctx, id, member, false);
await app.runner.idle();

const v = (await app.store.visit(id))!;
const money = await app.store.moneyRows(id);
const runs = (await app.store.events(50, id)).filter((e) => e.type === "task.run").reverse().map((e) => ({ task: e.data.task, attempt: e.data.attempt, status: e.data.status, detail: e.data.detail }));

// ask PayPal to repeat each step with fresh request ids: it must refuse both
const tryAgain = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ACCEPTED";
  } catch (e) {
    return e instanceof PayPalError ? `${e.status} ${e.issue}` : String(e);
  }
};
const secondCapture = await tryAgain(() => pp.capture(v.hold!.authorizationId, 100, `durability-${Date.now()}`, `durability-${Date.now()}`, true));
const secondPayout = await tryAgain(() => pp.payout(v.payout!.senderBatchId, [{ itemId: `${id}-${member}`, receiver: "nobody@example.com", wallet: "PAYPAL", cents: 100, note: "should be refused" }], "should be refused"));
const batch = await pp.getPayout(v.payout!.batchId);

const out = {
  ranAt: new Date().toISOString(),
  currency: cfg.currency,
  runner: "local (same retry policy as the Render workflow)",
  visit: id,
  state: v.state,
  taskRuns: runs,
  authorization: v.hold?.authorizationId,
  capture: v.capture,
  payout: { batchId: v.payout?.batchId, senderBatchId: v.payout?.senderBatchId, status: batch.status, items: batch.items },
  moneyRows: { captures: money.filter((m) => m.kind === "capture").length, payoutBatches: new Set(money.filter((m) => m.kind === "payout").map((m) => m.paypal_id)).size },
  paypalRefusesSecondCapture: secondCapture,
  paypalRefusesSecondPayoutBatch: secondPayout,
  seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync("docs/durability-sandbox.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
const ok = out.moneyRows.captures === 1 && out.moneyRows.payoutBatches === 1 && runs.some((r) => r.status === "retrying") && secondCapture !== "ACCEPTED" && secondPayout !== "ACCEPTED" && batch.status === "SUCCESS";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
