// G0 sandbox probe: every PayPal step Covered depends on, run live through the same adapter the
// product uses. Writes probe/RESULTS.md. Reads probe/.env:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_CURRENCY, PROBE_VAULT_ID (a saved PayPal),
//   PROBE_PAYOUT_EMAIL, PROBE_VENMO_PHONE (optional, US only)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxPayPal } from "../server/paypal/sandbox.ts";
import { PayPalError } from "../server/paypal/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const line of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]!] = m[2]!.trim();
}
const pp = new SandboxPayPal(env.PAYPAL_CLIENT_ID!, env.PAYPAL_CLIENT_SECRET!, env.PAYPAL_CURRENCY ?? "USD");
const run = `p${Date.now().toString(36)}`;
const rows: string[] = [];

async function step<T>(name: string, fn: () => Promise<T>, show: (r: T) => string, expectRefusal = false): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    const verdict = expectRefusal ? "FAIL (accepted)" : "PASS";
    rows.push(`| ${name} | ${verdict} | ${ms} ms | ${show(r)} |`);
    console.log(verdict, name, ms, "ms", show(r));
    return r;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const msg = e instanceof PayPalError ? `${e.status} ${e.issue} ${e.debugId ?? ""}` : String(e);
    const verdict = expectRefusal ? "PASS (refused)" : "FAIL";
    rows.push(`| ${name} | ${verdict} | ${ms} ms | ${msg} |`);
    console.log(verdict, name, msg);
    return undefined;
  }
}

const vault = env.PROBE_VAULT_ID!;
// 1. hold, then partial capture with final_capture: the rest must be released
const h1 = await step("hold 30.00 (buyer absent, vaulted PayPal)", () =>
  pp.authorize(vault, 3000, `${run}-a`, "Probe visit A", `${run}-A`), (r) => `auth ${r.authorizationId} ${r.status} expires ${r.expiresAt}`);
if (h1) {
  await step("same hold again with the same request id (idempotent)", () =>
    pp.authorize(vault, 3000, `${run}-a`, "Probe visit A", `${run}-A`), (r) => `auth ${r.authorizationId} (same: ${r.authorizationId === h1.authorizationId})`);
  const c = await step("partial capture 15.00, final (late-cancel fee)", () =>
    pp.capture(h1.authorizationId, 1500, `${run}-a`, `${run}-A`, true), (r) => `capture ${r.captureId} ${r.status} gross ${r.grossCents} fee ${r.paypalFeeCents} net ${r.netCents}`);
  if (c) {
    await step("capture retried with the same request id", () =>
      pp.capture(h1.authorizationId, 1500, `${run}-a`, `${run}-A`, true), (r) => `capture ${r.captureId} (same: ${r.captureId === c.captureId})`);
    await step("second capture on the released remainder", () =>
      pp.capture(h1.authorizationId, 500, `${run}-a2`, `${run}-A2`, true), (r) => `capture ${r.captureId} ${r.status}`, true);
  }
}
// 2. hold, then void (member sick, no cover)
const h2 = await step("hold 20.00", () => pp.authorize(vault, 2000, `${run}-b`, "Probe visit B", `${run}-B`), (r) => `auth ${r.authorizationId}`);
if (h2) await step("void the hold", () => pp.void(h2.authorizationId, `${run}-b`), (r) => r.status);
// 3. hold with extra-time allowance, capture less than held
const h3 = await step("hold 35.00 (30.00 + allowance)", () => pp.authorize(vault, 3500, `${run}-c`, "Probe visit C", `${run}-C`), (r) => `auth ${r.authorizationId}`);
if (h3) await step("capture 32.50, final", () => pp.capture(h3.authorizationId, 3250, `${run}-c`, `${run}-C`, true), (r) => `capture ${r.captureId} gross ${r.grossCents} fee ${r.paypalFeeCents}`);
// 4. payouts
if (env.PROBE_PAYOUT_EMAIL) {
  const p = await step("payout 10.00 to a PayPal email", () =>
    pp.payout(`${run}-pay`, [{ itemId: `${run}-pay-1`, receiver: env.PROBE_PAYOUT_EMAIL!, wallet: "PAYPAL", cents: 1000, note: "Probe visit C" }], "Covered probe payout"),
    (r) => `batch ${r.batchId} ${r.status}`);
  if (p) {
    const t0 = Date.now();
    let last = p.status;
    while (Date.now() - t0 < 90_000 && !["SUCCESS", "DENIED", "CANCELED"].includes(last)) {
      await new Promise((r) => setTimeout(r, 3000));
      last = (await pp.getPayout(p.batchId)).status;
    }
    rows.push(`| payout batch reaches a final state | ${last === "SUCCESS" ? "PASS" : "WAIT"} | ${Date.now() - t0} ms | ${last} |`);
    console.log("payout final", last, Date.now() - t0, "ms");
    await step("same payout batch id again", () =>
      pp.payout(`${run}-pay`, [{ itemId: `${run}-pay-1`, receiver: env.PROBE_PAYOUT_EMAIL!, wallet: "PAYPAL", cents: 1000, note: "Probe visit C" }], "Covered probe payout"),
      (r) => `batch ${r.batchId} (same: ${r.batchId === p.batchId})`, true);
  }
}
if (env.PROBE_VENMO_PHONE) {
  await step("payout 5.00 to a Venmo phone", () =>
    pp.payout(`${run}-venmo`, [{ itemId: `${run}-venmo-1`, receiver: env.PROBE_VENMO_PHONE!, wallet: "VENMO", cents: 500, note: "Probe" }], "Covered probe payout"),
    (r) => `batch ${r.batchId} ${r.status}`);
}
// 5. transaction search over the last 3 days
const end = new Date();
const start = new Date(end.getTime() - 3 * 86400_000);
await step("transaction search, last 3 days", () => pp.transactions(start.toISOString().replace(/\.\d+Z$/, "Z"), end.toISOString().replace(/\.\d+Z$/, "Z")),
  (r) => `${r.length} records; newest ${r.map((x) => x.at).sort().at(-1) ?? "none"}; this run's invoices seen: ${r.filter((x) => x.invoiceId?.startsWith(run)).length}`);

const out = [
  `# Sandbox probe ${run}`,
  "",
  `Run ${new Date().toISOString()}, currency ${pp.currency}.`,
  "",
  "| Step | Result | Time | Detail |",
  "|---|---|---|---|",
  ...rows,
  "",
].join("\n");
writeFileSync(join(here, `RESULTS-${pp.currency}.md`), out);
console.log(`wrote probe/RESULTS-${pp.currency}.md`);
