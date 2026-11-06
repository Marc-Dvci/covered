// Labelling oracle for the cover scenarios. It is written separately from the product's solver on
// purpose: its own constraint checks, no pruning, every assignment enumerated. A scenario's labels are
// what this file says is possible; the solver is scored against them.
import type { Household, Member, Visit } from "../shared/domain.ts";
import { travelMinutes } from "../shared/travel.ts";

export interface Scenario {
  id: string;
  kind: "sick" | "sick_afternoon" | "two_sick" | "new_request" | "reschedule" | "healthy";
  day: number;
  absent: { memberId: string; from: number; to: number }[]; // minutes from week start
  /** Visits as they stand after the disruption. Affected visits have memberIds = []. */
  visits: Visit[];
  affected: string[];
  note: string;
}

export interface Labels {
  scenarioId: string;
  /** For each affected visit, the members who could take it on their own (given the rest unchanged). */
  feasible: Record<string, string[]>;
  maxCovered: number;
  /** Among plans covering maxCovered visits, the fewest that need a same-cleaner household's consent. */
  minConsent: number;
  optimalPlans: number;
}

export interface World {
  members: Member[];
  households: Household[];
}

export function violations(world: World, visits: Visit[], absent: Scenario["absent"]): string[] {
  const out: string[] = [];
  const hh = new Map(world.households.map((h) => [h.id, h]));
  for (const m of world.members) {
    const mine = visits.filter((v) => v.memberIds.includes(m.id)).sort((a, b) => a.start - b.start);
    let total = 0;
    for (const v of mine) {
      total += v.minutes;
      const h = hh.get(v.householdId)!;
      const day = Math.floor(v.start / 1440);
      const from = v.start % 1440;
      const to = from + v.minutes;
      if (!m.availability.some((w) => w.day === day && w.from <= from && to <= w.to)) out.push(`${v.id}:${m.id}:availability`);
      for (const need of h.needs) if (!m.skills.includes(need)) out.push(`${v.id}:${m.id}:skill:${need}`);
      for (const a of absent) {
        if (a.memberId === m.id && v.start < a.to && v.start + v.minutes > a.from) out.push(`${v.id}:${m.id}:absent`);
      }
    }
    if (total > m.weeklyHoursCap * 60) out.push(`${m.id}:hours:${total}`);
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]!;
        const b = mine[j]!;
        if (Math.floor(a.start / 1440) !== Math.floor(b.start / 1440)) continue;
        const gap = travelMinutes(hh.get(a.householdId)!.at, hh.get(b.householdId)!.at);
        if (a.start + a.minutes + gap > b.start) out.push(`${a.id}+${b.id}:${m.id}:overlap`);
      }
    }
  }
  return out;
}

function needsConsent(world: World, v: Visit, memberId: string): boolean {
  const h = world.households.find((x) => x.id === v.householdId)!;
  return h.sameCleaner && h.regularMemberId !== memberId;
}

export function label(world: World, s: Scenario): Labels {
  const base = s.visits;
  const affected = s.affected.map((id) => base.find((v) => v.id === id)!);
  const feasible: Record<string, string[]> = {};
  for (const v of affected) {
    feasible[v.id] = world.members
      .filter(
        (m) =>
          violations(
            world,
            base.map((x) => (x.id === v.id ? { ...x, memberIds: [m.id] } : x)),
            s.absent,
          ).length === 0,
      )
      .map((m) => m.id);
  }
  let maxCovered = 0;
  let minConsent = Infinity;
  let optimalPlans = 0;
  const choice: (string | null)[] = Array.from({ length: affected.length }, () => null);
  const options = [null, ...world.members.map((m) => m.id)];
  const walk = (i: number) => {
    if (i === affected.length) {
      const visits = base.map((x) => {
        const k = s.affected.indexOf(x.id);
        return k >= 0 && choice[k] ? { ...x, memberIds: [choice[k]!] } : x;
      });
      if (violations(world, visits, s.absent).length) return;
      const covered = choice.filter(Boolean).length;
      const consent = choice.filter((c, k) => c && needsConsent(world, affected[k]!, c)).length;
      if (covered > maxCovered || (covered === maxCovered && consent < minConsent)) {
        maxCovered = covered;
        minConsent = consent;
        optimalPlans = 1;
      } else if (covered === maxCovered && consent === minConsent) optimalPlans++;
      return;
    }
    for (const o of options) {
      choice[i] = o;
      walk(i + 1);
    }
    choice[i] = null;
  };
  walk(0);
  return { scenarioId: s.id, feasible, maxCovered, minConsent: minConsent === Infinity ? 0 : minConsent, optimalPlans };
}
