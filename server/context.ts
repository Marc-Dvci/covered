// Builds the running pieces from the environment: database, PayPal (sandbox or stand-in), task runner.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { FakePayPal } from "./paypal/fake.ts";
import { SandboxPayPal } from "./paypal/sandbox.ts";
import type { PayPal } from "./paypal/types.ts";
import { LocalRunner, RenderRunner, type Runner } from "./runner.ts";
import { Store } from "./store.ts";
import { dueForHold } from "./tasks.ts";

export const ROOT = join(import.meta.dirname, "..");

export function loadEnv(file = join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
  }
}

export interface Config {
  databaseUrl?: string;
  dataDir: string | null;
  paypalClientId?: string;
  paypalSecret?: string;
  currency: string;
  demoVaultId?: string;
  publicUrl: string;
  demo: boolean;
  linkSecret: string;
  renderApiKey?: string;
  workflowSlug: string;
  geminiKey?: string;
  modelMain: string;
  modelLight: string;
  modelFallbacks: string[];
  modelTimeoutS: number;
  aiUntil?: string;
  aiDailyCalls: number;
  port: number;
}

export function config(env = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.COVERED_DATA_DIR === "memory" ? null : (env.COVERED_DATA_DIR || join(ROOT, "var", "db")),
    paypalClientId: env.PAYPAL_CLIENT_ID || undefined,
    paypalSecret: env.PAYPAL_CLIENT_SECRET || undefined,
    currency: env.PAYPAL_CURRENCY || "USD",
    demoVaultId: env.COVERED_DEMO_VAULT_ID || undefined,
    publicUrl: (env.COVERED_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "http://localhost:8787").replace(/\/$/, ""),
    demo: env.COVERED_DEMO !== "0",
    linkSecret: env.COVERED_LINK_SECRET || "dev-only-secret",
    renderApiKey: env.RENDER_API_KEY || undefined,
    workflowSlug: env.COVERED_WORKFLOW_SLUG || "covered-workflows",
    geminiKey: env.GEMINI_API_KEY || undefined,
    modelMain: env.COVERED_MODEL_MAIN || "gemini-3.6-flash",
    modelLight: env.COVERED_MODEL_LIGHT || "gemini-3.5-flash-lite",
    modelFallbacks: (env.COVERED_MODEL_FALLBACKS ?? "gemini-3.5-flash,gemini-3-flash-preview").split(",").map((s) => s.trim()).filter(Boolean),
    modelTimeoutS: Number(env.COVERED_MODEL_TIMEOUT_S || 20),
    aiUntil: env.COVERED_AI_UNTIL || "2026-12-21",
    aiDailyCalls: Number(env.COVERED_AI_DAILY_CALLS || 600),
    port: Number(env.PORT || 8787),
  };
}

export function makePayPal(cfg: Config): PayPal {
  if (cfg.paypalClientId && cfg.paypalSecret) return new SandboxPayPal(cfg.paypalClientId, cfg.paypalSecret, cfg.currency);
  return new FakePayPal(cfg.currency);
}

export interface App {
  cfg: Config;
  store: Store;
  paypal: PayPal;
  runner: Runner;
}

export async function makeApp(cfg = config(), paypal?: PayPal): Promise<App> {
  const db = await openDb(cfg.databaseUrl, cfg.dataDir);
  const store = new Store(db);
  await store.migrate();
  const pp = paypal ?? makePayPal(cfg);
  const runner: Runner = cfg.renderApiKey ? new RenderRunner(store, cfg.workflowSlug, cfg.renderApiKey) : new LocalRunner({ store, paypal: pp });
  return { cfg, store, paypal: pp, runner };
}

/** Start a hold for every visit that has entered its notice window. Called by the cron job and when the demo clock moves. */
export async function sweep(app: Pick<App, "store" | "runner">): Promise<string[]> {
  const due = await dueForHold(app.store, await app.store.now());
  for (const v of due) {
    await app.store.updateVisit(v.id, { state: "holding" });
    await app.runner.start("placeHold", v.id);
  }
  return due.map((v) => v.id);
}
