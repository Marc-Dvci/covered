// Durability check on the deployed service: the settlement crashes once after the capture and before the payout,
// Cloudflare Workflows retries the step, and PayPal itself is then asked to repeat each money step. It uses the demo
// on the live site, so it resets the week first. Writes docs/durability-sandbox.json.
//   LIVE_URL=https://covered-coop.pages.dev PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… npx tsx scripts/durability.ts
import { writeFileSync } from "node:fs";
import { SandboxPayPal } from "../server/paypal/sandbox.ts";
import { PayPalError } from "../server/paypal/types.ts";
import { hm } from "../shared/seed.ts";

const { LIVE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_CURRENCY = "USD" } = process.env;
if (!LIVE_URL || !PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("needs LIVE_URL, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  process.exit(2);
}
const THU = 3 * 1440;
const id = "v-thu-weber";
const member = "lena";
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(LIVE_URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};
interface VisitView {
  visit: {
    state: string;
    capture: { captureId: string; cents: number } | null;
    hold: { authorizationId: string; cents: number } | null;
    settlement: { releaseCents: number } | null;
    payout: { status: string; batchId: string; finalMs?: number; items: { transactionId?: string }[] } | null;
  };
  money: { kind: string; paypal_id: string | null }[];
  events: { type: string; data: Record<string, unknown> }[];
}
const view = async () => (await (await fetch(`${LIVE_URL}/api/visits/${id}`)).json()) as VisitView;
const until = async (what: string, ok: (v: VisitView) => boolean) => {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const v = await view();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const t0 = Date.now();
await post("/api/demo/reset");
await until("the hold", (v) => v.visit.state === "held");
await post("/api/clock", { at: THU + hm("10:00") });
await post(`/api/visits/${id}/checkin`, { memberId: member });
await post("/api/demo/crash-next-settle", { visitId: id });
await post("/api/clock", { at: THU + hm("13:00") });
await post(`/api/visits/${id}/checkout`, { memberId: member });
const v = await until("the settlement", (x) => x.visit.state === "paid_out" && x.visit.payout?.status === "SUCCESS");

const pp = new SandboxPayPal(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_CURRENCY);
const tryAgain = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ACCEPTED";
  } catch (e) {
    return e instanceof PayPalError ? `${e.status} ${e.issue}` : String(e);
  }
};
const fresh = `durability-${Date.now()}`;
const secondCapture = await tryAgain(() => pp.capture(v.visit.hold!.authorizationId, 100, fresh, fresh, true));
const batch = await pp.getPayout(v.visit.payout!.batchId);
const secondPayout = await tryAgain(() =>
  pp.payout(
    batch.senderBatchId,
    [{ itemId: `${id}-${member}`, receiver: "nobody@example.com", wallet: "PAYPAL", cents: 100, note: "should be refused" }],
    "should be refused",
  ),
);

const runs = v.events.filter((e) => e.type === "task.run").reverse();
const out = {
  ranAt: new Date().toISOString(),
  site: LIVE_URL,
  currency: PAYPAL_CURRENCY,
  runner: "Cloudflare Workflows",
  visit: id,
  state: v.visit.state,
  crashes: v.events.filter((e) => e.type === "task.crashed").length,
  workflowRuns: runs.map((r) => ({ task: r.data.task, instance: r.data.runId, status: r.data.status, detail: r.data.detail })),
  authorization: v.visit.hold?.authorizationId,
  capture: v.visit.capture,
  releasedCents: v.visit.settlement?.releaseCents,
  payout: { batchId: batch.batchId, status: batch.status, finalMs: v.visit.payout?.finalMs, transactionId: v.visit.payout?.items[0]?.transactionId },
  moneyRows: {
    captures: v.money.filter((m) => m.kind === "capture").length,
    payoutBatches: new Set(v.money.filter((m) => m.kind === "payout").map((m) => m.paypal_id)).size,
  },
  paypalRefusesSecondCapture: secondCapture,
  paypalRefusesSecondPayoutBatch: secondPayout,
  seconds: Math.round((Date.now() - t0) / 1000),
};
writeFileSync("docs/durability-sandbox.json", `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
const pass =
  out.crashes === 1 &&
  out.moneyRows.captures === 1 &&
  out.moneyRows.payoutBatches === 1 &&
  runs.some((r) => r.data.status === "retrying") &&
  secondCapture !== "ACCEPTED" &&
  secondPayout !== "ACCEPTED" &&
  batch.status === "SUCCESS";
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
