// The cover agent. A member's message becomes a disruption; the agent works through function calls
// over the solver and the board, picks one of the solver's plans and drafts each message in the
// recipient's language. It cannot invent an assignment: submit_plan only accepts a plan rank the
// solver returned, recipients must be people the plan touches, and any number in a message must be one
// the tools gave it. If the model is unavailable or fails these checks, the solver's best plan goes out
// with template messages.
import { randomUUID } from "node:crypto";
import { clock, dollars, LANG_NAMES, WEEK_DAYS, type Household, type Lang, type Member } from "../../shared/domain.ts";
import { WEEK_START_ISO } from "../../shared/seed.ts";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function longDay(t: number): string {
  const d = new Date(`${WEEK_START_ISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(t / 1440));
  return `${DAY_NAMES[Math.floor(t / 1440) % 7]} ${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`;
}
import { activeAbsences, holdText } from "../actions.ts";
import { AIUnavailable, numbersOk, type Gemini } from "../ai/gemini.ts";
import type { Store, VisitRow } from "../store.ts";
import { solve, type Plan, type SolveResult } from "./solver.ts";

export interface Message {
  toId: string;
  toKind: "member" | "household";
  language: Lang;
  text: string;
  english?: string;
}

export interface Proposal {
  id: string;
  disruptionId: string;
  plan: Plan;
  alternatives: Plan[];
  why: string;
  messages: Message[];
  source: "live" | "recorded" | "cached" | "template";
  model?: string;
  turns: { call: string; args: unknown }[];
  rejected: string[];
  createdAt: number;
}

export interface Disruption {
  id: string;
  memberId: string;
  text: string;
  kind: "out_today" | "out_from" | "other";
  day: number;
  fromMin: number;
  affected: string[];
  status: "open" | "proposed" | "approved" | "dismissed";
  proposal: Proposal | null;
  boardAt: number;
}

const OUT_WORDS = /\b(sick|ill|fever|flu|covid|can.?t (come|make|work)|cannot (come|make|work)|won.?t (be able|make)|emergency|hospital|not coming|stay home|doente|chory|enferm|malade)\b/i;

/** Read a member's message: are they out, and from when? Model first, keywords as the fallback. */
export async function intake(ai: Gemini | null, text: string, now: number, visitor?: string): Promise<{ kind: Disruption["kind"]; fromMin: number; source: string }> {
  const minuteOfDay = now % 1440;
  if (ai) {
    try {
      const r = await ai.json<{ kind: Disruption["kind"]; from_time: string | null }>("intake", "light",
        "A member of a house-cleaning cooperative sent the coordinator a message. Decide whether they cannot work today (out_today), will stop working from a time today (out_from, give from_time as HH:MM, 24-hour), or neither (other). Answer only from the message.",
        [{ text: `Time now: ${clock(now)}.\nMessage: ${text}` }],
        { type: "OBJECT", properties: { kind: { type: "STRING", enum: ["out_today", "out_from", "other"] }, from_time: { type: "STRING", nullable: true } }, required: ["kind"] },
        visitor);
      const m = r.from_time?.match(/^(\d{1,2}):(\d{2})$/);
      const from = r.kind === "out_from" && m ? Number(m[1]) * 60 + Number(m[2]) : minuteOfDay;
      return { kind: r.kind, fromMin: Math.max(minuteOfDay, from), source: ai.last?.source ?? "live" };
    } catch (e) {
      if (!(e instanceof AIUnavailable)) throw e;
    }
  }
  return { kind: OUT_WORDS.test(text) ? "out_today" : "other", fromMin: minuteOfDay, source: "rules" };
}

export async function openDisruption(store: Store, ai: Gemini | null, memberId: string, text: string, visitor?: string): Promise<Disruption> {
  const now = await store.now();
  const day = Math.floor(now / 1440);
  const read = await intake(ai, text, now, visitor);
  const from = day * 1440 + read.fromMin;
  const affected = read.kind === "other" ? [] : (await store.visits())
    .filter((v) => v.memberIds.includes(memberId) && Math.floor(v.start / 1440) === day && v.start + v.minutes > from && ["scheduled", "holding", "held", "at_risk"].includes(v.state))
    .map((v) => v.id);
  const d: Disruption = { id: `d-${randomUUID().slice(0, 8)}`, memberId, text, kind: read.kind, day, fromMin: read.fromMin, affected, status: "open", proposal: null, boardAt: now };
  await store.db.query("insert into disruptions(id, board_at, member_id, text, kind, day, from_min, affected, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [d.id, now, memberId, text, d.kind, day, read.fromMin, JSON.stringify(affected), d.status]);
  await store.event("disruption.opened", null, memberId, { id: d.id, kind: d.kind, affected, read: read.source });
  return d;
}

export async function getDisruption(store: Store, id: string): Promise<Disruption | null> {
  const r = await store.db.query<Record<string, unknown>>("select * from disruptions where id = $1", [id]);
  return r[0] ? rowToDisruption(r[0]) : null;
}

export async function listDisruptions(store: Store): Promise<Disruption[]> {
  return (await store.db.query<Record<string, unknown>>("select * from disruptions order by rowid desc")).map(rowToDisruption);
}

function rowToDisruption(r: Record<string, unknown>): Disruption {
  return {
    id: r.id as string, memberId: r.member_id as string, text: r.text as string, kind: r.kind as Disruption["kind"],
    day: r.day as number, fromMin: r.from_min as number, affected: r.affected as string[], status: r.status as Disruption["status"],
    proposal: (r.proposal as Proposal) ?? null, boardAt: r.board_at as number,
  };
}

interface Facts {
  out: Member;
  visits: VisitRow[];
  members: Member[];
  households: Household[];
  solved: SolveResult;
}

function visitLine(f: Facts, v: VisitRow) {
  const h = f.households.find((x) => x.id === v.householdId)!;
  return {
    visit_id: v.id, household: h.name, household_id: h.id, area: h.area, language: LANG_NAMES[h.language],
    day: longDay(v.start), start: clock(v.start), end: clock(v.start + v.minutes), hours: v.minutes / 60,
    needs: h.needs, same_cleaner_requested: h.sameCleaner, payment: holdText(v),
  };
}

function planLines(f: Facts) {
  const name = (id: string | null) => (id ? f.members.find((m) => m.id === id)!.name : null);
  return f.solved.plans.map((p) => ({
    plan_rank: p.rank, visits_covered: p.covered, of: f.visits.length, needs_household_ok: p.consent,
    in_household_language: p.language, added_travel_minutes: p.addedTravel,
    assignments: p.assignments.map((a) => ({ visit_id: a.visitId, member: name(a.memberId), member_id: a.memberId, needs_household_ok: a.consent, speaks_household_language: a.language })),
  }));
}

function candidateLines(f: Facts) {
  return Object.fromEntries(Object.entries(f.solved.candidates).map(([vid, cs]) => [vid, cs.map((c) => ({
    member: f.members.find((m) => m.id === c.memberId)!.name, member_id: c.memberId, can_take: c.ok, why_not: c.reasons, needs_household_ok: c.consent,
  }))]));
}

/** Who should hear about this plan, and in which language. */
export function recipients(f: Facts, p: Plan): { id: string; kind: "member" | "household"; language: Lang; name: string }[] {
  const out = new Map<string, { id: string; kind: "member" | "household"; language: Lang; name: string }>();
  out.set(f.out.id, { id: f.out.id, kind: "member", language: f.out.languages[0]!, name: f.out.name });
  for (const a of p.assignments) {
    if (a.memberId) {
      const m = f.members.find((x) => x.id === a.memberId)!;
      out.set(m.id, { id: m.id, kind: "member", language: m.languages[0]!, name: m.name });
    }
    const v = f.visits.find((x) => x.id === a.visitId)!;
    const h = f.households.find((x) => x.id === v.householdId)!;
    out.set(h.id, { id: h.id, kind: "household", language: h.language, name: h.name });
  }
  return [...out.values()];
}

function allowedNumbers(f: Facts): (string | number)[] {
  const nums: (string | number)[] = [];
  for (const v of f.visits) {
    nums.push(clock(v.start), clock(v.start + v.minutes), v.minutes / 60, v.minutes, longDay(v.start));
    if (v.hold) nums.push(dollars(v.hold.cents));
  }
  for (const p of f.solved.plans) nums.push(p.covered, p.consent, p.addedTravel);
  nums.push(f.visits.length, 1, 2, 3, 4, 24);
  return nums;
}

const TOOLS = [
  {
    name: "find_cover",
    description: "Run the cooperative's cover solver for the affected visits. Returns, for each visit, every member with can_take and the reasons when not, and up to three complete plans ranked best first. Only these plans can be proposed.",
    parameters: { type: "OBJECT", properties: { visit_ids: { type: "ARRAY", items: { type: "STRING" } } }, required: ["visit_ids"] },
  },
  {
    name: "hold_status",
    description: "The payment state of one visit: how much is held on the household's PayPal.",
    parameters: { type: "OBJECT", properties: { visit_id: { type: "STRING" } }, required: ["visit_id"] },
  },
  {
    name: "submit_plan",
    description: "Propose one of the solver's plans to the coordinator, with one short message per recipient, each written in the recipient's language. Recipients are given by find_cover's caller in the task.",
    parameters: {
      type: "OBJECT",
      properties: {
        plan_rank: { type: "INTEGER" },
        why: { type: "STRING", description: "Two sentences for the coordinator, in English, on why this plan." },
        messages: {
          type: "ARRAY",
          items: { type: "OBJECT", properties: { to_id: { type: "STRING" }, language: { type: "STRING" }, text: { type: "STRING" }, english: { type: "STRING", description: "English version, for the coordinator." } }, required: ["to_id", "language", "text", "english"] },
        },
      },
      required: ["plan_rank", "why", "messages"],
    },
  },
];

const SYSTEM = `You are the dispatch assistant of a house-cleaning cooperative. A member cannot work, and their visits need cover.
Work only through the tools. First call find_cover with the affected visit ids. Then call submit_plan once.
Rules:
- Propose only a plan_rank that find_cover returned. Prefer rank 1 unless another plan is clearly kinder to the people involved, and say why.
- A household that asked for the same cleaner must be asked first; tell them who would come instead and that they can say no.
- Write one message per recipient listed in the task, in that recipient's language code, warm and short (at most three sentences). Give the day, the time and the home. Do not mention pay rates, fees, or anyone's health beyond "is out today".
- Use only numbers the tools gave you (times, hours, amounts). Never invent a time or an amount.
- Never move money and never promise anything about payments beyond what hold_status says.`;

export async function propose(store: Store, ai: Gemini | null, disruptionId: string, visitor?: string): Promise<Proposal> {
  const d = await getDisruption(store, disruptionId);
  if (!d) throw new Error("no such disruption");
  const [members, households, visits] = await Promise.all([store.members(), store.households(), store.visits()]);
  const affected = visits.filter((v) => d.affected.includes(v.id));
  const absences = await activeAbsences(store);
  const solved = solve({ members, households, visits, absences, affected: d.affected });
  const f: Facts = { out: members.find((m) => m.id === d.memberId)!, visits: affected, members, households, solved };
  const turns: Proposal["turns"] = [];
  const rejected: string[] = [];

  let proposal: Proposal | null = null;
  if (ai && solved.plans.length && affected.length) {
    const allowed = allowedNumbers(f);
    const task = {
      who_is_out: f.out.name, their_message: d.text, day: longDay(d.day * 1440), now: clock(d.boardAt),
      affected_visits: affected.map((v) => visitLine(f, v)),
    };
    const contents: unknown[] = [{ role: "user", parts: [{ text: `Task:\n${JSON.stringify(task, null, 1)}` }] }];
    try {
      for (let step = 0; step < 6 && !proposal; step++) {
        const reply = await ai.turn("cover-agent", SYSTEM, contents, TOOLS, visitor);
        contents.push(reply);
        const calls = reply.parts.filter((p) => p.functionCall).map((p) => p.functionCall as { name: string; args: Record<string, unknown> });
        if (!calls.length) {
          contents.push({ role: "user", parts: [{ text: "Use the tools: call find_cover, then submit_plan." }] });
          continue;
        }
        const responses: unknown[] = [];
        for (const call of calls) {
          turns.push({ call: call.name, args: call.args });
          let response: unknown;
          if (call.name === "find_cover") {
            const plans = planLines(f);
            const best = plans[0];
            const rec = best ? recipients(f, solved.plans[0]!).map((r) => ({ to_id: r.id, name: r.name, kind: r.kind, language: r.language })) : [];
            response = { candidates: candidateLines(f), plans, recipients_for_rank_1: rec, recipients_rule: "Recipients are the member who is out, every member a plan assigns, and every household whose visit it changes." };
          } else if (call.name === "hold_status") {
            const v = affected.find((x) => x.id === call.args.visit_id);
            response = v ? { visit_id: v.id, payment: holdText(v), held_cents: v.hold?.cents ?? 0 } : { error: "not an affected visit" };
          } else if (call.name === "submit_plan") {
            const rank = Number(call.args.plan_rank);
            const plan = solved.plans.find((p) => p.rank === rank);
            const msgs = (call.args.messages as { to_id: string; language: string; text: string; english?: string }[]) ?? [];
            const want = plan ? recipients(f, plan) : [];
            const problems: string[] = [];
            if (!plan) problems.push(`plan_rank ${rank} is not one of the solver's plans`);
            for (const r of want) if (!msgs.some((m) => m.to_id === r.id)) problems.push(`missing a message to ${r.id}`);
            for (const m of msgs) {
              const r = want.find((x) => x.id === m.to_id);
              if (!r) problems.push(`${m.to_id} is not affected by this plan`);
              else if (m.language !== r.language) problems.push(`message to ${m.to_id} must be in ${r.language}`);
              if (!numbersOk(m.text, allowed) || (m.english && !numbersOk(m.english, allowed))) problems.push(`message to ${m.to_id} contains a number the tools did not give`);
            }
            if (problems.length) {
              rejected.push(...problems);
              response = { accepted: false, problems };
            } else {
              proposal = {
                id: `p-${randomUUID().slice(0, 8)}`, disruptionId: d.id, plan: plan!, alternatives: solved.plans.filter((p) => p.rank !== rank),
                why: String(call.args.why ?? ""), turns, rejected, createdAt: await store.now(),
                messages: msgs.map((m) => ({ toId: m.to_id, toKind: want.find((r) => r.id === m.to_id)!.kind, language: m.language as Lang, text: m.text, english: m.english })),
                source: ai.last?.source ?? "live", model: ai.last?.model,
              };
              response = { accepted: true };
            }
          } else response = { error: "unknown tool" };
          responses.push({ functionResponse: { name: call.name, response: { result: response } } });
        }
        contents.push({ role: "user", parts: responses });
      }
    } catch (e) {
      if (!(e instanceof AIUnavailable)) throw e;
      rejected.push(`model unavailable: ${(e as Error).message}`);
    }
  }
  proposal ??= templateProposal(f, d, turns, rejected, await store.now());
  await store.db.query("update disruptions set proposal = $2, status = 'proposed' where id = $1", [d.id, JSON.stringify(proposal)]);
  await store.event("disruption.proposed", null, "agent", { id: d.id, source: proposal.source, rank: proposal.plan?.rank, covered: proposal.plan?.covered });
  return proposal;
}

