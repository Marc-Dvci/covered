// Starts the money tasks. On Render they run as Render Workflows task runs (each on its own
// instance, retried by Render). Without a Render API key they run in this process with the same retry
// policy, so the quickstart and the tests exercise the same retry path.
import { Render } from "@renderinc/sdk";
import type { Store } from "./store.ts";
import { placeHold, settleVisit, type TaskDeps, type TaskName } from "./tasks.ts";

export const RETRY = { maxRetries: 3, waitDurationMs: 1000, backoffScaling: 1.5 };

export interface Runner {
  readonly kind: "render" | "local";
  start(task: TaskName, ...args: string[]): Promise<string>;
  idle(): Promise<void>;
}

export const TASKS: Record<Exclude<TaskName, "sweep">, (d: TaskDeps, id: string) => Promise<string>> = { placeHold, settleVisit };

export class LocalRunner implements Runner {
  readonly kind = "local";
  private running = new Set<Promise<unknown>>();
  private seq = 0;
  constructor(private deps: TaskDeps, private waitMs = RETRY.waitDurationMs) {}

  async start(task: TaskName, ...args: string[]): Promise<string> {
    const id = `local-${++this.seq}`;
    const fn = TASKS[task as keyof typeof TASKS];
    const run = (async () => {
      let wait = this.waitMs;
      for (let attempt = 0; attempt <= RETRY.maxRetries; attempt++) {
        try {
          const out = await fn(this.deps, args[0]!);
          await this.log(task, id, attempt, "succeeded", out, args[0]);
          return;
        } catch (e) {
          await this.log(task, id, attempt, attempt < RETRY.maxRetries ? "retrying" : "failed", String((e as Error).message), args[0]);
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

  private async log(task: string, runId: string, attempt: number, status: string, detail: string, visitId?: string) {
    await this.deps.store.event("task.run", visitId ?? null, "workflow", { task, runId, attempt, status, detail, runner: "local" });
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

export class RenderRunner implements Runner {
  readonly kind = "render";
  private render: Render;
  constructor(private store: Store, private slug: string, token: string) {
    this.render = new Render({ token });
  }

  async start(task: TaskName, ...args: string[]): Promise<string> {
    const run = await this.render.workflows.startTask(`${this.slug}/${task}`, args);
    await this.store.event("task.run", args[0] ?? null, "workflow", { task, runId: run.taskRunId, status: "started", runner: "render" });
    return run.taskRunId;
  }

  async idle(): Promise<void> {}
}
