// The written agreement a household signs before the first visit, and the checklist that decides
// whether it can be signed. The fields follow Seattle's Domestic Workers Ordinance as amended by
// Council Bill 121266 (passed 15 Sep 2026): scope of work, location, hours, pay rate, payment
// schedule, cancellation policy, expenses, classification, benefits and leave. This is a template, not
// legal advice; the model may draft it, but only this file decides whether it is complete.
import { DEFAULT_TERMS, type Lang, type Skill } from "./domain.ts";

/** Seattle minimum hourly wage for domestic workers, 2026 (Office of Labor Standards). */
export const SEATTLE_MIN_RATE_CENTS = 2130;

export interface Agreement {
  householdName: string;
  contact: string;
  area: string;
  language: Lang;
  scope: string[];
  location: string;
  schedule: { weekday: number | null; start: string | null; minutes: number | null; frequency: "weekly" | "every_two_weeks" | "once" | null };
  rateCentsPerHour: number | null;
  paymentSchedule: string | null;
  cancellation: { noticeHours: number | null; lateCancelPct: number | null; lockoutPct: number | null };
  extraAllowanceMinutes: number;
  expenses: string | null;
  classification: string | null;
  benefits: string | null;
  leave: string | null;
  needs: Skill[];
  sameCleaner: boolean;
  memberTerms: string | null; // what the member asked for, in their words
}

export type Field =
  | "scope" | "location" | "schedule" | "rate" | "rate_floor" | "payment_schedule"
  | "cancellation" | "expenses" | "classification" | "benefits" | "leave";

export const ORDINANCE_FIELDS: { field: Field; label: string; question: string }[] = [
  { field: "scope", label: "Scope of work", question: "What should be cleaned on each visit?" },
  { field: "location", label: "Location", question: "Where is the home (neighborhood and street)?" },
  { field: "schedule", label: "Hours and schedule", question: "Which day, what time, and for how long?" },
  { field: "rate", label: "Rate of pay", question: "What is the hourly rate?" },
  { field: "rate_floor", label: "Rate at or above the Seattle minimum", question: "The rate must be at least $21.30 an hour. What rate should we use?" },
  { field: "payment_schedule", label: "Payment schedule", question: "How and when is each visit paid?" },
  { field: "cancellation", label: "Cancellation policy", question: "How much notice to cancel, and what fee applies inside that notice?" },
  { field: "expenses", label: "Expenses", question: "Who provides cleaning supplies and pays for parking?" },
  { field: "classification", label: "Classification", question: "Who does the work, and in what capacity?" },
  { field: "benefits", label: "Benefits", question: "Which benefits come with the work?" },
  { field: "leave", label: "Leave", question: "How is paid sick and safe time handled?" },
];

export function missing(a: Agreement): Field[] {
  const out: Field[] = [];
  if (!a.scope.length || a.scope.every((s) => !s.trim())) out.push("scope");
  if (!a.location?.trim()) out.push("location");
  const s = a.schedule;
  if (s.weekday === null || !s.start || !s.minutes || s.minutes < 60 || s.minutes > 600 || !s.frequency) out.push("schedule");
  if (a.rateCentsPerHour === null || a.rateCentsPerHour <= 0) out.push("rate");
  else if (a.rateCentsPerHour < SEATTLE_MIN_RATE_CENTS) out.push("rate_floor");
  if (!a.paymentSchedule?.trim()) out.push("payment_schedule");
  const c = a.cancellation;
  if (c.noticeHours === null || c.lateCancelPct === null || c.lockoutPct === null
    || c.noticeHours < 1 || c.noticeHours > 72 || c.lateCancelPct < 0 || c.lateCancelPct > 100 || c.lockoutPct < 0 || c.lockoutPct > 100) out.push("cancellation");
  if (!a.expenses?.trim()) out.push("expenses");
  if (!a.classification?.trim()) out.push("classification");
  if (!a.benefits?.trim()) out.push("benefits");
  if (!a.leave?.trim()) out.push("leave");
  return out;
}

/** The cooperative's standing answers for the fields households rarely know how to fill. */
export const COOP_STANDARD = {
  paymentSchedule:
    "Your saved PayPal is authorized for the visit price plus the extra-time allowance 24 hours before each visit. The visit is paid when it ends; anything not used is released the same minute.",
  classification:
    "The work is done by member-owners of the cooperative. The cooperative is the hiring entity and pays its members; the household is a client of the cooperative.",
  benefits: "Members share the cooperative's surplus and its benefits fund; the household pays no benefits directly.",
  leave: "Members accrue paid sick and safe time through the cooperative. When a member is out, the cooperative offers a replacement or reschedules.",
  expenses: "Supplies are brought by the member. Parking, if paid, is added to the visit at cost with a receipt.",
};

export function blank(householdName = "", language: Lang = "en"): Agreement {
  return {
    householdName, contact: "", area: "", language, scope: [], location: "",
    schedule: { weekday: null, start: null, minutes: null, frequency: null },
    rateCentsPerHour: DEFAULT_TERMS.rateCentsPerHour,
    paymentSchedule: COOP_STANDARD.paymentSchedule,
    cancellation: { noticeHours: DEFAULT_TERMS.noticeHours, lateCancelPct: DEFAULT_TERMS.lateCancelPct, lockoutPct: DEFAULT_TERMS.lockoutPct },
    extraAllowanceMinutes: DEFAULT_TERMS.extraAllowanceMinutes,
    expenses: COOP_STANDARD.expenses, classification: COOP_STANDARD.classification,
    benefits: COOP_STANDARD.benefits, leave: COOP_STANDARD.leave,
    needs: [], sameCleaner: false, memberTerms: null,
  };
}
