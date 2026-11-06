// Domain reads and writes on top of the database: visits, money rows, events, the demo clock.
import { randomBytes } from "node:crypto";
import type { Household, Member, Terms, Visit, VisitState } from "../shared/domain.ts";
import type { Outcome, Settlement } from "../shared/rules/settle.ts";
import { households as seedHouseholds, members as seedMembers, seedVisits, STORY } from "../shared/seed.ts";
import { SCHEMA, type Db } from "./db.ts";

export interface VisitRow extends Visit {
  hold: { orderId: string; authorizationId: string; cents: number; placedAt: number; status: string } | null;
  capture: { captureId: string; cents: number; feeCents?: number; at: number } | null;
  void: { at: number; status: string } | null;
  payout: {
    batchId: string;
    senderBatchId: string;
    status: string;
    items: { memberId: string; cents: number; wallet: string; transactionId?: string; status?: string }[];
    sentAt: number;
    sentMs?: number;
    finalAt?: number;
    finalMs?: number;
  } | null;
  outcome: Outcome | null;
  settlement: Settlement | null;
  checkinAt: number | null;
  checkoutAt: number | null;
  pendingMember: string | null; // a cover waiting for the household's OK
}

type Row = Record<string, unknown>;

function toVisit(r: Row): VisitRow {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    memberIds: r.member_ids as string[],
    start: r.start as number,
    minutes: r.minutes as number,
    terms: r.terms as Terms,
    state: r.state as VisitState,
    hold: (r.hold as VisitRow["hold"]) ?? null,
    capture: (r.capture as VisitRow["capture"]) ?? null,
    void: (r.void as VisitRow["void"]) ?? null,
    payout: (r.payout as VisitRow["payout"]) ?? null,
    outcome: (r.outcome as Outcome) ?? null,
    settlement: (r.settlement as Settlement) ?? null,
    checkinAt: (r.checkin_at as number) ?? null,
    checkoutAt: (r.checkout_at as number) ?? null,
    pendingMember: (r.pending_member as string) ?? null,
  };
}

const VISIT_COLS: Record<string, string> = {
  memberIds: "member_ids",
  state: "state",
  hold: "hold",
  capture: "capture",
  void: "void",
  payout: "payout",
  outcome: "outcome",
  settlement: "settlement",
  checkinAt: "checkin_at",
  checkoutAt: "checkout_at",
  pendingMember: "pending_member",
  start: "start",
  minutes: "minutes",
  terms: "terms",
};
const JSON_COLS = new Set(["member_ids", "hold", "capture", "void", "payout", "outcome", "settlement", "terms"]);

export class Store {
  constructor(readonly db: Db) {}

