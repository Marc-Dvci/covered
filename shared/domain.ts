// Shared vocabulary for the server, the workflows and the web app. Money is integer cents; time on the
// board is minutes from the start of the cooperative's week (Monday 00:00, cooperative time zone).

export type Lang = "en" | "pt" | "pl" | "es" | "fr" | "zh" | "ko" | "vi" | "ru" | "so" | "it";
export type Skill = "pets" | "deep_clean" | "eco";
export type Wallet = "PAYPAL" | "VENMO";

export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  pt: "Português",
  pl: "Polski",
  es: "Español",
  fr: "Français",
  zh: "中文",
  ko: "한국어",
  vi: "Tiếng Việt",
  ru: "Русский",
  so: "Soomaali",
  it: "Italiano",
};

export interface Point {
  lat: number;
  lon: number;
}

/** A recurring weekly window, minutes from midnight. */
export interface Window {
  day: number; // 0 = Monday
  from: number;
  to: number;
}

export interface Member {
  id: string;
  name: string;
  languages: Lang[]; // first one is the language messages are written in
  skills: Skill[];
  weeklyHoursCap: number;
  home: Point;
  area: string;
  availability: Window[];
  payout: { wallet: Wallet; receiver: string };
}

export interface Household {
  id: string;
  name: string;
  area: string;
  at: Point;
  language: Lang;
  needs: Skill[];
  sameCleaner: boolean;
  regularMemberId?: string;
  contact: string; // display only, fictional
}

export interface Terms {
  rateCentsPerHour: number;
  bookedMinutes: number; // person-minutes
  noticeHours: number;
  lateCancelPct: number;
  lockoutPct: number;
  extraAllowanceMinutes: number;
  extraStepMinutes: number;
  coopShareBps: number;
  holdLeadMinutes: number;
}

export const DEFAULT_TERMS: Terms = {
  rateCentsPerHour: 3500,
  bookedMinutes: 240,
  noticeHours: 24,
  lateCancelPct: 50,
  lockoutPct: 100,
  extraAllowanceMinutes: 30,
  extraStepMinutes: 15,
  coopShareBps: 500,
  holdLeadMinutes: 10,
};

export type VisitState =
  | "done" // seeded history: before the demo clock started, no money moved
  | "scheduled"
  | "holding" // hold requested, not yet confirmed
  | "held"
  | "at_risk" // hold failed
  | "in_progress"
  | "settling"
  | "captured"
  | "paid_out"
  | "late_cancel"
  | "cancelled"
  | "voided";

export interface Visit {
  id: string;
  householdId: string;
  memberIds: string[];
  start: number; // minutes from week start
  minutes: number; // clock minutes on site
  terms: Terms;
  state: VisitState;
}

export const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function dayOf(t: number): number {
  return Math.floor(t / 1440);
}

export function clock(t: number): string {
  const m = ((t % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function when(t: number): string {
  return `${WEEK_DAYS[dayOf(t)] ?? "?"} ${clock(t)}`;
}

export function dollars(cents: number): string {
  const s = cents < 0 ? "-" : "";
  const c = Math.abs(cents);
  return `${s}$${Math.floor(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;
}
