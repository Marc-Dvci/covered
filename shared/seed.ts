// The demo cooperative: ten cleaning members in Seattle, thirty-six households, one week of visits.
// All people are fictional. The week is laid out so that Thursday can be rearranged when Sam calls in
// sick: Teresa, Marek and Ines have room, and Sam's three homes need pets, a same-cleaner consent and travel time.
import { DEFAULT_TERMS, type Household, type Lang, type Member, type Point, type Skill, type Visit } from "./domain.ts";

export const WEEK_START_ISO = "2026-11-16"; // Monday, America/Los_Angeles
export const TIME_ZONE = "America/Los_Angeles";
export const COOP = { name: "Rainier Home Care Cooperative", coordinator: "Dana", city: "Seattle" };

const AREAS: Record<string, Point> = {
  Ballard: { lat: 47.6687, lon: -122.3847 },
  Fremont: { lat: 47.6505, lon: -122.3509 },
  "Queen Anne": { lat: 47.6374, lon: -122.357 },
  "Capitol Hill": { lat: 47.6253, lon: -122.3222 },
  "First Hill": { lat: 47.609, lon: -122.324 },
  Eastlake: { lat: 47.64, lon: -122.326 },
  "Madison Park": { lat: 47.634, lon: -122.2785 },
  "Beacon Hill": { lat: 47.579, lon: -122.3115 },
  "Columbia City": { lat: 47.5598, lon: -122.2866 },
  "Mount Baker": { lat: 47.577, lon: -122.29 },
  "Seward Park": { lat: 47.55, lon: -122.265 },
  "Rainier Valley": { lat: 47.544, lon: -122.276 },
  "Rainier Beach": { lat: 47.5223, lon: -122.2685 },
  Georgetown: { lat: 47.5469, lon: -122.322 },
  "West Seattle": { lat: 47.5667, lon: -122.3868 },
  Alki: { lat: 47.579, lon: -122.409 },
  Delridge: { lat: 47.556, lon: -122.36 },
  "University District": { lat: 47.6615, lon: -122.3138 },
  Wallingford: { lat: 47.6615, lon: -122.3346 },
  Ravenna: { lat: 47.675, lon: -122.301 },
  Wedgwood: { lat: 47.69, lon: -122.29 },
  "Green Lake": { lat: 47.68, lon: -122.327 },
  Greenwood: { lat: 47.6907, lon: -122.355 },
  "Phinney Ridge": { lat: 47.674, lon: -122.354 },
  Northgate: { lat: 47.706, lon: -122.326 },
  Magnolia: { lat: 47.6505, lon: -122.404 },
};

function at(area: string): Point {
  const p = AREAS[area];
  if (!p) throw new Error(`unknown area ${area}`);
  return p;
}

const weekdays = (from: string, to: string, days: number[]) => days.map((day) => ({ day, from: hm(from), to: hm(to) }));

export function hm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
}

type M = [id: string, name: string, langs: Lang[], skills: Skill[], cap: number, area: string, avail: ReturnType<typeof weekdays>, wallet: "PAYPAL" | "VENMO"];
const MEMBERS: M[] = [
  ["sam", "Sam Becker", ["en"], ["pets", "deep_clean"], 32, "Columbia City", weekdays("08:00", "18:30", [0, 1, 2, 3, 4]), "PAYPAL"],
  ["teresa", "Teresa Almeida", ["pt", "en"], ["pets", "eco"], 32, "Beacon Hill", weekdays("08:00", "18:00", [0, 1, 2, 3, 4]), "PAYPAL"],
  ["marek", "Marek Nowak", ["pl", "en"], ["deep_clean", "pets"], 36, "Greenwood", weekdays("07:30", "17:00", [0, 1, 2, 3, 4, 5]), "PAYPAL"],
  ["grace", "Grace Liu", ["zh", "en"], ["eco", "pets"], 24, "University District", weekdays("09:00", "17:00", [0, 1, 2, 3]), "PAYPAL"],
  ["amara", "Amara Diallo", ["fr", "en"], ["pets", "deep_clean", "eco"], 30, "Rainier Valley", weekdays("08:00", "16:00", [1, 2, 3, 4, 5]), "PAYPAL"],
  ["lena", "Lena Petrova", ["ru", "en"], ["deep_clean"], 28, "Ballard", weekdays("10:00", "19:00", [0, 1, 2, 3, 4]), "PAYPAL"],
  ["tomas", "Tomás Reyes", ["es", "en"], ["pets"], 36, "West Seattle", weekdays("07:00", "15:30", [0, 1, 2, 3, 4]), "PAYPAL"],
  ["joy", "Joy Mensah", ["en"], ["eco"], 20, "Capitol Hill", weekdays("09:00", "18:00", [0, 2, 4]), "PAYPAL"],
  ["ines", "Ines Duarte", ["es", "pt", "en"], ["pets", "eco"], 30, "Fremont", weekdays("09:00", "17:00", [0, 1, 2, 3, 4]), "PAYPAL"],
  ["kofi", "Kofi Asante", ["en", "fr"], ["deep_clean", "pets"], 30, "Mount Baker", weekdays("08:00", "17:00", [0, 1, 2, 3, 4, 5]), "PAYPAL"],
];

