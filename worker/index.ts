// The deployed service on Cloudflare: the API on a Worker, the ledger in a Durable Object's SQLite database, the
// money steps as Workflows, and a cron trigger that starts the sweep. The Worker has no public address of its
// own: the public site is a Pages project (web front end) that forwards /api/* to it through a service binding.
import "./shim.ts"; // first: see the note in that file
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Hono } from "hono";
import { Gemini } from "../server/ai/gemini.ts";
import { routes } from "../server/api.ts";
import { config, makePayPal, sweep, seedIfEmpty, type App, type Env as Vars } from "../server/core.ts";
import { logRun, RETRY, type Runner } from "../server/runner.ts";
import { Store } from "../server/store.ts";
import { finishVisit, PAYOUT_WAIT_MS, placeHold, pollPayout, settleMoney, type TaskDeps, type TaskName } from "../server/tasks.ts";
import { Ledger, ledgerDb, type LedgerStub } from "./ledger.ts";

export { Ledger };

export interface Env {
  LEDGER: DurableObjectNamespace<Ledger>;
  TASKS: Workflow<TaskParams>;
}
export interface TaskParams {
  task: TaskName;
  visitId: string;
}

const STEP_RETRY = { retries: { limit: RETRY.maxRetries, delay: "1 second", backoff: "exponential" }, timeout: "2 minutes" } as const;
const POLL_SECONDS = 5;

class WorkflowRunner implements Runner {
  readonly kind = "cloudflare";
  constructor(private env: Env, private store: Store) {}

  private params(task: TaskName, visitId: string) {
    return { id: `${task}-${visitId}-${crypto.randomUUID().slice(0, 8)}`, params: { task, visitId } };
  }

  async start(task: TaskName, visitId: string): Promise<string> {
    const run = await this.env.TASKS.create(this.params(task, visitId));
    await logRun(this.store, task, run.id, visitId, 0, "started", "", this.kind);
    return run.id;
  }

  async startMany(task: TaskName, visitIds: string[]): Promise<void> {
    if (visitIds.length) await this.env.TASKS.createBatch(visitIds.map((id) => this.params(task, id)));
  }

  async idle(): Promise<void> {}
}

let built: { app: App; server: Hono } | null = null;

async function build(env: Env): Promise<{ app: App; server: Hono }> {
  if (built) return built;
  const cfg = config(env as unknown as Vars);
  const store = new Store(ledgerDb(() => env.LEDGER.get(env.LEDGER.idFromName("coop"), { locationHint: "enam" }) as unknown as LedgerStub));
  await store.migrate();
  const app: App = { cfg, store, paypal: makePayPal(cfg), runner: new WorkflowRunner(env, store) };
  await seedIfEmpty(app);
  const server = new Hono();
  routes(server, app, new Gemini(cfg, store));
  built = { app, server };
  return built;
}

/** One visit's money task. Every step is persisted by the platform, so a crash resumes after the last finished step. */
export class MoneyTask extends WorkflowEntrypoint<Env, TaskParams> {
  override async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep): Promise<string> {
    const { task, visitId } = event.payload;
    const { app } = await build(this.env);
    const deps: TaskDeps = { store: app.store, paypal: app.paypal };
    const logged = async (fn: () => Promise<string>): Promise<string> => {
      try {
        const out = await fn();
        await logRun(app.store, task, event.instanceId, visitId, 0, "succeeded", out, "cloudflare");
        return out;
      } catch (e) {
        await logRun(app.store, task, event.instanceId, visitId, 0, "retrying", (e as Error).message, "cloudflare");
        throw e;
      }
    };

    if (task === "placeHold") return step.do("place the hold", STEP_RETRY, () => logged(() => placeHold(deps, visitId)));

    const moved = await step.do("capture and pay", STEP_RETRY, () => logged(() => settleMoney(deps, visitId)));
    if (!moved.startsWith("money moved")) return moved;
    for (let i = 0; i * POLL_SECONDS * 1000 < PAYOUT_WAIT_MS; i++) {
      if (await step.do(`check the payout ${i}`, STEP_RETRY, () => pollPayout(deps, visitId))) break;
      await step.sleep(`wait ${i}`, `${POLL_SECONDS} seconds`);
    }
    return step.do("record the outcome", STEP_RETRY, () => finishVisit(deps, visitId));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await build(env)).server.fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(build(env).then(({ app }) => sweep(app)));
  },
} satisfies ExportedHandler<Env>;
