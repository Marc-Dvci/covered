// Builds the cover scenarios from the seed week and labels each one with the oracle. Run once; the
// output is committed before the solver exists. 60 development scenarios, 20 held out.
//   npx tsx eval/generate.ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Visit } from "../shared/domain.ts";
import { hm, households, members, seedVisits, STORY } from "../shared/seed.ts";
import { label, type Scenario } from "./oracle.ts";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261116);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const week = seedVisits();
const world = { members, households };
const workDays = (memberId: string) => [...new Set(week.filter((v) => v.memberIds.includes(memberId)).map((v) => Math.floor(v.start / 1440)))];

function unassign(visits: Visit[], ids: string[]): Visit[] {
  return visits.map((v) => (ids.includes(v.id) ? { ...v, memberIds: [] } : v));
}

function sick(id: string, memberIds: string[], day: number, from = 0): Scenario {
  const absent = memberIds.map((m) => ({ memberId: m, from: day * 1440 + from, to: day * 1440 + 1440 }));
  const affected = week
    .filter((v) => v.memberIds.some((m) => memberIds.includes(m)) && Math.floor(v.start / 1440) === day && v.start + v.minutes > day * 1440 + from)
    .map((v) => v.id);
  const kind = memberIds.length > 1 ? "two_sick" : from > 0 ? "sick_afternoon" : "sick";
  return { id, kind, day, absent, visits: unassign(week, affected), affected, note: `${memberIds.join(" and ")} out on day ${day}${from ? ` from ${Math.floor(from / 60)}:00` : ""}` };
}

const scenarios: Scenario[] = [];
const seen = new Set<string>();
function add(s: Scenario) {
  const key = JSON.stringify([s.kind, s.day, s.absent, s.affected, s.visits.filter((v) => s.affected.includes(v.id)).map((v) => [v.start, v.householdId])]);
  if (seen.has(key)) return false;
  seen.add(key);
  scenarios.push(s);
  return true;
}

add({ ...sick("story", [STORY.sickMemberId], STORY.day), note: "Sam's son has a fever (the demo story)" });

let n = 0;
const target: Record<Scenario["kind"], number> = { sick: 26, sick_afternoon: 12, two_sick: 10, new_request: 16, reschedule: 12, healthy: 4 };
const counts: Record<string, number> = { sick: 1 };
let guard = 0;
while (scenarios.length < 80 && guard++ < 10_000) {
  const kinds = (Object.keys(target) as Scenario["kind"][]).filter((k) => (counts[k] ?? 0) < target[k]);
  if (!kinds.length) break;
  const kind = pick(kinds);
  const id = `s${String(++n).padStart(3, "0")}`;
  let s: Scenario | undefined;
  if (kind === "sick") {
    const m = pick(members);
    s = sick(id, [m.id], pick(workDays(m.id)));
  } else if (kind === "sick_afternoon") {
    const m = pick(members);
    s = sick(id, [m.id], pick(workDays(m.id)), hm("12:00"));
  } else if (kind === "two_sick") {
    const a = pick(members);
    const b = pick(members.filter((x) => x.id !== a.id));
    const days = workDays(a.id).filter((d) => workDays(b.id).includes(d));
    if (!days.length) continue;
    s = sick(id, [a.id, b.id], pick(days));
    if (s.affected.length > 5) continue;
  } else if (kind === "new_request") {
    const h = pick(households);
    const day = Math.floor(rnd() * 5);
    const start = day * 1440 + hm(pick(["08:30", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00"]));
    const minutes = pick([120, 150, 180, 240]);
    const v: Visit = { id: `v-new-${id}`, householdId: h.id, memberIds: [], start, minutes, terms: { ...week[0]!.terms, bookedMinutes: minutes }, state: "scheduled" };
    s = { id, kind, day, absent: [], visits: [...week, v], affected: [v.id], note: `${h.name} ask for an extra visit` };
  } else if (kind === "reschedule") {
    const v = pick(week);
    const day = Math.floor(v.start / 1440);
    const shift = pick([-120, -90, -60, 60, 90, 120, 180]);
    const start = Math.max(day * 1440 + hm("07:00"), Math.min(day * 1440 + hm("17:00"), v.start + shift));
    const moved = week.map((x) => (x.id === v.id ? { ...x, start, memberIds: [] } : x));
    s = { id, kind, day, absent: [], visits: moved, affected: [v.id], note: `${v.householdId} move their visit by ${shift} minutes` };
  } else {
    s = { id, kind, day: Math.floor(rnd() * 5), absent: [], visits: week, affected: [], note: "an ordinary day, nothing to change" };
  }
  if (s && (s.affected.length > 0 || kind === "healthy") && add(s)) counts[kind] = (counts[kind] ?? 0) + 1;
}

// the story stays in development; the rest is shuffled before the split
const [story, ...rest] = scenarios;
for (let i = rest.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [rest[i], rest[j]] = [rest[j]!, rest[i]!];
}
const dev = [story!, ...rest.slice(0, 59)];
const heldout = rest.slice(59, 79);

// the files store only the visits a scenario changes; the rest is the seed week, pinned by this hash
const worldHash = createHash("sha256").update(JSON.stringify({ members, households, week })).digest("hex").slice(0, 16);
for (const [dir, set] of [["eval/disruptions", dev], ["eval/heldout", heldout]] as const) {
  mkdirSync(dir, { recursive: true });
  const labels = set.map((s) => label(world, s));
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ worldHash, count: set.length, generator: "eval/generate.ts", seed: 20261116 }, null, 1));
  writeFileSync(`${dir}/scenarios.json`, JSON.stringify(set.map((s) => ({ ...s, visits: s.visits.filter((v) => s.affected.includes(v.id) || v.id.startsWith("v-new")) })), null, 1));
  writeFileSync(`${dir}/labels.json`, JSON.stringify(labels, null, 1));
  const byKind = set.reduce<Record<string, number>>((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
  console.log(dir, set.length, "scenarios", byKind, "affected visits", set.reduce((a, s) => a + s.affected.length, 0),
    "fully coverable", labels.filter((l, i) => l.maxCovered === set[i]!.affected.length).length);
}