export const members: Member[] = MEMBERS.map(([id, name, languages, skills, weeklyHoursCap, area, availability, wallet]) => ({
  id,
  name,
  languages,
  skills,
  weeklyHoursCap,
  area,
  home: at(area),
  availability,
  payout:
    wallet === "VENMO"
      ? { wallet, receiver: "+1 206 555 01" + String(MEMBERS.findIndex((m) => m[0] === id)).padStart(2, "0") }
      : { wallet, receiver: `${id}@covered.example` },
}));

type H = [id: string, name: string, area: string, lang: Lang, needs: Skill[], regular?: string];
const HOUSEHOLDS: H[] = [
  ["okafor", "The Okafors", "Queen Anne", "en", ["pets"], "sam"],
  ["lindqvist", "Mr. Lindqvist", "Ballard", "en", []],
  ["brennan", "The Brennans", "Fremont", "en", ["eco"]],
  ["nguyen", "The Nguyens", "Beacon Hill", "vi", ["pets"]],
  ["hassan", "The Hassans", "Columbia City", "so", []],
  ["chen", "Ms. Chen", "University District", "zh", ["eco"], "grace"],
  ["adeyemi", "The Adeyemis", "Greenwood", "en", ["deep_clean"]],
  ["kowalski", "Mrs. Kowalski", "Magnolia", "pl", [], "marek"],
  ["rossi", "The Rossis", "Capitol Hill", "it", ["pets"]],
  ["fischer", "The Fischers", "Wallingford", "en", []],
  ["morales", "The Moraleses", "West Seattle", "es", ["pets"]],
  ["obrien", "Ms. O'Brien", "Madison Park", "en", []],
  ["sato", "The Satos", "Ravenna", "en", ["eco"]],
  ["ivanova", "Ms. Ivanova", "Northgate", "ru", []],
  ["martin", "The Martins", "Georgetown", "en", ["pets"]],
  ["ahmed", "Mr. Ahmed", "First Hill", "en", []],
  ["weber", "The Webers", "Eastlake", "en", []],
  ["kim", "The Kims", "Capitol Hill", "ko", []],
  ["haddad", "The Haddads", "Phinney Ridge", "en", []],
  ["larsen", "Mr. Larsen", "Ballard", "en", []],
  ["osei", "The Oseis", "Wedgwood", "en", []],
  ["novak", "Ms. Novak", "Green Lake", "en", []],
  ["tran", "The Trans", "Rainier Valley", "vi", []],
  ["santos", "The Santoses", "Columbia City", "pt", []],
  ["ali", "The Alis", "Rainier Beach", "so", []],
  ["dubois", "Mr. Dubois", "Mount Baker", "fr", []],
  ["garcia", "The Garcias", "Delridge", "es", []],
  ["murphy", "The Murphys", "Seward Park", "en", ["pets"]],
  ["kaur", "Ms. Kaur", "Beacon Hill", "en", []],
  ["petersen", "The Petersens", "Alki", "en", []],
  ["yilmaz", "The Yilmazes", "Mount Baker", "en", []],
  ["abebe", "Mr. Abebe", "Rainier Valley", "en", ["deep_clean"]],
  ["lopez", "The Lopezes", "Beacon Hill", "es", ["pets"]],
  ["bauer", "The Bauers", "Fremont", "en", ["eco"]],
  ["wright", "Ms. Wright", "Green Lake", "en", []],
  ["cohen", "The Cohens", "Wallingford", "en", []],
];

export const households: Household[] = HOUSEHOLDS.map(([id, name, area, language, needs, regular]) => ({
  id,
  name,
  area,
  at: at(area),
  language,
  needs,
  sameCleaner: Boolean(regular),
  regularMemberId: regular,
  contact: `${id}@households.example`,
}));

