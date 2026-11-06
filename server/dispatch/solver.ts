// Cover solver. Given the week, who is out, and the visits that lost their member, it returns every
// member's verdict for each visit (with the reason when they cannot take it) and the best few complete
// plans. Plans are ranked: most visits covered, then fewest same-cleaner consents needed, then most
// visits in the household's language, then most visits with a member the household already knows,
// then least added travel. Exhaustive branch and bound: a cooperative's day is small enough.
import type { Household, Member, Visit } from "../../shared/domain.ts";
import { clock } from "../../shared/domain.ts";
import { travelMinutes } from "../../shared/travel.ts";

export interface Absence {
  memberId: string;
  from: number;
  to: number;
}

export interface Candidate {
  memberId: string;
  ok: boolean;
  reasons: string[]; // why not, when !ok
  consent: boolean; // household asked for the same cleaner and this is someone else
  language: boolean; // speaks the household's language
  familiar: boolean; // already cleans for this household
}

export interface Assignment {
  visitId: string;
  memberId: string | null;
  consent: boolean;
  language: boolean;
  familiar: boolean;
  travelIn: number; // minutes from the member's previous home that day (0 if first)
}

export interface Plan {
  rank: number;
  assignments: Assignment[];
  covered: number;
  consent: number;
  language: number;
  familiar: number;
  addedTravel: number;
}

export interface SolveInput {
  members: Member[];
  households: Household[];
  visits: Visit[]; // the whole week; affected visits may still list their absent member
  absences: Absence[];
  affected: string[];
  maxPlans?: number;
}

export interface SolveResult {
  candidates: Record<string, Candidate[]>;
  plans: Plan[];
  explored: number;
}

type Slot = { start: number; end: number; at: Household["at"]; id: string };

/**
 * The solver names other visits by id, and the agent reads those lines as they are. A person reads the household's
 * name instead: this is what the board's tooltip and the server's refusal show.
 */
export function readableReasons(reasons: string[], visits: Pick<Visit, "id" | "householdId">[], households: Pick<Household, "id" | "name">[]): string[] {
  const names = new Map(visits.map((v) => [v.id, households.find((h) => h.id === v.householdId)?.name.replace(/^The /, "the ")]));
  return reasons.map((r) => r.replace(/\bv-[a-z0-9-]+/g, (id) => names.get(id) ?? "another visit"));
}

