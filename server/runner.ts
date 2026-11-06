// Starts the money tasks. On Cloudflare they run as Workflows (worker/index.ts), each step persisted and
// retried by the platform. On Node they run in this process with the same retry policy, so the quickstart
// and the tests exercise the same retry path.
import type { Store } from "./store.ts";
import { placeHold, settleVisit, type TaskDeps, type TaskName } from "./tasks.ts";

export const RETRY = { maxRetries: 3, waitDurationMs: 1000, backoffScaling: 1.5 };

export interface Runner {
  readonly kind: "cloudflare" | "local";
  start(task: TaskName, visitId: string): Promise<string>;
  startMany(task: TaskName, visitIds: string[]): Promise<void>;
  idle(): Promise<void>;
}

export const TASKS: Record<TaskName, (d: TaskDeps, id: string) => Promise<string>> = { placeHold, settleVisit };

export class LocalRunner implements Runner {
  readonly kind = "local";
  private running = new Set<Promise<unknown>>();
  private seq = 0;
  constructor(private deps: TaskDeps, private waitMs = RETRY.waitDurationMs) {}

  async start(task: TaskName, visitId: string): Promise<string> {
    const id = `local-${++this.seq}`;
    const run = (async () => {
      let wait = this.waitMs;
      for (let attempt = 0; attempt <= RETRY.maxRetries; attempt++) {
        try {
          const out = await TASKS[task](this.deps, visitId);
          await logRun(this.deps.store, task, id, visitId, attempt, "succeeded", out, this.kind);
          return;
        } catch (e) {
          await logRun(this.deps.store, task, id, visitId, attempt, attempt < RETRY.maxRetries ? "retrying" : "failed", (e as Error).message, this.kind);
          if (attempt === RETRY.maxRetries) return;
          await new Promise((r) => setTimeout(r, wait));
          wait *= RETRY.backoffScaling;
        }
      }
    })();
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return id;
  }

  async startMany(task: TaskName, visitIds: string[]): Promise<void> {
    await Promise.all(visitIds.map((id) => this.start(task, id)));
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

export async function logRun(store: Store, task: string, runId: string, visitId: string, attempt: number, status: string, detail: string, runner: string): Promise<void> {
  await store.event("task.run", visitId, "workflow", { task, runId, attempt, status, detail, runner });
}
