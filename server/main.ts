// The web service: API + the built front end. On first start with an empty database it loads the
// demo cooperative. Without a Render cron job, it sweeps for due holds every 30 seconds itself.
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Gemini } from "./ai/gemini.ts";
import { routes } from "./api.ts";
import { config, loadEnv, makeApp, ROOT, sweep } from "./context.ts";

loadEnv();
const cfg = config();
const app = await makeApp(cfg);
if (!(await app.store.members()).length) {
  await app.store.reset(cfg.demoVaultId);
  await sweep(app);
}
const ai = new Gemini(cfg, app.store);
const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true, bodyLimit: 1024 * 1024 });
routes(server, app, ai);

const dist = join(ROOT, "dist");
if (existsSync(dist)) {
  await server.register(fastifyStatic, { root: dist, wildcard: false });
  server.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
}

if (app.runner.kind === "local" || process.env.COVERED_SWEEP_IN_WEB === "1") {
  setInterval(() => void sweep(app).catch((e) => server.log.error(e)), 30_000).unref();
}

await server.listen({ port: cfg.port, host: "0.0.0.0" });
server.log.info(`Covered on ${cfg.publicUrl}: PayPal ${app.paypal.live ? "sandbox" : "stand-in"}, tasks ${app.runner.kind}, model ${ai.live ? "Gemini" : "recorded only"}`);