export function solve(input: SolveInput): SolveResult {
  const { members, households } = input;
  const hh = new Map(households.map((h) => [h.id, h]));
  const affected = input.affected.map((id) => input.visits.find((v) => v.id === id)).filter((v): v is Visit => Boolean(v));
  const affectedIds = new Set(affected.map((v) => v.id));
  const fixed = input.visits.filter((v) => !affectedIds.has(v.id));

  // per member: fixed slots by day, and fixed weekly minutes
  const slots = new Map<string, Map<number, Slot[]>>();
  const load = new Map<string, number>();
  for (const m of members) {
    slots.set(m.id, new Map());
    load.set(m.id, 0);
  }
  for (const v of fixed) {
    for (const mid of v.memberIds) {
      const byDay = slots.get(mid);
      if (!byDay) continue;
      const d = Math.floor(v.start / 1440);
      const list = byDay.get(d) ?? [];
      list.push({ start: v.start, end: v.start + v.minutes, at: hh.get(v.householdId)!.at, id: v.id });
      byDay.set(d, list);
      load.set(mid, load.get(mid)! + v.minutes);
    }
  }
  const knows = new Map<string, Set<string>>(); // household -> members who clean there this week
  for (const v of input.visits) {
    for (const mid of v.memberIds) {
      const set = knows.get(v.householdId) ?? new Set();
      set.add(mid);
      knows.set(v.householdId, set);
    }
  }

  // fits: can member m take visit v, given extra slots already chosen in this plan?
  const fits = (m: Member, v: Visit, extra: Slot[], extraMinutes: number): { ok: boolean; reasons: string[]; travelIn: number } => {
    const reasons: string[] = [];
    const h = hh.get(v.householdId)!;
    const day = Math.floor(v.start / 1440);
    const from = v.start % 1440;
    const to = from + v.minutes;
    if (input.absences.some((a) => a.memberId === m.id && v.start < a.to && v.start + v.minutes > a.from)) reasons.push("is out");
    const win = m.availability.find((w) => w.day === day % 7 && w.from <= from && to <= w.to);
    if (!win) {
      const any = m.availability.find((w) => w.day === day % 7);
      reasons.push(any ? `works ${clock(any.from)} to ${clock(any.to)} that day` : "does not work that day");
    }
    const missingSkills = h.needs.filter((n) => !m.skills.includes(n));
    if (missingSkills.length)
      reasons.push(`no ${missingSkills.map((s) => (s === "pets" ? "pets" : s === "eco" ? "fragrance-free kit" : "deep-clean training")).join(", ")}`);
    if (load.get(m.id)! + extraMinutes + v.minutes > m.weeklyHoursCap * 60) {
      reasons.push(`would pass ${m.weeklyHoursCap} h this week`);
    }
    const day_slots = [...(slots.get(m.id)!.get(day) ?? []), ...extra.filter((s) => Math.floor(s.start / 1440) === day)];
    let travelIn = 0;
    const mine: Slot = { start: v.start, end: v.start + v.minutes, at: h.at, id: v.id };
    for (const s of day_slots) {
      if (s.end <= mine.start) {
        const gap = travelMinutes(s.at, mine.at);
        if (s.end + gap > mine.start) reasons.push(`not there in time from ${s.id} (${gap} min away)`);
        else travelIn = Math.max(travelIn, gap);
      } else if (mine.end <= s.start) {
        const gap = travelMinutes(mine.at, s.at);
        if (mine.end + gap > s.start) reasons.push(`could not reach ${s.id} by ${clock(s.start)} (${gap} min away)`);
      } else reasons.push(`busy at ${s.id} ${clock(s.start)} to ${clock(s.end)}`);
    }
    return { ok: reasons.length === 0, reasons, travelIn };
  };

  const meta = (m: Member, v: Visit) => {
    const h = hh.get(v.householdId)!;
    return {
      consent: h.sameCleaner && h.regularMemberId !== m.id,
      language: m.languages.includes(h.language),
      familiar: h.regularMemberId === m.id || (knows.get(h.id)?.has(m.id) ?? false),
    };
  };

  const candidates: Record<string, Candidate[]> = {};
  for (const v of affected) {
    candidates[v.id] = members.map((m) => {
      const f = fits(m, v, [], 0);
      return { memberId: m.id, ok: f.ok, reasons: f.reasons, ...meta(m, v) };
    });
  }

  // branch and bound over visits ordered by fewest options
  const order = [...affected].sort((a, b) => candidates[a.id]!.filter((c) => c.ok).length - candidates[b.id]!.filter((c) => c.ok).length || a.start - b.start);
  const maxPlans = input.maxPlans ?? 3;
  const found: Plan[] = [];
  const key = (p: Pick<Plan, "covered" | "consent" | "language" | "familiar" | "addedTravel">) =>
    [p.covered, -p.consent, p.language, p.familiar, -p.addedTravel] as const;
  const better = (a: Plan, b: Plan) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! > kb[i]!;
    return false;
  };
  let explored = 0;
  const chosen: Assignment[] = [];
  const extraByMember = new Map<string, Slot[]>();
  const extraMin = new Map<string, number>();

  const walk = (i: number) => {
    explored++;
    const covered = chosen.filter((a) => a.memberId).length;
    if (found.length >= maxPlans && covered + (order.length - i) < found[found.length - 1]!.covered) return;
    if (i === order.length) {
      const plan: Plan = {
        rank: 0,
        assignments: affected.map((v) => chosen.find((a) => a.visitId === v.id)!),
        covered,
        consent: chosen.filter((a) => a.memberId && a.consent).length,
        language: chosen.filter((a) => a.memberId && a.language).length,
        familiar: chosen.filter((a) => a.memberId && a.familiar).length,
        addedTravel: chosen.reduce((s, a) => s + (a.memberId ? a.travelIn : 0), 0),
      };
      found.push(plan);
      found.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
      if (found.length > maxPlans) found.pop();
      return;
    }
    const v = order[i]!;
    const h = hh.get(v.householdId)!;
    for (const m of members) {
      const extra = extraByMember.get(m.id) ?? [];
      const f = fits(m, v, extra, extraMin.get(m.id) ?? 0);
      if (!f.ok) continue;
      chosen.push({ visitId: v.id, memberId: m.id, travelIn: f.travelIn, ...meta(m, v) });
      extraByMember.set(m.id, [...extra, { start: v.start, end: v.start + v.minutes, at: h.at, id: v.id }]);
      extraMin.set(m.id, (extraMin.get(m.id) ?? 0) + v.minutes);
      walk(i + 1);
      chosen.pop();
      extraByMember.set(m.id, extra);
      extraMin.set(m.id, (extraMin.get(m.id) ?? 0) - v.minutes);
    }
    chosen.push({ visitId: v.id, memberId: null, consent: false, language: false, familiar: false, travelIn: 0 });
    walk(i + 1);
    chosen.pop();
  };
  walk(0);
  found.forEach((p, i) => (p.rank = i + 1));
  return { candidates, plans: found, explored };
}

/** What a coordinator does by phone in a hurry: the first member, in list order, with no clash on the clock. */
export function firstFree(input: SolveInput): Assignment[] {
  const affected = input.affected.map((id) => input.visits.find((v) => v.id === id)!).sort((a, b) => a.start - b.start);
  const taken = input.visits.filter((v) => !input.affected.includes(v.id)).map((v) => ({ ...v }));
  const out: Assignment[] = [];
  for (const v of affected) {
    const m = input.members.find(
      (m) =>
        !input.absences.some((a) => a.memberId === m.id && v.start < a.to && v.start + v.minutes > a.from) &&
        !taken.some((t) => t.memberIds.includes(m.id) && t.start < v.start + v.minutes && v.start < t.start + t.minutes),
    );
    out.push({ visitId: v.id, memberId: m?.id ?? null, consent: false, language: false, familiar: false, travelIn: 0 });
    if (m) taken.push({ ...v, memberIds: [m.id] });
  }
  return out;
}