// member -> day -> [household, start, hours]
const SCHEDULE: Record<string, Record<number, [string, string, number][]>> = {
  sam: {
    0: [
      ["okafor", "09:00", 4],
      ["hassan", "14:00", 2],
    ],
    1: [
      ["martin", "09:00", 3],
      ["santos", "13:00", 3],
    ],
    2: [
      ["dubois", "09:00", 3],
      ["murphy", "13:00", 3],
    ],
    3: [
      ["okafor", "09:00", 4],
      ["santos", "14:00", 2],
      ["murphy", "16:30", 1.5],
    ],
    4: [
      ["martin", "09:00", 3],
      ["hassan", "13:00", 3],
    ],
  },
  teresa: {
    0: [
      ["nguyen", "08:30", 3],
      ["rossi", "13:00", 3],
    ],
    1: [
      ["obrien", "09:00", 4],
      ["kaur", "14:30", 2],
    ],
    2: [
      ["kaur", "09:00", 3],
      ["tran", "13:00", 3],
    ],
    3: [
      ["hassan", "09:00", 2],
      ["ali", "11:30", 1.5],
    ],
    4: [
      ["nguyen", "08:30", 3],
      ["obrien", "13:00", 3],
    ],
  },
  marek: {
    0: [
      ["adeyemi", "08:00", 4],
      ["kowalski", "13:30", 3],
    ],
    1: [
      ["kowalski", "08:00", 3],
      ["ivanova", "12:00", 3],
    ],
    2: [
      ["adeyemi", "08:00", 3],
      ["haddad", "12:30", 3],
    ],
    3: [["lindqvist", "14:00", 2]],
    4: [
      ["kowalski", "08:00", 3],
      ["novak", "12:30", 3],
    ],
    5: [["larsen", "09:00", 3]],
  },
  grace: {
    0: [
      ["chen", "09:00", 3],
      ["sato", "13:00", 3],
    ],
    1: [
      ["fischer", "09:00", 3],
      ["chen", "13:00", 3],
    ],
    2: [
      ["sato", "09:00", 3],
      ["brennan", "13:30", 3],
    ],
    3: [
      ["chen", "09:00", 3],
      ["osei", "13:00", 3],
    ],
  },
  amara: {
    1: [
      ["tran", "08:30", 3],
      ["murphy", "13:00", 2.5],
    ],
    2: [
      ["ali", "08:30", 3],
      ["garcia", "13:00", 2],
    ],
    3: [
      ["dubois", "08:30", 3],
      ["tran", "12:30", 3],
    ],
    4: [
      ["ali", "08:30", 3],
      ["dubois", "13:00", 2],
    ],
    5: [["murphy", "09:00", 3]],
  },
  lena: {
    0: [
      ["larsen", "10:00", 3],
      ["fischer", "14:00", 3],
    ],
    1: [
      ["lindqvist", "10:00", 3],
      ["haddad", "14:00", 3],
    ],
    2: [
      ["novak", "10:00", 3],
      ["larsen", "14:00", 3],
    ],
    3: [["weber", "10:00", 3]],
    4: [
      ["haddad", "10:00", 3],
      ["fischer", "14:00", 3],
    ],
  },
  tomas: {
    0: [
      ["morales", "07:30", 3],
      ["petersen", "11:30", 3],
    ],
    1: [
      ["garcia", "08:00", 3],
      ["morales", "12:00", 3],
    ],
    2: [
      ["petersen", "08:00", 3],
      ["martin", "12:00", 3],
    ],
    3: [
      ["garcia", "07:30", 3],
      ["petersen", "11:30", 3],
    ],
    4: [
      ["morales", "07:30", 3],
      ["garcia", "11:30", 3],
    ],
  },
  joy: {
    0: [
      ["kim", "09:00", 3],
      ["weber", "13:00", 3],
    ],
    2: [
      ["ahmed", "09:00", 3],
      ["kim", "13:00", 3],
    ],
    4: [
      ["weber", "09:00", 3],
      ["ahmed", "13:00", 3],
    ],
  },
  ines: {
    0: [["bauer", "09:00", 3]],
    1: [["cohen", "13:00", 3]],
    3: [["wright", "13:30", 3]],
    4: [["bauer", "09:00", 3]],
  },
  kofi: {
    0: [["yilmaz", "13:00", 3]],
    2: [["abebe", "09:00", 3]],
    3: [["lopez", "13:00", 4]],
    5: [["abebe", "10:00", 3]],
  },
};

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function seedVisits(): Visit[] {
  const out: Visit[] = [];
  for (const [memberId, days] of Object.entries(SCHEDULE)) {
    for (const [day, list] of Object.entries(days)) {
      for (const [householdId, start, hours] of list) {
        const minutes = Math.round(hours * 60);
        let id = `v-${DAY_KEYS[Number(day)]}-${householdId}`;
        while (out.some((v) => v.id === id)) id += "-2";
        out.push({
          id,
          householdId,
          memberIds: [memberId],
          start: Number(day) * 1440 + hm(start),
          minutes,
          terms: { ...DEFAULT_TERMS, bookedMinutes: minutes },
          state: "scheduled",
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Thursday 07:10, when Sam's message arrives. */
export const STORY = {
  sickMemberId: "sam",
  day: 3,
  messageAt: 3 * 1440 + hm("07:10"),
  message: "Morning Dana, my son woke up with a fever. I can't come in today. So sorry.",
};
