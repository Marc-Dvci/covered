// One small SQL surface over SQLite: a Durable Object's database in production, node:sqlite for the no-setup
// quickstart and the tests, so the SQL that the tests run is the SQL that runs live. JSON columns are stored
// as text and decoded on the way out; parameters are written $1, $2 like the rest of the code expects.

export type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Db {
  query: Query;
  /** Apply writes atomically. They may be queued and sent as one batch, so `fn` cannot read their results. */
  tx(fn: (q: Query) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

const JSON_COLUMNS = new Set([
  "value",
  "data",
  "member_ids",
  "terms",
  "hold",
  "capture",
  "void",
  "payout",
  "outcome",
  "settlement",
  "readback",
  "output",
  "usage",
  "months",
  "affected",
  "proposal",
  "agent",
  "detail",
]);

export function decodeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = JSON_COLUMNS.has(k) && typeof v === "string" ? JSON.parse(v) : v;
  }
  return out as T;
}

export const numbered = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
export const bindable = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));

export const SCHEMA = `
create table if not exists kv (key text primary key, value text not null);
create table if not exists members (id text primary key, data text not null);
create table if not exists households (
  id text primary key, data text not null,
  vault_id text, vault_email text, agreement_id text, joined_at text default (datetime('now')));
create table if not exists agreements (
  id text primary key, household_id text, data text not null, status text not null,
  readback text, digest text, created_at text default (datetime('now')), signed_at text);
create table if not exists visits (
  id text primary key, household_id text not null, member_ids text not null, start integer not null,
  minutes integer not null, terms text not null, state text not null,
  hold text, capture text, void text, payout text, outcome text, settlement text,
  checkin_at integer, checkout_at integer, pending_member text, updated_at text default (datetime('now')));
create index if not exists visits_start on visits(start);
create table if not exists money (
  id integer primary key autoincrement, visit_id text not null, kind text not null, cents integer not null,
  paypal_id text, status text, ref text not null, at text default (datetime('now')), board_at integer, detail text,
  unique (visit_id, kind, ref));
create table if not exists events (
  id integer primary key autoincrement, at text default (datetime('now')), board_at integer, type text not null,
  visit_id text, actor text, data text);
create table if not exists disruptions (
  id text primary key, created_at text default (datetime('now')), board_at integer, member_id text, text text,
  kind text, day integer, from_min integer, affected text, status text not null, proposal text, agent text);
create table if not exists ai_cache (
  key text primary key, task text not null, model text, output text not null, usage text, ms integer,
  created_at text default (datetime('now')));
create table if not exists shares (
  token text primary key, member_id text not null, months text not null, expires_at text not null,
  created_at text default (datetime('now')));
`;
