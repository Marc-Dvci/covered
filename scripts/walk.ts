// Walks Thursday's story through the real UI in headless Chromium, on the site named by LIVE_URL, and records what
// happened in docs/live-run.json. Every PayPal call on the live site is a real sandbox call.
//   LIVE_URL=https://covered-coop.pages.dev npx tsx scripts/walk.ts
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { hm } from "../shared/seed.ts";

const base = process.env.LIVE_URL ?? "http://localhost:8787";
const THU = 3 * 1440;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BoardView {
  mode: Record<string, unknown>;
  visits: {
    id: string;
    state: string;
    hold: { cents: number; authorizationId: string } | null;
    capture: { cents: number; captureId: string; feeCents?: number } | null;
    settlement: { releaseCents: number; coopCents: number } | null;
    payout: { status: string; batchId: string; finalMs?: number; items: { memberId: string; cents: number; transactionId?: string }[] } | null;
  }[];
  events: { type: string; visit_id: string | null; data: { verified?: boolean; type?: string } }[];
}
const board = async () => (await (await fetch(`${base}/api/board`)).json()) as BoardView;
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

const t0 = Date.now();
const reset = (await post("/api/demo/reset")) as { holdsStarted: number };
let b = await board();
while (b.visits.some((v) => v.state === "holding")) {
  await sleep(1000);
  b = await board();
}
const holdsSeconds = (Date.now() - t0) / 1000;
const held = b.visits.filter((v) => v.state === "held");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/board`);
await page.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"]').waitFor();
await page.getByRole("button", { name: "Send as member" }).click();
await page.getByRole("button", { name: "Find cover" }).click();
await page.getByRole("heading", { name: /Proposal: 3 of 3 covered/ }).waitFor({ timeout: 90_000 });
const proposed = await page.locator(".bar-proposed").count();
await page.getByRole("button", { name: "Approve and send" }).click();
await page.locator('.b-sch-event-wrap[data-event-id="v-thu-santos"][data-resource-id="teresa"]').waitFor();

await page.goto(`${base}/h/okafor`);
await page.getByRole("button", { name: "Yes, that's fine" }).click();
await page.getByText("Marek Nowak").first().waitFor();

await post("/api/clock", { at: THU + hm("09:00") });
await page.goto(`${base}/m/marek`);
await page.locator('[data-visit="v-thu-okafor"]').getByRole("button", { name: "Rozpocznij" }).click();
await post("/api/clock", { at: THU + hm("13:05") });
await sleep(500);
const tCheckout = Date.now();
await page.locator('[data-visit="v-thu-okafor"]').getByRole("button", { name: "Zakończ" }).click();
await page.locator('[data-visit="v-thu-okafor"]').getByText("Zapłacone").waitFor({ timeout: 120_000 });
const checkoutToPaid = (Date.now() - tCheckout) / 1000;

await post("/api/clock", { at: THU + hm("13:30") });
await page.goto(`${base}/h/lindqvist`);
await page.locator('[data-visit="v-thu-lindqvist"]').getByRole("button", { name: "Cancel…" }).click();
await page.getByRole("button", { name: "Cancel the visit" }).click();
await page
  .getByText(/late-cancel fee/)
  .first()
  .waitFor({ timeout: 120_000 });
await browser.close();

await sleep(20_000); // PayPal's webhook deliveries arrive on their own time
b = await board();
const money = (id: string) => {
  const v = b.visits.find((x) => x.id === id)!;
  return {
    visit: id,
    state: v.state,
    heldCents: v.hold?.cents,
    authorization: v.hold?.authorizationId,
    capturedCents: v.capture?.cents,
    capture: v.capture?.captureId,
    paypalFeeCents: v.capture?.feeCents,
    releasedCents: v.settlement?.releaseCents,
    cooperativeCents: v.settlement?.coopCents,
    payoutBatch: v.payout?.batchId,
    payoutStatus: v.payout?.status,
    payoutFinalMs: v.payout?.finalMs,
    paidCents: v.payout?.items[0]?.cents,
    payoutTransaction: v.payout?.items[0]?.transactionId,
  };
};
const out = {
  ranAt: new Date().toISOString(),
  site: base,
  mode: b.mode,
  holds: { started: reset.holdsStarted, held: held.length, seconds: Math.round(holdsSeconds) },
  proposedBars: proposed,
  checkoutToPaidSeconds: Math.round(checkoutToPaid),
  visits: [money("v-thu-okafor"), money("v-thu-lindqvist")],
  verifiedWebhooksInTheLast40Events: b.events.filter((e) => e.type === "paypal.webhook" && e.data.verified).length,
  refusedWebhooksInTheLast40Events: b.events.filter((e) => e.type === "paypal.webhook_rejected").length,
  pageErrors: errors,
};
writeFileSync("docs/live-run.json", `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
process.exit(errors.length ? 1 : 0);