const T: Partial<Record<Lang, { ask: string; tell: string; consent: string; out: string; done: string }>> = {
  en: { ask: "Hi {name}, {out} is out today. Can you take {home} on {day} at {start} to {end}?", tell: "Hi {name}, {out} is out today. {member} will clean on {day} at {start} as planned. Your payment stays as it is.", consent: "Hi {name}, {out} is out today. {member} can come on {day} at {start} instead. Is that OK? You can say no.", out: "Get well soon, {name}. Your visits today are covered.", done: "" },
  pt: { ask: "Olá {name}, {out} está fora hoje. Pode fazer {home} na {day} das {start} às {end}?", tell: "Olá {name}, {out} está fora hoje. {member} fará a limpeza na {day} às {start}, como combinado.", consent: "Olá {name}, {out} está fora hoje. {member} pode ir na {day} às {start}. Tudo bem? Pode dizer não.", out: "As melhoras, {name}. As suas visitas de hoje estão cobertas.", done: "" },
  pl: { ask: "Cześć {name}, {out} jest dziś nieobecny. Czy możesz wziąć {home} w {day} od {start} do {end}?", tell: "Dzień dobry {name}, {out} jest dziś nieobecny. {member} posprząta w {day} o {start}, jak planowano.", consent: "Dzień dobry {name}, {out} jest dziś nieobecny. {member} może przyjść w {day} o {start}. Czy to w porządku? Można odmówić.", out: "Zdrowiej szybko, {name}. Twoje dzisiejsze wizyty są pokryte.", done: "" },
  es: { ask: "Hola {name}, {out} no puede venir hoy. ¿Puedes tomar {home} el {day} de {start} a {end}?", tell: "Hola {name}, {out} no puede venir hoy. {member} limpiará el {day} a las {start}, como estaba previsto.", consent: "Hola {name}, {out} no puede venir hoy. {member} puede ir el {day} a las {start}. ¿Le parece bien? Puede decir que no.", out: "Que te mejores, {name}. Tus visitas de hoy están cubiertas.", done: "" },
};

