// Signing an agreement: the household saves its PayPal once (Vault), becomes a client of the
// cooperative, and its first visit lands on the board with the member the solver finds for it.
import { missing, type Agreement } from "../shared/agreement.ts";
import { DEFAULT_TERMS, type Household, type Visit } from "../shared/domain.ts";
import { hm } from "../shared/seed.ts";
import { activeAbsences } from "./actions.ts";
import { solve } from "./dispatch/solver.ts";
import type { PayPal } from "./paypal/types.ts";
import type { Store } from "./store.ts";

const AREA_POINTS: Record<string, { lat: number; lon: number }> = {
  "Capitol Hill": { lat: 47.6253, lon: -122.3222 }, "Ballard": { lat: 47.6687, lon: -122.3847 }, "Fremont": { lat: 47.6505, lon: -122.3509 },
  "Queen Anne": { lat: 47.6374, lon: -122.357 }, "Beacon Hill": { lat: 47.579, lon: -122.3115 }, "Columbia City": { lat: 47.5598, lon: -122.2866 },
  "West Seattle": { lat: 47.5667, lon: -122.3868 }, "University District": { lat: 47.6615, lon: -122.3138 }, "Wallingford": { lat: 47.6615, lon: -122.3346 },
  "Greenwood": { lat: 47.6907, lon: -122.355 }, "Madison Park": { lat: 47.634, lon: -122.2785 }, "Georgetown": { lat: 47.5469, lon: -122.322 },
};
export const SIGNUP_AREAS = Object.keys(AREA_POINTS);

export async function startSigning(store: Store, paypal: PayPal, agreementId: string, publicUrl: string): Promise<{ approveUrl: string; householdId: string }> {
  const r = await store.db.query<{ data: Agreement; status: string }>("select data, status from agreements where id = $1", [agreementId]);
  const a = r[0]?.data;
  if (!a) throw new Error("no such agreement");
  if (missing(a).length) throw new Error("the agreement is not complete");
  const base = a.householdName.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "") || "household";
  let householdId = base;
  for (let i = 2; await store.household(householdId); i++) householdId = `${base}-${i}`;
  const h: Household = {
    id: householdId, name: a.householdName, area: a.area, at: AREA_POINTS[a.area] ?? AREA_POINTS["Capitol Hill"]!, language: a.language,
    needs: a.needs, sameCleaner: a.sameCleaner, contact: `${householdId}@households.example`,
  };
  await store.db.query("insert into households(id, data, agreement_id) values ($1,$2,$3)", [h.id, JSON.stringify(h), agreementId]);
  await store.db.query("update agreements set household_id = $2, status = 'signing' where id = $1", [agreementId, h.id]);
  const back = `${publicUrl}/api/vault/return?agreement=${encodeURIComponent(agreementId)}`;
  const v = await paypal.vaultSetup(back, `${publicUrl}/join?cancelled=1`, `Cleaning visits with the cooperative, held 24 hours ahead`, agreementId);
  await store.kvSet(`setup:${agreementId}`, v.setupTokenId);
  await store.event("agreement.signing", null, h.id, { agreementId });
  return { approveUrl: v.approveUrl, householdId: h.id };
}

export async function finishSigning(store: Store, paypal: PayPal, agreementId: string, setupTokenId: string): Promise<{ householdId: string; visitId: string | null; memberId: string | null }> {
  const r = await store.db.query<{ data: Agreement; household_id: string; status: string }>("select data, household_id, status from agreements where id = $1", [agreementId]);
  const row = r[0];
  if (!row) throw new Error("no such agreement");
  const expected = await store.kvGet<string>(`setup:${agreementId}`);
  if (expected && expected !== setupTokenId) throw new Error("this approval belongs to another agreement");
  if (row.status === "signed") {
    const v = (await store.visits()).find((x) => x.householdId === row.household_id);
    return { householdId: row.household_id, visitId: v?.id ?? null, memberId: v?.memberIds[0] ?? null };
  }
  const token = await paypal.vaultFinalize(setupTokenId, agreementId);
  await store.db.query("update households set vault_id = $2, vault_email = $3 where id = $1", [row.household_id, token.paymentTokenId, token.payerEmail ?? null]);
  await store.db.query("update agreements set status = 'signed', signed_at = now() where id = $1", [agreementId]);
  await store.event("agreement.signed", null, row.household_id, { agreementId, vault: "saved" });

  const a = row.data;
  if (a.schedule.weekday === null || !a.schedule.start || !a.schedule.minutes) return { householdId: row.household_id, visitId: null, memberId: null };
  const now = await store.now();
  let start = a.schedule.weekday * 1440 + hm(a.schedule.start);
  if (start <= now) start += 7 * 1440;
  const visit: Visit = {
    id: `v-${row.household_id}-1`, householdId: row.household_id, memberIds: [], start, minutes: a.schedule.minutes,
    terms: { ...DEFAULT_TERMS, rateCentsPerHour: a.rateCentsPerHour ?? DEFAULT_TERMS.rateCentsPerHour, bookedMinutes: a.schedule.minutes,
      noticeHours: a.cancellation.noticeHours ?? 24, lateCancelPct: a.cancellation.lateCancelPct ?? 50, lockoutPct: a.cancellation.lockoutPct ?? 100,
      extraAllowanceMinutes: a.extraAllowanceMinutes },
    state: "scheduled",
  };
  const [members, households, visits] = await Promise.all([store.members(), store.households(), store.visits()]);
  const solved = solve({ members, households, visits: [...visits, visit], absences: await activeAbsences(store), affected: [visit.id], maxPlans: 1 });
  const memberId = solved.plans[0]?.assignments[0]?.memberId ?? null;
  if (memberId) visit.memberIds = [memberId];
  await store.insertVisit(visit);
  await store.event("visit.scheduled", visit.id, "agent", { memberId, from: "agreement" });
  return { householdId: row.household_id, visitId: visit.id, memberId };
}