  async migrate(): Promise<void> {
    if ((await this.db.query("select 1 from sqlite_master where type = 'table' and name = 'shares'")).length) return;
    for (const stmt of SCHEMA.split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await this.db.query(stmt);
  }

  /**
   * Wipe and load the demo cooperative; the demo clock goes to Thursday 07:10. `payouts` routes the
   * fictional members' pay to real sandbox receivers: "*=PAYPAL:a@b.com".
   */
  async reset(vaultId = "DEMO-VAULT", payouts = ""): Promise<void> {
    const route = new Map(
      payouts
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [who, rest = ""] = x.split("=");
          const [wallet, receiver] = rest.split(":");
          return [who!.trim(), { wallet: (wallet === "VENMO" ? "VENMO" : "PAYPAL") as "PAYPAL" | "VENMO", receiver: receiver!.trim() }];
        }),
    );
    await this.db.tx(async (q) => {
      // the daily model and reset allowances survive a reset: resetting must not refill them
      await q("delete from kv where key not like 'ai_calls:%' and key not like 'demo_resets:%'");
      for (const t of ["members", "households", "agreements", "visits", "money", "events", "disruptions", "shares"]) await q(`delete from ${t}`);
      for (const m of seedMembers) {
        // pay goes to a PayPal receiver: the sandbox refuses Venmo, so nothing here claims it
        const payout = route.get(m.id) ?? route.get("*") ?? { wallet: "PAYPAL" as const, receiver: `${m.id}@members.example` };
        await q("insert into members(id, data) values ($1, $2)", [m.id, JSON.stringify({ ...m, payout })]);
      }
      for (const h of seedHouseholds) {
        await q("insert into households(id, data, vault_id, vault_email) values ($1, $2, $3, $4)", [
          h.id,
          JSON.stringify(h),
          vaultId,
          `${h.id}@households.example`,
        ]);
      }
      for (const v of seedVisits()) {
        await q("insert into visits(id, household_id, member_ids, start, minutes, terms, state) values ($1,$2,$3,$4,$5,$6,$7)", [
          v.id,
          v.householdId,
          JSON.stringify(v.memberIds),
          v.start,
          v.minutes,
          JSON.stringify(v.terms),
          v.state,
        ]);
      }
    });
    const start = STORY.messageAt;
    await this.db.query("update visits set state = 'done' where start + minutes <= $1", [start]);
    await this.setClock(start);
    // a fresh run tag per reset, so the replayed week's PayPal ids never collide with an earlier run's
    await this.kvSet("run_tag", randomBytes(3).toString("hex"));
  }

  /** The PayPal reference for a visit: request ids, invoice id and payout batch id are built from it. */
  async payRef(visitId: string): Promise<string> {
    const tag = await this.kvGet<string>("run_tag");
    return tag ? `${tag}-${visitId}` : visitId;
  }

  /** The visit a PayPal invoice id (covered-<ref>) belongs to, if it is from this run. */
  async visitForInvoice(invoiceId: string): Promise<string | null> {
    if (!invoiceId.startsWith("covered-")) return null;
    const ref = invoiceId.slice("covered-".length);
    const tag = await this.kvGet<string>("run_tag");
    const id = tag ? (ref.startsWith(`${tag}-`) ? ref.slice(tag.length + 1) : null) : ref;
    return id && (await this.visit(id)) ? id : null;
  }

  // ---- clock: board minutes. The demo's day moves only when someone moves it, so an idle demo stays at 07:10

  async now(): Promise<number> {
    return (await this.kvGet<number>("clock")) ?? 0;
  }

  async setClock(at: number): Promise<void> {
    await this.kvSet("clock", at);
  }

  async kvGet<T>(key: string): Promise<T | null> {
    const r = await this.db.query<{ value: T }>("select value from kv where key = $1", [key]);
    return r[0]?.value ?? null;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.db.query("insert into kv(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(value)]);
  }

  async kvTake<T>(key: string): Promise<T | null> {
    const r = await this.db.query<{ value: T }>("delete from kv where key = $1 returning value", [key]);
    return r[0]?.value ?? null;
  }

  // ---- people

  async members(): Promise<Member[]> {
    return (await this.db.query<{ data: Member }>("select data from members order by id")).map((r) => r.data).sort((a, b) => seedOrder(a.id) - seedOrder(b.id));
  }

  async households(): Promise<(Household & { vaultId: string | null; vaultEmail: string | null })[]> {
    return (
      await this.db.query<{ data: Household; vault_id: string | null; vault_email: string | null }>(
        "select data, vault_id, vault_email from households order by id",
      )
    ).map((r) => ({ ...r.data, vaultId: r.vault_id, vaultEmail: r.vault_email }));
  }

  async household(id: string) {
    return (await this.households()).find((h) => h.id === id) ?? null;
  }

  // ---- visits

  async visits(): Promise<VisitRow[]> {
    return (await this.db.query("select * from visits order by start, id")).map(toVisit);
  }

  async visit(id: string): Promise<VisitRow | null> {
    const r = await this.db.query("select * from visits where id = $1", [id]);
    return r[0] ? toVisit(r[0]) : null;
  }

  async updateVisit(id: string, patch: Partial<VisitRow>): Promise<VisitRow> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      const col = VISIT_COLS[k];
      if (!col) throw new Error(`not a visit column: ${k}`);
      params.push(JSON_COLS.has(col) ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`${col} = $${params.length}`);
    }
    const r = await this.db.query(`update visits set ${sets.join(", ")}, updated_at = datetime('now') where id = $1 returning *`, params);
    if (!r[0]) throw new Error(`no visit ${id}`);
    return toVisit(r[0]);
  }

  async setStates(ids: string[], state: VisitState): Promise<void> {
    await this.db.tx(async (q) => {
      for (const id of ids) await q("update visits set state = $2, updated_at = datetime('now') where id = $1", [id, state]);
    });
  }

  async insertVisit(v: Visit): Promise<void> {
    await this.db.query("insert into visits(id, household_id, member_ids, start, minutes, terms, state) values ($1,$2,$3,$4,$5,$6,$7)", [
      v.id,
      v.householdId,
      JSON.stringify(v.memberIds),
      v.start,
      v.minutes,
      JSON.stringify(v.terms),
      v.state,
    ]);
  }

  // ---- money and events

  /** Records a money movement once; a retried step with the same ref returns the first row. */
  async money(visitId: string, kind: string, cents: number, ref: string, paypalId: string | null, status: string, detail: unknown = null): Promise<void> {
    await this.db.query(
      `insert into money(visit_id, kind, cents, paypal_id, status, ref, board_at, detail) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (visit_id, kind, ref) do update set status = excluded.status, paypal_id = coalesce(excluded.paypal_id, money.paypal_id)`,
      [visitId, kind, cents, paypalId, status, ref, await this.now(), detail === null ? null : JSON.stringify(detail)],
    );
  }

  async moneyRows(visitId?: string) {
    return this.db.query<{
      visit_id: string;
      kind: string;
      cents: number;
      paypal_id: string | null;
      status: string;
      ref: string;
      at: string;
      board_at: number;
      detail: unknown;
    }>(visitId ? "select * from money where visit_id = $1 order by id" : "select * from money order by id", visitId ? [visitId] : []);
  }

  async event(type: string, visitId: string | null, actor: string, data: unknown = {}): Promise<void> {
    await this.db.query("insert into events(type, visit_id, actor, data, board_at) values ($1,$2,$3,$4,$5)", [
      type,
      visitId,
      actor,
      JSON.stringify(data),
      await this.now(),
    ]);
  }

  async events(limit = 50, visitId?: string) {
    return this.db.query<{ id: number; at: string; board_at: number; type: string; visit_id: string | null; actor: string; data: Record<string, unknown> }>(
      visitId ? "select * from events where visit_id = $2 order by id desc limit $1" : "select * from events order by id desc limit $1",
      visitId ? [limit, visitId] : [limit],
    );
  }
}

function seedOrder(id: string): number {
  const i = seedMembers.findIndex((m) => m.id === id);
  return i < 0 ? 999 : i;
}
