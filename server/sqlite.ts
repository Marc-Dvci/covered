// node:sqlite for the quickstart, the Docker image and the tests. Same SQL dialect as the deployed ledger.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bindable, decodeRow, numbered, type Db, type Query } from "./db.ts";

/** At a file path, or in memory when `file` is null. */
export function openSqlite(file: string | null): Db {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file ?? ":memory:");
  const query: Query = async <T>(sql: string, params?: unknown[]) =>
    (db.prepare(numbered(sql)).all(...(bindable(params) as never[])) as Record<string, unknown>[]).map((r) => decodeRow<T>(r));
  return {
    query,
    tx: async (fn) => {
      db.exec("BEGIN");
      try {
        await fn(query);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: async () => db.close(),
  };
}
