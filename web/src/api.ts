import { useCallback, useEffect, useRef, useState } from "react";
import type { Household, Lang, Member, Terms, VisitState } from "../../shared/domain.ts";

export interface PublicVisit {
  id: string;
  householdId: string;
  memberIds: string[];
  start: number;
  minutes: number;
  state: VisitState;
  priceCents: number;
  holdCents: number;
  terms: Terms;
  hold: { authorizationId: string; cents: number; placedAt: number; status: string } | null;
  capture: { captureId: string; cents: number; feeCents?: number; at: number } | null;
  void: { at: number; status: string } | null;
  payout: { status: string; batchId: string; items: { memberId: string; cents: number; wallet: string; status?: string; transactionId?: string }[]; sentAt: number; finalAt?: number; finalMs?: number } | null;
  settlement: { captureCents: number; releaseCents: number; coopCents: number; members: Record<string, number>; dueCents: number; reason: string } | null;
  outcome: { type: string } | null;
  checkinAt: number | null;
  checkoutAt: number | null;
  pendingMember: string | null;
  payment: string;
}

export interface Mode {
  paypal: "sandbox" | "stand-in";
  currency: string;
  runner: "cloudflare" | "local";
  ai: "gemini" | "recorded";
  demo: boolean;
}

export interface Plan {
  rank: number;
  assignments: { visitId: string; memberId: string | null; consent: boolean; language: boolean; familiar: boolean; travelIn: number }[];
  covered: number;
  consent: number;
  language: number;
  familiar: number;
  addedTravel: number;
}

export interface Proposal {
  id: string;
  plan: Plan;
  alternatives: Plan[];
  why: string;
  messages: { toId: string; toKind: "member" | "household"; language: Lang; text: string; english?: string }[];
  source: string;
  model?: string;
  turns: { call: string; args: unknown }[];
  rejected: string[];
}

export interface Disruption {
  id: string;
  memberId: string;
  text: string;
  kind: string;
  day: number;
  fromMin: number;
  affected: string[];
  status: "open" | "proposed" | "approved" | "dismissed";
  proposal: Proposal | null;
  boardAt: number;
}

export interface EventRow {
  id: number;
  board_at: number;
  type: string;
  visit_id: string | null;
  actor: string;
  data: Record<string, unknown>;
}

export interface Board {
  coop: { name: string; coordinator: string; city: string };
  weekStart: string;
  now: number;
  mode: Mode;
  members: (Member & { bookedMinutes: number })[];
  households: (Household & { paypalSaved: boolean })[];
  visits: PublicVisit[];
  disruptions: Disruption[];
  events: EventRow[];
  crud: CrudData;
}

/** The week in Bryntum CrudManager load format (server/crud.ts). */
export interface CrudData {
  success: boolean;
  calendars: { rows: Record<string, unknown>[] };
  resources: { rows: Record<string, unknown>[] };
  events: { rows: Record<string, unknown>[] };
  assignments: { rows: Record<string, unknown>[] };
  resourceTimeRanges: { rows: Record<string, unknown>[] };
  timeRanges: { rows: Record<string, unknown>[] };
}

export interface Guard {
  ok: boolean;
  reasons: string[];
  consent: boolean;
}
export type Guards = Record<string, Record<string, Guard>>;

export class ApiError extends Error {}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Fetch now and every `ms`; `reload` forces a fetch. */
export function usePoll<T>(path: string | null, ms = 2000): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void reload();
    // a tab nobody is looking at does not poll: the free plan's daily requests are for people
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, ms);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload, ms]);
  return { data, error, reload };
}

export const STATE_LABEL: Record<VisitState, string> = {
  done: "Before the demo", scheduled: "Scheduled", holding: "Placing hold", held: "Pay held", at_risk: "Hold refused", in_progress: "In progress",
  settling: "Settling", captured: "Captured", paid_out: "Paid", late_cancel: "Late-cancel fee", cancelled: "Cancelled", voided: "Released",
};
