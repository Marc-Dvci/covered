// Render Workflows entry point: the money tasks, each run on its own instance and retried by Render.
// Deployed as a Workflow service with start command `node --import tsx server/workflows.ts`.
//   sweep        cron calls it every 5 minutes; it starts placeHold for every visit whose notice window opened
//   placeHold    authorize the visit's price + allowance on the household's saved PayPal
//   settleVisit  capture or void per the outcome, then pay the members through Payouts
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { config, loadEnv, makeApp, type App } from "./context.ts";
import { RETRY } from "./runner.ts";
import { dueForHold, placeHold, settleVisit } from "./tasks.ts";

loadEnv();
let app: Promise<App> | null = null;
const deps = () => (app ??= makeApp(config()));

async function logged(name: string, ctx: TaskContext, visitId: string | null, fn: () => Promise<string>): Promise<string> {
  const a = await deps();
  try {
    const out = await fn();
    await a.store.event("task.run", visitId, "workflow", { task: name, runId: ctx.metadata.taskRunId, status: "succeeded", detail: out, runner: "render" });
    return out;
  } catch (e) {
    await a.store.event("task.run", visitId, "workflow", { task: name, runId: ctx.metadata.taskRunId, status: "retrying", detail: (e as Error).message, runner: "render" });
    throw e;
  }
}

const placeHoldTask = task({ name: "placeHold", retry: RETRY, timeoutSeconds: 300 }, async (ctx: TaskContext, visitId: string) => {
  const a = await deps();
  return logged("placeHold", ctx, visitId, () => placeHold({ store: a.store, paypal: a.paypal }, visitId));
});

task({ name: "settleVisit", retry: RETRY, timeoutSeconds: 900 }, async (ctx: TaskContext, visitId: string) => {
  const a = await deps();
  return logged("settleVisit", ctx, visitId, () => settleVisit({ store: a.store, paypal: a.paypal }, visitId));
});

task({ name: "sweep", retry: RETRY, timeoutSeconds: 600 }, async (ctx: TaskContext) => {
  const a = await deps();
  return logged("sweep", ctx, null, async () => {
    const due = await dueForHold(a.store, await a.store.now());
    for (const v of due) await a.store.updateVisit(v.id, { state: "holding" });
    const results = await Promise.all(due.map((v) => ctx.run(placeHoldTask, v.id)));
    return `${due.length} holds: ${results.join("; ")}`;
  });
});
