// Node wiring: a SQLite file (or memory), the in-process task runner, and .env loading. Used by the
// quickstart, the tests and the scripts. Cloudflare has its own wiring in worker/index.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config as coreConfig, makePayPal, sweep, seedIfEmpty, refreshIfIdle, type App, type Config, type Env } from "./core.ts";
import type { PayPal } from "./paypal/types.ts";
import { LocalRunner } from "./runner.ts";
import { openSqlite } from "./sqlite.ts";
import { Store } from "./store.ts";

export const ROOT = join(import.meta.dirname, "..");

export function loadEnv(file = join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
  }
}

export const config = (env: Env = process.env): Config => coreConfig(env);

export async function makeApp(cfg: Config = config(), paypal?: PayPal): Promise<App> {
  const db = openSqlite(cfg.dbFile && join(ROOT, cfg.dbFile));
  const store = new Store(db);
  await store.migrate();
  const pp = paypal ?? makePayPal(cfg);
  return { cfg, store, paypal: pp, runner: new LocalRunner({ store, paypal: pp }) };
}

export { sweep, seedIfEmpty, refreshIfIdle, type App, type Config };