function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

export function templateProposal(f: Facts, d: Disruption, turns: Proposal["turns"], rejected: string[], now: number): Proposal {
  const plan = f.solved.plans[0] ?? { rank: 1, assignments: [], covered: 0, consent: 0, language: 0, familiar: 0, addedTravel: 0 };
  const messages: Message[] = [];
  for (const r of recipients(f, plan)) {
    const t = T[r.language] ?? T.en!;
    const en = T.en!;
    const firstName = r.name.split(" ")[0]!;
    let text: string;
    let english: string;
    if (r.id === f.out.id) {
      text = fill(t.out, { name: firstName });
      english = fill(en.out, { name: firstName });
    } else if (r.kind === "member") {
      const mine = plan.assignments.filter((a) => a.memberId === r.id).map((a) => f.visits.find((v) => v.id === a.visitId)!);
      const parts = mine.map((v) => {
        const vars = { name: firstName, out: f.out.name.split(" ")[0]!, home: f.households.find((h) => h.id === v.householdId)!.name, day: WEEK_DAYS[Math.floor(v.start / 1440)]!, start: clock(v.start), end: clock(v.start + v.minutes) };
        return [fill(t.ask, vars), fill(en.ask, vars)] as const;
      });
      text = parts.map((p) => p[0]).join(" ");
      english = parts.map((p) => p[1]).join(" ");
    } else {
      const a = plan.assignments.find((x) => f.visits.find((v) => v.id === x.visitId)!.householdId === r.id)!;
      const v = f.visits.find((x) => x.id === a.visitId)!;
      const member = a.memberId ? f.members.find((m) => m.id === a.memberId)!.name.split(" ")[0]! : "";
      const vars = { name: r.name, out: f.out.name.split(" ")[0]!, member, day: WEEK_DAYS[Math.floor(v.start / 1440)]!, start: clock(v.start) };
      const key = !a.memberId ? null : a.consent ? "consent" : "tell";
      text = key ? fill(t[key], vars) : `${r.name}: ${vars.out} is out today and nobody can cover ${vars.day} ${vars.start}. Your hold will be released.`;
      english = key ? fill(en[key], vars) : text;
    }
    messages.push({ toId: r.id, toKind: r.kind, language: T[r.language] ? r.language : "en", text, english });
  }
  return {
    id: `p-${randomUUID().slice(0, 8)}`, disruptionId: d.id, plan, alternatives: f.solved.plans.slice(1),
    why: plan.covered === f.visits.length ? `Plan 1 covers all ${f.visits.length} visits${plan.consent ? `; ${plan.consent} household needs to agree first` : ""}.` : `Plan 1 covers ${plan.covered} of ${f.visits.length} visits.`,
    messages, source: "template", turns, rejected, createdAt: now,
  };
}
