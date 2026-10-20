// One small SQL surface over two engines: Postgres (pg) in production, embedded Postgres (PGlite) for
// the no-setup quickstart and the tests. Both take $1-style parameters and return rows.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Db["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(url: string | undefined, dataDir: string | null): Promise<Db> {
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 5, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
    return {
      query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const out = await fn(async (sql, params) => (await c.query(sql, params as unknown[])).rows);
          await c.query("COMMIT");
          return out;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) mkdirSync(dirname(dataDir + "/x"), { recursive: true });
  const db = new PGlite(dataDir ?? undefined);
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows,
    tx: (fn) => db.transaction((t) => fn(async <T>(sql: string, params?: unknown[]) => (await t.query<T>(sql, params)).rows)),
    close: () => db.close(),
  };
}

export const SCHEMA = `
create table if not exists kv (key text primary key, value jsonb not null);
create table if not exists members (id text primary key, data jsonb not null);
create table if not exists households (
  id text primary key, data jsonb not null,
  vault_id text, vault_email text, agreement_id text, joined_at timestamptz default now());
create table if not exists agreements (
  id text primary key, household_id text, data jsonb not null, status text not null,
  readback jsonb, digest text, created_at timestamptz default now(), signed_at timestamptz);
create table if not exists visits (
  id text primary key, household_id text not null, member_ids jsonb not null, start int not null,
  minutes int not null, terms jsonb not null, state text not null,
  hold jsonb, capture jsonb, void jsonb, payout jsonb, outcome jsonb, settlement jsonb,
  checkin_at int, checkout_at int, pending_member text, updated_at timestamptz default now());
create index if not exists visits_start on visits(start);
create table if not exists money (
  id bigserial primary key, visit_id text not null, kind text not null, cents int not null,
  paypal_id text, status text, ref text not null, at timestamptz default now(), board_at int, detail jsonb,
  unique (visit_id, kind, ref));
create table if not exists events (
  id bigserial primary key, at timestamptz default now(), board_at int, type text not null,
  visit_id text, actor text, data jsonb);
create table if not exists disruptions (
  id text primary key, created_at timestamptz default now(), board_at int, member_id text, text text,
  kind text, day int, from_min int, affected jsonb, status text not null, proposal jsonb, agent jsonb);
create table if not exists ai_cache (
  key text primary key, task text not null, model text, output jsonb not null, usage jsonb, ms int,
  created_at timestamptz default now());
create table if not exists shares (
  token text primary key, member_id text not null, months jsonb not null, expires_at timestamptz not null,
  created_at timestamptz default now());
`;
