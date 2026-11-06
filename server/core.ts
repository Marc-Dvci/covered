// The running pieces, independent of where they run: configuration, PayPal (sandbox or stand-in), the
// store, and the sweep. server/context.ts wires them for Node; worker/index.ts wires them for Cloudflare.
import { FakePayPal } from "./paypal/fake.ts";
import { SandboxPayPal } from "./paypal/sandbox.ts";
import type { PayPal } from "./paypal/types.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";
import { dueForHold } from "./tasks.ts";

export interface Config {
  dbFile: string | null;
  paypalClientId?: string;
  paypalSecret?: string;
  currency: string;
  webhookId?: string;
  demoVaultId?: string;
  sandboxPayouts: string;
  publicUrl: string;
  demo: boolean;
  demoIdleMinutes: number;
  demoResetsPerDay: number;
  linkSecret: string;
  geminiKey?: string;
  modelMain: string;
  modelLight: string;
  modelFallbacks: string[];
  modelTimeoutS: number;
  aiUntil?: string;
  aiDailyCalls: number;
  port: number;
}

export type Env = Record<string, string | undefined>;

export function config(env: Env): Config {
  return {
    dbFile: env.COVERED_DB_FILE === "memory" ? null : env.COVERED_DB_FILE || "var/covered.db",
    paypalClientId: env.PAYPAL_CLIENT_ID || undefined,
    paypalSecret: env.PAYPAL_CLIENT_SECRET || undefined,
    currency: env.PAYPAL_CURRENCY || "USD",
    webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
    demoVaultId: env.COVERED_DEMO_VAULT_ID || undefined,
    sandboxPayouts: env.COVERED_SANDBOX_PAYOUTS || "",
    publicUrl: (env.COVERED_PUBLIC_URL || "http://localhost:8787").replace(/\/$/, ""),
    demo: env.COVERED_DEMO !== "0",
    demoIdleMinutes: Number(env.COVERED_DEMO_IDLE_MINUTES || 30),
    demoResetsPerDay: Number(env.COVERED_DEMO_RESETS_PER_DAY || 60),
    linkSecret: env.COVERED_LINK_SECRET || "dev-only-secret",
    geminiKey: env.GEMINI_API_KEY || undefined,
    modelMain: env.COVERED_MODEL_MAIN || "gemini-3.6-flash",
    modelLight: env.COVERED_MODEL_LIGHT || "gemini-3.5-flash-lite",
    modelFallbacks: (env.COVERED_MODEL_FALLBACKS ?? "gemini-3.5-flash,gemini-3-flash-preview")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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

/** Start a hold for every visit that has entered its notice window. Called by the cron job and when the demo clock moves. */
export async function sweep(app: Pick<App, "store" | "runner">): Promise<string[]> {
  const due = (await dueForHold(app.store, await app.store.now())).map((v) => v.id);
  if (!due.length) return [];
  await app.store.setStates(due, "holding");
  await app.runner.startMany("placeHold", due);
  return due;
}

/** First start on an empty database: load the demo cooperative and place its first holds. */
export async function seedIfEmpty(app: App): Promise<void> {
  if ((await app.store.members()).length) return;
  await app.store.reset(app.cfg.demoVaultId, app.cfg.sandboxPayouts);
  await sweep(app);
}

/**
 * A judge should land on Thursday 07:10, not on what the last visitor left behind: after a quiet spell the
 * next read of the board reloads the week. A write marks the demo as used; a fresh week has no mark.
 */
export async function refreshIfIdle(app: App, nowMs = Date.now()): Promise<boolean> {
  if (!app.cfg.demo) return false;
  const used = await app.store.kvGet<number>("demo_used_at");
  if (used === null || nowMs - used < app.cfg.demoIdleMinutes * 60_000) return false;
  await app.store.reset(app.cfg.demoVaultId, app.cfg.sandboxPayouts);
  await sweep(app);
  return true;
}
