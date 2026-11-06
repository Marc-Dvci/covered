// The quickstart server on Node: API + the built front end, on a local SQLite file, with no keys needed.
// The deployed service runs the same routes on Cloudflare (worker/index.ts).
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Gemini } from "./ai/gemini.ts";
import { routes } from "./api.ts";
import { config, loadEnv, makeApp, ROOT, seedIfEmpty, sweep } from "./context.ts";

loadEnv();
const cfg = config();
const app = await makeApp(cfg);
await seedIfEmpty(app);
const ai = new Gemini(cfg, app.store);
const server = new Hono();
routes(server, app, ai);

const dist = join(ROOT, "dist");
if (existsSync(dist)) {
  server.use("*", serveStatic({ root: relative(process.cwd(), dist) }));
  server.get("*", async (c) => c.html(await readFile(join(dist, "index.html"), "utf8")));
}

// Cloudflare has a cron trigger; here the same sweep runs on a timer
setInterval(() => void sweep(app).catch((e) => console.error(e)), 30_000).unref();

serve({ fetch: server.fetch, port: cfg.port, hostname: "0.0.0.0" }, () => {
  console.log(
    `Covered on ${cfg.publicUrl}: PayPal ${app.paypal.live ? "sandbox" : "stand-in"}, tasks in process, model ${ai.live ? "Gemini" : "recorded only"}`,
  );
});
