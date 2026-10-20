// A member's income statement and the landlord link. Every line is a payout the cooperative sent
// through PayPal, matched against PayPal's Transaction Search by transaction id. The landlord view shows
// months, visit counts, hours and totals, never household names or addresses.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dollars, WEEK_DAYS } from "../shared/domain.ts";
import { WEEK_START_ISO } from "../shared/seed.ts";
import { AIUnavailable, numbersOk, type Gemini } from "./ai/gemini.ts";
import type { PayPal } from "./paypal/types.ts";
import type { Store } from "./store.ts";

export interface StatementLine {
  visitId: string;
  date: string;
  household: string;
  minutes: number;
  cents: number;
  kind: "visit" | "late_cancel" | "lockout";
  batchId: string;
  transactionId: string | null;
  payoutStatus: string;
  reconciled: "matched" | "pending" | "not_found";
}

export interface Statement {
  memberId: string;
  memberName: string;
  months: { month: string; visits: number; hours: number; cents: number }[];
  lines: StatementLine[];
  totalCents: number;
  reconciledCount: number;
  searchedAt: string | null;
  searchError: string | null;
}

export function boardDate(t: number): string {
  const d = new Date(`${WEEK_START_ISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(t / 1440));
  return d.toISOString().slice(0, 10);
}

export async function statement(store: Store, paypal: PayPal, memberId: string): Promise<Statement> {
  const [members, households, visits] = await Promise.all([store.members(), store.households(), store.visits()]);
  const m = members.find((x) => x.id === memberId);
  if (!m) throw new Error("no such member");
  const lines: StatementLine[] = [];
  for (const v of visits) {
    const item = v.payout?.items.find((i) => i.memberId === memberId);
    if (!item || !v.payout) continue;
    const kind = v.outcome?.type === "cancel" ? "late_cancel" : v.outcome?.type === "lockout" ? "lockout" : "visit";
    const worked = v.outcome?.type === "checkout" ? v.outcome.worked[memberId] ?? 0 : 0;
    lines.push({
      visitId: v.id, date: `${boardDate(v.start)} (${WEEK_DAYS[Math.floor(v.start / 1440)]})`, household: households.find((h) => h.id === v.householdId)?.name ?? "",
      minutes: worked, cents: item.cents, kind, batchId: v.payout.batchId, transactionId: item.transactionId ?? null,
      payoutStatus: item.status ?? v.payout.status, reconciled: "pending",
    });
  }
  let searchedAt: string | null = null;
  let searchError: string | null = null;
  if (lines.length) {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 31 * 86400_000);
      const txns = await paypal.transactions(start.toISOString().replace(/\.\d+Z$/, "Z"), end.toISOString().replace(/\.\d+Z$/, "Z"));
      const ids = new Set(txns.map((t) => t.transactionId));
      for (const l of lines) l.reconciled = l.transactionId && ids.has(l.transactionId) ? "matched" : "pending";
      searchedAt = end.toISOString();
    } catch (e) {
      searchError = (e as Error).message;
    }
  }
  const months = new Map<string, { visits: number; hours: number; cents: number }>();
  for (const l of lines) {
    const k = l.date.slice(0, 7);
    const acc = months.get(k) ?? { visits: 0, hours: 0, cents: 0 };
    acc.visits += l.kind === "visit" ? 1 : 0;
    acc.hours += l.minutes / 60;
    acc.cents += l.cents;
    months.set(k, acc);
  }
  return {
    memberId, memberName: m.name, lines,
    months: [...months.entries()].map(([month, x]) => ({ month, ...x, hours: Math.round(x.hours * 100) / 100 })),
    totalCents: lines.reduce((a, l) => a + l.cents, 0),
    reconciledCount: lines.filter((l) => l.reconciled === "matched").length,
    searchedAt, searchError,
  };
}

// ---- landlord link

export function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 32);
}

export async function share(store: Store, secret: string, memberId: string, days = 30): Promise<{ token: string; expiresAt: string }> {
  const id = randomBytes(9).toString("base64url");
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  const token = `${id}.${sign(secret, `${id}:${memberId}:${expiresAt}`)}`;
  await store.db.query("insert into shares(token, member_id, months, expires_at) values ($1,$2,$3,$4)", [token, memberId, JSON.stringify([]), expiresAt]);
  await store.event("statement.shared", null, memberId, { expiresAt });
  return { token, expiresAt };
}

export async function openShare(store: Store, secret: string, token: string): Promise<{ memberId: string; expiresAt: string } | null> {
  const r = await store.db.query<{ member_id: string; expires_at: string | Date }>("select member_id, expires_at from shares where token = $1", [token]);
  const row = r[0];
  if (!row) return null;
  const expiresAt = new Date(row.expires_at).toISOString();
  const [id, mac] = token.split(".");
  const want = sign(secret, `${id}:${row.member_id}:${expiresAt}`);
  if (!mac || mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  if (Date.parse(expiresAt) < Date.now()) return null;
  return { memberId: row.member_id, expiresAt };
}

export function landlordView(s: Statement) {
  return {
    name: s.memberName,
    months: s.months,
    totalCents: s.totalCents,
    payouts: s.lines.length,
    reconciled: s.reconciledCount,
    lines: s.lines.map((l) => ({ date: l.date, hours: Math.round((l.minutes / 60) * 100) / 100, cents: l.cents, transactionId: l.transactionId, reconciled: l.reconciled })),
  };
}

export async function coverLetter(ai: Gemini | null, s: Statement, visitor?: string): Promise<{ text: string; source: string }> {
  const totals = s.months.map((m) => `${m.month}: ${m.visits} visits, ${m.hours} hours, ${dollars(m.cents)}`).join("; ");
  const template = `${s.memberName} is a member-owner of a house-cleaning cooperative and is paid for each visit through PayPal. Paid in the period shown: ${dollars(s.totalCents)} across ${s.lines.length} payouts (${totals}). Each line carries its PayPal transaction id.`;
  if (!ai || !s.lines.length) return { text: template, source: "template" };
  try {
    const r = await ai.json<{ text: string }>("cover-letter", "light",
      "Write a short, plain cover letter (3 sentences) a cleaner can show a landlord or lender, introducing their income statement. Use only the figures given. No household names.",
      [{ text: `Name: ${s.memberName}\nWork: member-owner of a house-cleaning cooperative, paid per visit through PayPal\nTotal: ${dollars(s.totalCents)}\nPayouts: ${s.lines.length}\nBy month: ${totals}` }],
      { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] }, visitor);
    const allowed = [dollars(s.totalCents), s.lines.length, ...s.months.flatMap((m) => [m.month, m.visits, m.hours, dollars(m.cents)])];
    if (numbersOk(r.text, allowed)) return { text: r.text, source: ai.last?.source ?? "live" };
  } catch (e) {
    if (!(e instanceof AIUnavailable)) throw e;
  }
  return { text: template, source: "template" };
}
