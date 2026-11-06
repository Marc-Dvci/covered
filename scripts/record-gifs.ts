// Records the README's GIFs and stills from the real product on LIVE_URL, headless. Frames come from Chrome's
// screencast, so there is no browser chrome and no cursor. Waiting on PayPal is cut: a frame is held for at most
// 1.2 s. Needs ffmpeg on the PATH.
//   LIVE_URL=https://covered-coop.pages.dev npx tsx scripts/record-gifs.ts
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hm } from "../shared/seed.ts";

const base = process.env.LIVE_URL ?? "http://localhost:8787";
const THU = 3 * 1440;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body: unknown = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const held = async () => {
  for (let i = 0; i < 60; i++) {
    const b = (await (await fetch(`${base}/api/board`)).json()) as { visits: { state: string }[] };
    if (!b.visits.some((v) => v.state === "holding")) return;
    await sleep(1000);
  }
};

mkdirSync("docs/gif", { recursive: true });
mkdirSync("docs/screens", { recursive: true });

interface Clip {
  session: CDPSession;
  dir: string;
  frames: { file: string; at: number }[];
}

async function start(page: Page): Promise<Clip> {
  const session = await page.context().newCDPSession(page);
  const clip: Clip = { session, dir: mkdtempSync(join(tmpdir(), "covered-gif-")), frames: [] };
  session.on("Page.screencastFrame", (f) => {
    const file = join(clip.dir, `f${String(clip.frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    clip.frames.push({ file, at: f.metadata.timestamp ?? Date.now() / 1000 });
    void session.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  });
  const size = page.viewportSize()!;
  await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: size.width * 2, maxHeight: size.height * 2 });
  return clip;
}

async function finish(
  clip: Clip,
  out: string,
  width: number,
  box: { x: number; y: number; width: number; height: number } | null,
  viewportWidth: number,
  colors = 128,
) {
  await sleep(600);
  await clip.session.send("Page.stopScreencast");
  // a screenshot taken during the clip changes the frame size for a moment: those frames are dropped
  const size = (file: string) => readFileSync(file).subarray(16, 24).toString("hex");
  const first = size(clip.frames[0]!.file);
  clip.frames = clip.frames.filter((f) => size(f.file) === first);
  const list = clip.frames.map((f, i) => {
    const next = clip.frames[i + 1]?.at ?? f.at + 1.5;
    return `file '${f.file.replace(/\\/g, "/")}'\nduration ${Math.min(1.2, Math.max(0.02, next - f.at)).toFixed(3)}`;
  });
  list.push(`file '${clip.frames.at(-1)!.file.replace(/\\/g, "/")}'`);
  const listFile = join(clip.dir, "list.txt");
  writeFileSync(listFile, list.join("\n"));
  const png = readFileSync(clip.frames[0]!.file); // PNG header: the frame's real size
  const scale = png.readUInt32BE(16) / viewportWidth;
  const frameH = png.readUInt32BE(20);
  const crop = box
    ? `crop=${Math.round(box.width * scale)}:${Math.min(Math.round(box.height * scale), frameH - Math.round(box.y * scale))}:${Math.round(box.x * scale)}:${Math.round(box.y * scale)},`
    : "";
  const filter = `${crop}fps=12,scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-filter_complex", filter, out]);
  rmSync(clip.dir, { recursive: true, force: true });
  console.log(out, `${(statSync(out).size / 1048576).toFixed(2)} MB`, `${clip.frames.length} frames`);
}

async function drag(page: Page, visit: string, member: string, hold: number) {
  const bar = (await page.locator(`.b-sch-event-wrap[data-event-id="${visit}"]`).first().boundingBox())!;
  const row = (await page.locator(`.b-timeline-sub-grid .b-grid-row[data-id="${member}"]`).boundingBox())!;
  const x = bar.x + bar.width / 2;
  await page.mouse.move(x, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, bar.y + bar.height / 2 + 14, { steps: 5 });
  await page.mouse.move(x, row.y + row.height / 2, { steps: 24 });
  await sleep(hold);
  return { x, row };
}

const browser = await chromium.launch();
const wide = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const board = await wide.newPage();

// ---- the drag guard
await post("/api/demo/reset");
await held();
let guards = board.waitForResponse((r) => r.url().includes("/api/board/guards"));
await board.goto(`${base}/board`);
await board.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"]').waitFor();
await guards;
await sleep(1200);
const area = (await board.locator(".board-scheduler").boundingBox())!;
let clip = await start(board);
await sleep(500);
await drag(board, "v-thu-okafor", "joy", 2400);
const marek = (await board.locator('.b-timeline-sub-grid .b-grid-row[data-id="marek"]').boundingBox())!;
const startBar = (await board.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"]').first().boundingBox())!;
await board.mouse.move(startBar.x + startBar.width / 2, marek.y + marek.height / 2, { steps: 24 });
await sleep(2200);
await board.mouse.up();
await board.locator(".bar-proposed").first().waitFor();
await sleep(2000);
await finish(clip, "docs/gif/board-drag.gif", 900, area, 1600);

// ---- the agent's plan, approved
await post("/api/demo/reset");
await held();
await board.goto(`${base}/board`);
await board.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"]').waitFor();
await sleep(1200);
const main = (await board.locator(".board-wrap").boundingBox())!;
clip = await start(board);
await sleep(500);
await board.getByRole("button", { name: "Send as member" }).click();
await board.getByRole("button", { name: "Find cover" }).click();
await board.getByRole("heading", { name: /Proposal: 3 of 3 covered/ }).waitFor({ timeout: 90_000 });
await sleep(3000);
await board.screenshot({ path: "docs/screens/board-proposal.png", clip: main });
await board.getByRole("button", { name: "Approve and send" }).click();
await board.locator('.b-sch-event-wrap[data-event-id="v-thu-santos"][data-resource-id="teresa"]').waitFor();
await sleep(2500);
await finish(clip, "docs/gif/agent-plan.gif", 900, main, 1600, 96);

// ---- the phones
const phones = await browser.newContext({ viewport: { width: 460, height: 860 }, deviceScaleFactor: 2 });
const phone = await phones.newPage();
await phone.goto(`${base}/h/okafor`);
await phone.getByRole("button", { name: "Yes, that's fine" }).click();
await phone.getByText("Marek Nowak").first().waitFor();

await post("/api/clock", { at: THU + hm("09:00") });
await phone.goto(`${base}/m/marek`);
const visit = phone.locator('[data-visit="v-thu-okafor"]');
await visit.getByRole("button", { name: "Rozpocznij" }).waitFor();
await sleep(800);
const screen = (await phone.locator(".phone").boundingBox())!;
const frame = { x: screen.x, y: screen.y, width: screen.width, height: Math.min(screen.height, 860 - screen.y) };
clip = await start(phone);
await sleep(700);
await visit.getByRole("button", { name: "Rozpocznij" }).click();
await visit.getByRole("button", { name: "Zakończ" }).waitFor();
await sleep(1200);
await post("/api/clock", { at: THU + hm("13:05") });
await sleep(2500);
await visit.getByRole("button", { name: "Zakończ" }).click();
await visit.locator(".chip.s-paid_out").waitFor({ timeout: 120_000 });
await sleep(2500);
await finish(clip, "docs/gif/phone-paid.gif", 400, frame, 460);

await post("/api/clock", { at: THU + hm("13:30") });
await phone.goto(`${base}/h/lindqvist`);
const cancelVisit = phone.locator('[data-visit="v-thu-lindqvist"]');
await cancelVisit.getByRole("button", { name: "Cancel…" }).waitFor();
await sleep(800);
const screen2 = (await phone.locator(".phone").boundingBox())!;
clip = await start(phone);
await sleep(700);
await cancelVisit.getByRole("button", { name: "Cancel…" }).click();
await sleep(2600);
await phone.getByRole("button", { name: "Cancel the visit" }).click();
await phone
  .getByText(/late-cancel fee/)
  .first()
  .waitFor({ timeout: 120_000 });
await sleep(2500);
await finish(
  clip,
  "docs/gif/phone-cancel.gif",
  400,
  { x: screen2.x, y: screen2.y, width: screen2.width, height: Math.min(screen2.height, 860 - screen2.y) },
  460,
);

await browser.close();
