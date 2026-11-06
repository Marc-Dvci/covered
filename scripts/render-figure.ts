// Renders docs/architecture.svg to docs/architecture.png at 2x, on white.
//   npx tsx scripts/render-figure.ts
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const svg = readFileSync("docs/architecture.svg", "utf8");
const [, width, height] = svg.match(/width="(\d+)" height="(\d+)"/)!;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
await page.screenshot({ path: "docs/architecture.png" });
await browser.close();
