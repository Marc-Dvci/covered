// Walks the demo story through the real UI in headless Chromium and saves a screenshot per step.
//   npx tsx scripts/walk.ts [baseUrl] [outDir]
import { chromium, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:8787";
const out = process.argv[3] ?? "var/walk";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
let n = 0;
const shot = async (name: string, p: Page = page) => {
  n += 1;
  await p.screenshot({ path: `${out}/${String(n).padStart(2, "0")}-${name}.png`, fullPage: true });
  console.log("shot", name);
};
const post = (path: string, body: unknown = {}) => page.evaluate(async ([p, b]) => (await fetch(p as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(), [path, body] as const);

await page.goto(`${base}/`);
await post("/api/demo/reset");
await shot("home");
await page.goto(`${base}/board`);
await page.waitForSelector(".bar");
await shot("board-0710");
await page.getByRole("button", { name: "Send as member" }).click();
await page.getByRole("button", { name: "Find cover" }).waitFor();
await shot("board-message");
const t0 = Date.now();
await page.getByRole("button", { name: "Find cover" }).click();
await page.getByRole("button", { name: "Approve and send" }).waitFor({ timeout: 120_000 });
console.log("proposal in", Date.now() - t0, "ms");
await page.getByText(/messages, in each person's language/).click();
await shot("board-proposal");
await page.getByRole("button", { name: "Approve and send" }).click();
await page.waitForTimeout(2500);
await shot("board-approved");

await page.goto(`${base}/h/okafor`);
await page.getByRole("button", { name: "Yes, that's fine" }).waitFor();
await shot("okafor-ask");
await page.getByRole("button", { name: "Yes, that's fine" }).click();
await page.waitForTimeout(1500);
await shot("okafor-after");

const clockTo = (hhmm: string) => post("/api/clock", { at: 3 * 1440 + Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) });
const tap = async (visit: string, label: string) => {
  await page.locator(`[data-visit="${visit}"]`).getByRole("button", { name: label }).click();
  await page.waitForTimeout(1500);
};

await clockTo("09:00");
await page.goto(`${base}/m/marek`);
await page.waitForSelector('[data-visit="v-thu-okafor"]');
await tap("v-thu-okafor", "Rozpocznij");
await shot("marek-checked-in");

await clockTo("11:30");
await page.goto(`${base}/h/lindqvist`);
await page.locator('[data-visit="v-thu-lindqvist"]').getByRole("button", { name: "Cancel…" }).click();
await page.getByRole("button", { name: "Cancel the visit" }).waitFor();
await shot("lindqvist-preview");
await page.getByRole("button", { name: "Cancel the visit" }).click();
await page.waitForTimeout(5000);
await shot("lindqvist-receipt");

await clockTo("13:05");
await page.goto(`${base}/m/marek`);
await page.waitForSelector('[data-visit="v-thu-okafor"]');
await tap("v-thu-okafor", "Zakończ");
await page.waitForTimeout(5000);
await shot("marek-paid");

await clockTo("14:00");
await page.goto(`${base}/m/teresa`);
await page.waitForSelector('[data-visit="v-thu-santos"]');
await tap("v-thu-santos", "Entrada");
await clockTo("16:04");
await page.waitForTimeout(2000);
await tap("v-thu-santos", "Saída");
await page.waitForTimeout(5000);
await shot("teresa-paid");

await page.goto(`${base}/h/okafor`);
await page.waitForTimeout(2000);
await shot("okafor-receipt");
await page.goto(`${base}/board`);
await page.waitForTimeout(2500);
await shot("board-afternoon");
await page.goto(`${base}/m/teresa/statement`);
await page.waitForSelector("table");
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Make a link for a landlord" }).click();
const link = await page.locator("a[href*='/s/']").getAttribute("href");
await shot("statement");
await page.goto(link!);
await page.waitForSelector("table");
await shot("landlord");

await page.goto(`${base}/join`);
await page.getByRole("button", { name: "Draft the agreement" }).click();
await page.getByRole("heading", { name: "Draft agreement" }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(500);
await shot("join-draft");
const sign = page.getByRole("button", { name: "Sign and save PayPal" });
if (await sign.isEnabled()) {
  await sign.click();
  await page.waitForURL(/\/h\//, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("join-welcome");
}
await page.goto(`${base}/about`);
await page.waitForTimeout(1500);
await shot("about");
console.log(errors.length ? errors.join("\n") : "no page errors");
await browser.close();
