// Runs the demo story against the live model: Sam's message, the agent's proposal, the checks.
import { config, loadEnv, makeApp, sweep } from "../server/context.ts";
import { Gemini } from "../server/ai/gemini.ts";
import { openDisruption, propose } from "../server/dispatch/agent.ts";
import { STORY } from "../shared/seed.ts";

loadEnv();
const cfg = { ...config(), dbFile: null };
const app = await makeApp(cfg);
await app.store.reset();
await sweep(app);
await app.runner.idle();
await app.store.setClock(STORY.messageAt);
const ai = new Gemini(cfg, app.store);
const t0 = performance.now();
const d = await openDisruption(app.store, ai, "sam", STORY.message);
console.log("intake", d.kind, d.affected, ai.last, Math.round(performance.now() - t0), "ms");
const t1 = performance.now();
const p = await propose(app.store, ai, d.id);
console.log("proposal", p.source, p.model, "rank", p.plan.rank, "covered", p.plan.covered, Math.round(performance.now() - t1), "ms");
console.log("turns", JSON.stringify(p.turns.map((t) => t.call)), "rejected", p.rejected);
console.log("why:", p.why);
for (const m of p.messages) console.log(`-> ${m.toId} [${m.language}] ${m.text}\n   (${m.english ?? ""})`);
process.exit(0);
