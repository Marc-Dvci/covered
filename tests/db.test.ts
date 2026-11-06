import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { bindable, decodeRow, numbered } from "../server/db.ts";
import { openSqlite } from "../server/sqlite.ts";
import { Store } from "../server/store.ts";
import { ledgerDb, type LedgerStub } from "../worker/ledger.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("decoding rows", () => {
  it("decodes the JSON columns and leaves the text columns as text", () => {
    expect(decodeRow({ id: "x", name: '{"b":2}', data: '{"a":1}', member_ids: '["lena"]', value: "[1]" })).toEqual({
      id: "x", name: '{"b":2}', data: { a: 1 }, member_ids: ["lena"], value: [1],
    });
  });

  it("leaves a JSON column alone when it already holds no text", () => {
    expect(decodeRow({ data: null, terms: 7, hold: { cents: 1 } })).toEqual({ data: null, terms: 7, hold: { cents: 1 } });
  });
});

describe("statement text and parameters", () => {
  it("numbers the $n placeholders as SQLite's ?n", () => {
    expect(numbered("select $1, $2, $10")).toBe("select ?1, ?2, ?10");
  });

  it("binds undefined as null and booleans as 0 or 1", () => {
    expect(bindable([undefined, true, false, 0, "a", null])).toEqual([null, 1, 0, 0, "a", null]);
    expect(bindable()).toEqual([]);
  });
});

describe("the SQLite database", () => {
  it("binds positional parameters", async () => {
    const db = openSqlite(null);
    expect(await db.query("select $1 as a, $2 as b", [1, "x"])).toEqual([{ a: 1, b: "x" }]);
  });

  it("binds $2 before $1 by number, not by position in the text", async () => {
    const db = openSqlite(null);
    expect(await db.query("select $2 as second, $1 as first", ["one", "two"])).toEqual([{ second: "two", first: "one" }]);
  });

  it("uses one value for every appearance of the same parameter", async () => {
    const db = openSqlite(null);
    expect(await db.query("select $1 as a, $1 as b", [7])).toEqual([{ a: 7, b: 7 }]);
  });

  it("stores undefined as null and booleans as 0 or 1", async () => {
    const db = openSqlite(null);
    expect(await db.query("select $1 as a, $2 as t, $3 as f", [undefined, true, false])).toEqual([{ a: null, t: 1, f: 0 }]);
  });

  it("a transaction that returns keeps its writes", async () => {
    const db = openSqlite(null);
    await db.query("create table t (x integer)");
    await db.tx(async (q) => {
      await q("insert into t (x) values ($1)", [1]);
      await q("insert into t (x) values ($1)", [2]);
    });
    expect(await db.query("select x from t order by x")).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("a transaction that throws rolls back every write in it and rethrows", async () => {
    const db = openSqlite(null);
    await db.query("create table t (x integer)");
    await expect(db.tx(async (q) => {
      await q("insert into t (x) values ($1)", [1]);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await db.query("select count(*) as n from t")).toEqual([{ n: 0 }]);
  });

  it("inside a transaction, a query sees the transaction's own writes", async () => {
    const db = openSqlite(null);
    await db.query("create table t (x integer)");
    await db.tx(async (q) => {
      await q("insert into t (x) values ($1)", [5]);
      expect(await q("select x from t")).toEqual([{ x: 5 }]);
    });
  });
});

interface FakeLedger {
  sql: DatabaseSync;
  calls: { size: number; atomic: boolean }[];
  stub: LedgerStub;
}

/** An in-memory SQLite that answers run() the way the ledger object does: one call, optionally atomic. */
function fakeLedger(): FakeLedger {
  const sql = new DatabaseSync(":memory:");
  const calls: { size: number; atomic: boolean }[] = [];
  const stub: LedgerStub = {
    async run(statements, atomic) {
      calls.push({ size: statements.length, atomic });
      const exec = () => statements.map((s) => sql.prepare(s.sql).all(...(s.params as never[])) as Record<string, unknown>[]);
      if (!atomic) return exec();
      sql.exec("BEGIN");
      try {
        const out = exec();
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sql, calls, stub };
}

describe("the ledger's query batching", () => {
  it("queries issued in the same tick travel as one call that is not atomic", async () => {
    const f = fakeLedger();
    const db = ledgerDb(() => f.stub);
    await Promise.all([db.query("select $1 as a", [1]), db.query("select $1 as b", [2]), db.query("select 3 as c")]);
    expect(f.calls).toEqual([{ size: 3, atomic: false }]);
  });

  it("each caller gets the rows of its own query", async () => {
    const f = fakeLedger();
    const db = ledgerDb(() => f.stub);
    const rows = await Promise.all([db.query("select $1 as a", [1]), db.query("select $1 as a", [2]), db.query("select 'x' as b")]);
    expect(rows).toEqual([[{ a: 1 }], [{ a: 2 }], [{ b: "x" }]]);
  });

  it("a failing call rejects every query in its batch", async () => {
    const f = fakeLedger();
    const db = ledgerDb(() => f.stub);
    const results = await Promise.allSettled([db.query("select 1 as ok"), db.query("select * from no_such_table")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("queries awaited one after another are separate calls", async () => {
    const f = fakeLedger();
    const db = ledgerDb(() => f.stub);
    await db.query("select 1 as a");
    await db.query("select 2 as b");
    expect(f.calls).toEqual([{ size: 1, atomic: false }, { size: 1, atomic: false }]);
  });

  it("asks for a fresh stub for each call", async () => {
    const f = fakeLedger();
    let requests = 0;
    const db = ledgerDb(() => {
      requests += 1;
      return f.stub;
    });
    await db.query("select 1 as a");
    await db.query("select 2 as b");
    expect(requests).toBe(2);
    await db.tx(async (q) => {
      await q("select 3");
    });
    expect(requests).toBe(3);
  });

  it("a transaction sends its statements as one atomic call, and they are applied", async () => {
    const f = fakeLedger();
    f.sql.exec("create table t (x integer)");
    const db = ledgerDb(() => f.stub);
    await db.tx(async (q) => {
      await q("insert into t (x) values ($1)", [1]);
      await q("insert into t (x) values ($1)", [2]);
    });
    expect(f.calls).toEqual([{ size: 2, atomic: true }]);
    expect(await db.query("select x from t order by x")).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("an empty transaction sends nothing and asks for no stub", async () => {
    const f = fakeLedger();
    let requests = 0;
    const db = ledgerDb(() => {
      requests += 1;
      return f.stub;
    });
    await db.tx(async () => {});
    expect(f.calls).toEqual([]);
    expect(requests).toBe(0);
  });
});

describe("the schema", () => {
  it("creates every table on an empty database", async () => {
    const db = openSqlite(null);
    const store = new Store(db);
    await store.migrate();
    const tables = (await db.query<{ name: string }>("select name from sqlite_master where type = 'table'")).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["kv", "members", "households", "agreements", "visits", "money", "events", "disruptions", "ai_cache", "shares"]));
  });

  it("a second migrate only checks for the schema and leaves the data alone", async () => {
    const db = openSqlite(null);
    const store = new Store(db);
    await store.migrate();
    await store.kvSet("keep", "me");
    const query = vi.spyOn(db, "query");
    await store.migrate();
    expect(query).toHaveBeenCalledTimes(1);
    expect(await store.kvGet("keep")).toBe("me");
  });
});
