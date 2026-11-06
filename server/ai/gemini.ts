// One gateway for every model call. Order: a committed recording (the demo inputs), the cache, then a
// live Gemini API call when allowed. A live call is refused after COVERED_AI_UNTIL, past the daily call
// cap or past a visitor's hourly allowance; callers then take their deterministic path. The key stays
// on the server. On the free tier a busy model is skipped after one attempt and the next one is tried.
import { createHash } from "node:crypto";
import recorded from "../../data/ai-recordings.json" with { type: "json" };
import type { Config } from "../core.ts";
import type { Store } from "../store.ts";

const RECORDINGS = recorded as unknown as Record<string, { output: unknown; model: string }>;

export class AIUnavailable extends Error {}

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export type Tier = "main" | "light";

export interface CallMeta {
  source: "recorded" | "cached" | "live";
  model: string;
  ms: number;
}

export class Gemini {
  private visitors = new Map<string, number[]>();
  last: CallMeta | null = null;
  record = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.COVERED_RECORD === "1";

  constructor(
    private cfg: Config,
    private store: Store,
  ) {}

  get live(): boolean {
    return Boolean(this.cfg.geminiKey);
  }

  private key(task: string, payload: unknown): string {
    return createHash("sha256")
      .update(task + JSON.stringify(payload))
      .digest("hex")
      .slice(0, 32);
  }

  private async lookup(task: string, key: string): Promise<{ output: unknown; model: string } | null> {
    const j = RECORDINGS[`${task}/${key}`];
    if (j) {
      this.last = { source: "recorded", model: j.model, ms: 0 };
      return j;
    }
    const r = await this.store.db.query<{ output: unknown; model: string }>("select output, model from ai_cache where key = $1", [key]);
    if (r[0]) {
      this.last = { source: "cached", model: r[0].model, ms: 0 };
      return r[0];
    }
    return null;
  }

  private async keep(task: string, key: string, model: string, output: unknown, usage: unknown, ms: number) {
    await this.store.db.query("insert into ai_cache(key, task, model, output, usage, ms) values ($1,$2,$3,$4,$5,$6) on conflict (key) do nothing", [
      key,
      task,
      model,
      JSON.stringify(output),
      JSON.stringify(usage ?? null),
      ms,
    ]);
    if (this.record) {
      // recording the demo path's answers is a local step (COVERED_RECORD=1), never run on the deployed service
      RECORDINGS[`${task}/${key}`] = { task, model, ms, usage, output } as (typeof RECORDINGS)[string];
      const { writeFileSync } = await import("node:fs");
      const sorted = Object.fromEntries(Object.entries(RECORDINGS).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(new URL("../../data/ai-recordings.json", import.meta.url), `${JSON.stringify(sorted, null, 1)}\n`);
    }
  }

  private async allow(visitor?: string): Promise<void> {
    if (!this.cfg.geminiKey) throw new AIUnavailable("no model key");
    const today = new Date().toISOString().slice(0, 10);
    if (this.cfg.aiUntil && today > this.cfg.aiUntil) throw new AIUnavailable("after the live-model end date");
    const used = (await this.store.kvGet<number>(`ai_calls:${today}`)) ?? 0;
    if (used >= this.cfg.aiDailyCalls) throw new AIUnavailable("daily model allowance used");
    if (visitor) {
      const now = Date.now();
      const hits = (this.visitors.get(visitor) ?? []).filter((t) => now - t < 3600_000);
      if (hits.length >= 40) throw new AIUnavailable("visitor allowance used");
      hits.push(now);
      this.visitors.set(visitor, hits);
    }
    await this.store.kvSet(`ai_calls:${today}`, used + 1);
  }

  private async post(tier: Tier, body: unknown): Promise<{ res: Record<string, unknown>; model: string; ms: number }> {
    // free-tier quotas are per model: a busy main model falls back through the others, then to the light one
    const chain = [
      ...new Set(tier === "main" ? [this.cfg.modelMain, ...this.cfg.modelFallbacks, this.cfg.modelLight] : [this.cfg.modelLight, ...this.cfg.modelFallbacks]),
    ];
    let why = "no model";
    for (const model of chain) {
      const t0 = performance.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": this.cfg.geminiKey!, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.modelTimeoutS * 1000),
        });
        if (r.status >= 500 || r.status === 429) {
          why = `model busy ${r.status}`;
          continue;
        }
        if (!r.ok) {
          why = `model error ${r.status}: ${(await r.text()).slice(0, 200)}`;
          continue;
        }
        return { res: (await r.json()) as Record<string, unknown>, model, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        why = `model unreachable: ${(e as Error).name}`;
      }
    }
    throw new AIUnavailable(why);
  }

  /** Structured output against a JSON schema (Gemini's OpenAPI subset). */
  async json<T>(task: string, tier: Tier, system: string, parts: Part[], schema: object, visitor?: string): Promise<T> {
    const model = tier === "main" ? this.cfg.modelMain : this.cfg.modelLight;
    const key = this.key(task, { system, parts, schema, model });
    const hit = await this.lookup(task, key);
    if (hit) return hit.output as T;
    await this.allow(visitor);
    const {
      res,
      model: used,
      ms,
    } = await this.post(tier, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.2,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    });
    const cand = (res.candidates as { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] | undefined)?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new AIUnavailable("answer cut off");
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    let out: T;
    try {
      out = JSON.parse(text) as T;
    } catch {
      throw new AIUnavailable("unparsable model output");
    }
    await this.keep(task, key, used, out, res.usageMetadata, ms);
    this.last = { source: "live", model: used, ms };
    return out;
  }

  /** One function-calling turn; returns the model's content unchanged so thought signatures go back. */
  async turn(
    task: string,
    system: string,
    contents: unknown[],
    tools: object[],
    visitor?: string,
  ): Promise<{ role: string; parts: Record<string, unknown>[] }> {
    const key = this.key(task, { system, contents, tools, model: this.cfg.modelMain });
    const hit = await this.lookup(task, key);
    if (hit) return hit.output as { role: string; parts: Record<string, unknown>[] };
    await this.allow(visitor);
    const { res, model, ms } = await this.post("main", {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "LOW" } },
    });
    const content = (res.candidates as { content?: { role: string; parts: Record<string, unknown>[] } }[] | undefined)?.[0]?.content;
    if (!content?.parts?.length) throw new AIUnavailable("empty model turn");
    await this.keep(task, key, model, content, res.usageMetadata, ms);
    this.last = { source: "live", model, ms };
    return content;
  }

  async usage() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.store.db.query<{ task: string; model: string; n: string; ms: string }>(
      "select task, model, count(*) as n, avg(ms) as ms from ai_cache group by task, model order by task",
    );
    return {
      live: this.live,
      until: this.cfg.aiUntil,
      callsToday: (await this.store.kvGet<number>(`ai_calls:${today}`)) ?? 0,
      dailyCap: this.cfg.aiDailyCalls,
      byTask: rows,
    };
  }
}

/** Every number a model writes must be one the code gave it. Times like 09:00 and money like $140.00 count. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ""));
}

export function numbersOk(text: string, allowed: (string | number)[]): boolean {
  const ok = new Set<string>();
  for (const a of allowed) {
    for (const n of numbersIn(String(a))) {
      ok.add(n);
      ok.add(n.replace(/^0(\d)/, "$1")); // 09:00 ~ 9:00
      if (n.includes(".")) ok.add(n.replace(/\.00$/, ""));
    }
  }
  return numbersIn(text).every((n) => ok.has(n) || ok.has(n.replace(/^0(\d)/, "$1")) || ok.has(n.replace(/\.00$/, "")));
}
