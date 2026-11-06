// Runs the deployed shape locally in Cloudflare's own runtime (workerd, through wrangler dev), with no account and
// no keys: the Worker, the Durable Object ledger and the Workflows. It resets the demo, waits for the holds placed by
// Workflows on the PayPal stand-in, then settles one visit and waits for its payout.
import { spawn, spawnSync } from "node:child_process";

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const THU = 3 * 1440;
const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--var", "COVERED_PUBLIC_URL:" + BASE], {
  shell: true,
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});
const stopWrangler = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(wrangler.pid), "/T", "/F"]);
  else process.kill(-wrangler.pid!, "SIGTERM");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<Record<string, unknown>>;
};
interface Board {
  visits: { id: string; state: string; capture: { cents: number } | null; payout: { status: string } | null }[];
  mode: { runner: string; paypal: string };
}
const board = async () => (await (await fetch(`${BASE}/api/board`)).json()) as Board;

async function until<T>(what: string, seconds: number, read: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + seconds * 1000;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await read();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

let code = 1;
try {
  await until("the worker", 90, async () => (await fetch(`${BASE}/api/health`)).ok);
  const { holdsStarted } = await post("/api/demo/reset");
  console.log(`reset: ${String(holdsStarted)} holds started`);
  const b = await until("every hold", 90, async () => {
    const x = await board();
    return x.visits.some((v) => v.state === "holding") ? null : x;
  });
  if (b.mode.runner !== "cloudflare") throw new Error(`runner is ${b.mode.runner}`);
  const held = b.visits.filter((v) => v.state === "held").length;
  if (held !== holdsStarted) throw new Error(`${String(holdsStarted)} holds started, ${held} held`);
  await post("/api/clock", { at: THU + 10 * 60 });
  await post("/api/visits/v-thu-weber/checkin", { memberId: "lena" });
  await post("/api/clock", { at: THU + 13 * 60 });
  await post("/api/visits/v-thu-weber/checkout", { memberId: "lena" });
  const v = await until("the payout", 90, async () => {
    const x = (await board()).visits.find((y) => y.id === "v-thu-weber");
    return x?.state === "paid_out" ? x : null;
  });
  if (v.capture?.cents !== 10500 || v.payout?.status !== "SUCCESS") throw new Error(`unexpected settlement: ${JSON.stringify(v)}`);
  console.log("PASS: holds placed and a visit settled by Workflows on the Durable Object ledger");
  code = 0;
} catch (e) {
  console.error(`FAIL: ${String(e)}`);
} finally {
  stopWrangler();
  process.exit(code);
}
