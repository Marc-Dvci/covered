// The ledger: one Durable Object with its own SQLite database, the same dialect as node:sqlite in the
// quickstart and the tests. Queries issued in the same tick travel as one call, so reading the board is one
// round trip, and transactions are applied atomically by the object.
import { DurableObject } from "cloudflare:workers";
import { bindable, decodeRow, numbered, type Db, type Query } from "../server/db.ts";

interface Statement {
  sql: string;
  params: unknown[];
}

export class Ledger extends DurableObject {
  run(statements: Statement[], atomic: boolean): Record<string, unknown>[][] {
    const sql = this.ctx.storage.sql;
    const exec = () => statements.map((s) => [...sql.exec(s.sql, ...(s.params as never[]))] as Record<string, unknown>[]);
    return atomic ? this.ctx.storage.transactionSync(exec) : exec();
  }
}

export interface LedgerStub {
  run(statements: Statement[], atomic: boolean): Promise<Record<string, unknown>[][]>;
}

const prepared = (sql: string, params?: unknown[]): Statement => ({ sql: numbered(sql), params: bindable(params) });

/** A stub belongs to the request that made it, so each call gets its own. */
export function ledgerDb(ledger: () => LedgerStub): Db {
  let waiting: { statement: Statement; resolve: (rows: Record<string, unknown>[]) => void; reject: (e: unknown) => void }[] = [];

  const flush = () => {
    const batch = waiting;
    waiting = [];
    ledger().run(batch.map((w) => w.statement), false).then(
      (results) => batch.forEach((w, i) => w.resolve(results[i] ?? [])),
      (e) => batch.forEach((w) => w.reject(e)),
    );
  };

  const query: Query = async <T,>(sql: string, params?: unknown[]) => {
    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      if (!waiting.length) queueMicrotask(flush);
      waiting.push({ statement: prepared(sql, params), resolve, reject });
    });
    return rows.map((r) => decodeRow<T>(r));
  };

  return {
    query,
    tx: async (fn) => {
      const queued: Statement[] = [];
      await fn(async (sql, params) => {
        queued.push(prepared(sql, params));
        return [];
      });
      if (queued.length) await ledger().run(queued, true);
    },
    close: async () => {},
  };
}
