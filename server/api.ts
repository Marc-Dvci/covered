// HTTP API for the coordinator board, the member and household phone views, and the landlord link.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { COOP, WEEK_START_ISO, TIME_ZONE } from "../shared/seed.ts";
import { holdCents, priceCents } from "../shared/rules/settle.ts";
import { ActionError, answerConsent, cancel, cancelPreview, canMove, checkIn, checkOut, holdText, lockout, move, noCover } from "./actions.ts";
import { draft, finish, type Draft } from "./agreements.ts";
import { Gemini } from "./ai/gemini.ts";
import { sweep, type App } from "./context.ts";
import { getDisruption, listDisruptions, openDisruption, propose } from "./dispatch/agent.ts";
import { approve } from "./dispatch/approve.ts";
import { solve } from "./dispatch/solver.ts";
import { finishSigning, SIGNUP_AREAS, startSigning } from "./signup.ts";
import { coverLetter, landlordView, openShare, share, statement } from "./statements.ts";
import type { VisitRow } from "./store.ts";
import type { Agreement } from "../shared/agreement.ts";
import type { Lang } from "../shared/domain.ts";

const visitor = (req: FastifyRequest) => String(req.headers["x-forwarded-for"] ?? req.ip).split(",")[0]!.trim();

function publicVisit(v: VisitRow) {
  return {
    id: v.id, householdId: v.householdId, memberIds: v.memberIds, start: v.start, minutes: v.minutes, state: v.state,
    priceCents: priceCents(v.terms), holdCents: holdCents(v.terms), terms: v.terms,
    hold: v.hold, capture: v.capture, void: v.void,
    payout: v.payout ? { status: v.payout.status, batchId: v.payout.batchId, items: v.payout.items, sentAt: v.payout.sentAt, finalAt: v.payout.finalAt, finalMs: v.payout.finalMs } : null,
    settlement: v.settlement, outcome: v.outcome, checkinAt: v.checkinAt, checkoutAt: v.checkoutAt, pendingMember: v.pendingMember,
    payment: holdText(v),
  };
}

export function routes(server: FastifyInstance, app: App, ai: Gemini) {
  const ctx = { store: app.store, runner: app.runner };
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ActionError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof z.ZodError) return reply.code(400).send({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    server.log.error(e);
    return reply.code(500).send({ error: (e as Error).message });
  };
  const wrap = <T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      return fail(reply, e);
    }
  };
  const mode = () => ({
    paypal: app.paypal.live ? "sandbox" : "stand-in", currency: app.paypal.currency, runner: app.runner.kind,
    ai: ai.live ? "gemini" : "recorded", demo: app.cfg.demo,
  });

  server.get("/api/health", async () => ({ ok: true, ...mode() }));

  server.get("/api/board", wrap(async () => {
    const [members, households, visits, now, disruptions, events] = await Promise.all([
      app.store.members(), app.store.households(), app.store.visits(), app.store.now(), listDisruptions(app.store), app.store.events(40),
    ]);
    const booked = Object.fromEntries(members.map((m) => [m.id, visits.filter((v) => v.memberIds.includes(m.id) && !["cancelled", "late_cancel", "voided"].includes(v.state)).reduce((a, v) => a + v.minutes, 0)]));
    return {
      coop: COOP, weekStart: WEEK_START_ISO, timeZone: TIME_ZONE, now, mode: mode(),
      members: members.map((m) => ({ ...m, bookedMinutes: booked[m.id] ?? 0 })),
      households: households.map(({ vaultId, vaultEmail: _, ...h }) => ({ ...h, paypalSaved: Boolean(vaultId) })),
      visits: visits.map(publicVisit),
      disruptions: disruptions.slice(0, 5),
      events: events.filter((e) => e.type !== "message.sent"),
    };
  }));

  // ---- demo clock and reset

  server.post("/api/clock", wrap(async (req, reply) => {
    if (!app.cfg.demo) return reply.code(403).send({ error: "demo only" });
    const body = z.object({ at: z.number().int().min(0).max(7 * 1440 - 1) }).parse(req.body);
    if (body.at < (await app.store.now())) return reply.code(409).send({ error: "the demo clock only moves forward; reset the demo to start the day again" });
    await app.store.setClock(body.at);
    await app.store.event("clock.set", null, "demo", { at: body.at });
    const held = await sweep(app);
    return { now: await app.store.now(), holdsStarted: held };
  }));

  server.post("/api/demo/reset", wrap(async (_req, reply) => {
    if (!app.cfg.demo) return reply.code(403).send({ error: "demo only" });
    await app.runner.idle();
    await app.store.reset(app.cfg.demoVaultId);
    const held = await sweep(app);
    return { ok: true, holdsStarted: held.length };
  }));

  server.post("/api/demo/crash-next-settle", wrap(async (req, reply) => {
    if (!app.cfg.demo) return reply.code(403).send({ error: "demo only" });
    const { visitId } = z.object({ visitId: z.string() }).parse(req.body);
    await app.store.kvSet(`crash-after-capture:${visitId}`, true);
    return { armed: visitId };
  }));

  // ---- visits

  server.get("/api/visits/:id", wrap(async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = await app.store.visit(id);
    if (!v) return reply.code(404).send({ error: "no such visit" });
    return { visit: publicVisit(v), money: await app.store.moneyRows(id), events: await app.store.events(30, id) };
  }));

  server.post("/api/visits/:id/check-move", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ memberId: z.string(), start: z.number().int().optional() }).parse(req.body);
    return canMove(ctx, id, b.memberId, b.start);
  }));

  server.post("/api/visits/:id/move", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ memberId: z.string(), start: z.number().int().optional() }).parse(req.body);
    const r = await move(ctx, id, b.memberId, "dana", b.start);
    return { visit: publicVisit(r.visit), pendingConsent: r.pendingConsent };
  }));

  server.post("/api/visits/:id/checkin", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ memberId: z.string() }).parse(req.body);
    return publicVisit(await checkIn(ctx, id, b.memberId));
  }));

  server.post("/api/visits/:id/checkout", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ memberId: z.string(), extraApproved: z.boolean().default(false) }).parse(req.body);
    return publicVisit(await checkOut(ctx, id, b.memberId, b.extraApproved));
  }));

  server.get("/api/visits/:id/cancel-preview", wrap(async (req) => cancelPreview(ctx, (req.params as { id: string }).id)));

  server.post("/api/visits/:id/cancel", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ by: z.enum(["household", "cooperative"]), actor: z.string() }).parse(req.body);
    return publicVisit(await cancel(ctx, id, b.by, b.actor));
  }));

  server.post("/api/visits/:id/lockout", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ memberId: z.string() }).parse(req.body);
    return publicVisit(await lockout(ctx, id, b.memberId));
  }));

  server.post("/api/visits/:id/release", wrap(async (req) => publicVisit(await noCover(ctx, (req.params as { id: string }).id, "dana"))));

  server.post("/api/visits/:id/consent", wrap(async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ householdId: z.string(), approve: z.boolean() }).parse(req.body);
    return publicVisit(await answerConsent(ctx, id, b.householdId, b.approve));
  }));

  // ---- members' messages and the cover agent

  server.post("/api/messages", wrap(async (req) => {
    const b = z.object({ memberId: z.string(), text: z.string().min(1).max(1000) }).parse(req.body);
    return openDisruption(app.store, ai, b.memberId, b.text, visitor(req));
  }));

  server.post("/api/disruptions/:id/propose", wrap(async (req) => propose(app.store, ai, (req.params as { id: string }).id, visitor(req))));

  server.post("/api/disruptions/:id/approve", wrap(async (req) => approve(ctx, (req.params as { id: string }).id)));

  server.post("/api/disruptions/:id/dismiss", wrap(async (req) => {
    await app.store.db.query("update disruptions set status = 'dismissed' where id = $1", [(req.params as { id: string }).id]);
    return { ok: true };
  }));

  server.get("/api/disruptions/:id", wrap(async (req, reply) => (await getDisruption(app.store, (req.params as { id: string }).id)) ?? reply.code(404).send({ error: "not found" })));

  // ---- phone views

  server.get("/api/members/:id/today", wrap(async (req, reply) => {
    const { id } = req.params as { id: string };
    const members = await app.store.members();
    const m = members.find((x) => x.id === id);
    if (!m) return reply.code(404).send({ error: "no such member" });
    const [visits, households, now, msgs] = await Promise.all([app.store.visits(), app.store.households(), app.store.now(), app.store.db.query<{ data: Record<string, unknown>; board_at: number }>("select data, board_at from events where type = 'message.sent' and data->>'toId' = $1 order by id desc limit 20", [id])]);
    const day = Math.floor(now / 1440);
    const mine = visits.filter((v) => v.memberIds.includes(id) || v.pendingMember === id);
    return {
      member: m, now, mode: mode(),
      today: mine.filter((v) => Math.floor(v.start / 1440) === day).map(publicVisit),
      week: mine.map(publicVisit),
      households: households.filter((h) => mine.some((v) => v.householdId === h.id)).map(({ vaultId: _, vaultEmail: __, ...h }) => h),
      messages: msgs.map((r) => ({ ...r.data, at: r.board_at })),
    };
  }));

  server.get("/api/households/:id", wrap(async (req, reply) => {
    const { id } = req.params as { id: string };
    const h = await app.store.household(id);
    if (!h) return reply.code(404).send({ error: "no such household" });
    const [visits, members, now, msgs] = await Promise.all([app.store.visits(), app.store.members(), app.store.now(), app.store.db.query<{ data: Record<string, unknown>; board_at: number }>("select data, board_at from events where type = 'message.sent' and data->>'toId' = $1 order by id desc limit 20", [id])]);
    const { vaultId, vaultEmail: _, ...pub } = h;
    const agreement = (await app.store.db.query<{ data: Agreement; readback: unknown }>("select a.data, a.readback from agreements a join households h on h.agreement_id = a.id where h.id = $1", [id]))[0] ?? null;
    return {
      household: { ...pub, paypalSaved: Boolean(vaultId) }, now, mode: mode(),
      visits: visits.filter((v) => v.householdId === id).map(publicVisit),
      members: members.map((m) => ({ id: m.id, name: m.name, languages: m.languages })),
      messages: msgs.map((r) => ({ ...r.data, at: r.board_at })),
      agreement,
    };
  }));

  // ---- agreements and signing

  server.get("/api/signup/areas", async () => SIGNUP_AREAS);

  server.post("/api/agreements/draft", { bodyLimit: 8 * 1024 * 1024 }, wrap(async (req) => {
    const b = z.object({
      householdName: z.string().min(1).max(80), area: z.string().min(1).max(60), language: z.string() as z.ZodType<Lang>,
      jobText: z.string().max(3000), memberLanguage: z.string() as z.ZodType<Lang>, memberText: z.string().max(3000).optional(),
      memberAudio: z.object({ mimeType: z.string(), data: z.string().max(6_000_000) }).optional(),
    }).parse(req.body);
    return draft(app.store, ai, b, visitor(req));
  }));

  server.post("/api/agreements/:id/update", wrap(async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = (await app.store.db.query<{ data: Agreement & { _draft?: { transcript: string | null; notes: string[]; source: string; memberLanguage: Lang } } }>("select data from agreements where id = $1", [id]))[0];
    if (!r) return reply.code(404).send({ error: "no such agreement" });
    const patch = z.record(z.string(), z.unknown()).parse(req.body);
    const { _draft, ...current } = r.data;
    const allowed = ["scope", "location", "schedule", "rateCentsPerHour", "cancellation", "needs", "sameCleaner", "area"];
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))) } as Agreement;
    const d: Draft = { id, agreement: next, missing: [], readback: [], transcript: _draft?.transcript ?? null, source: "edited", notes: _draft?.notes ?? [] };
    return finish(app.store, ai, d, _draft?.memberLanguage ?? "en", visitor(req));
  }));

  server.post("/api/agreements/:id/sign", wrap(async (req) => startSigning(app.store, app.paypal, (req.params as { id: string }).id, app.cfg.publicUrl)));

  server.get("/api/vault/return", wrap(async (req, reply) => {
    const q = req.query as { agreement?: string; approval_token_id?: string; approval_session_id?: string };
    if (!q.agreement || !q.approval_token_id) return reply.code(400).send({ error: "missing approval" });
    const r = await finishSigning(app.store, app.paypal, q.agreement, q.approval_token_id);
    await sweep(app);
    return reply.redirect(`/h/${r.householdId}?welcome=1`);
  }));

  // ---- statements and the landlord link

  server.get("/api/members/:id/statement", wrap(async (req) => {
    const s = await statement(app.store, app.paypal, (req.params as { id: string }).id);
    return { ...s, letter: await coverLetter(ai, s, visitor(req)) };
  }));

  server.post("/api/members/:id/share", wrap(async (req) => share(app.store, app.cfg.linkSecret, (req.params as { id: string }).id)));

  server.get("/api/share/:token", wrap(async (req, reply) => {
    const s = await openShare(app.store, app.cfg.linkSecret, (req.params as { token: string }).token);
    if (!s) return reply.code(404).send({ error: "this link is not valid or has expired" });
    const st = await statement(app.store, app.paypal, s.memberId);
    return { ...landlordView(st), expiresAt: s.expiresAt, letter: await coverLetter(ai, st) };
  }));

  // ---- evidence and plumbing

  server.get("/api/about", wrap(async () => {
    const runs = await app.store.db.query<{ status: string; n: string }>("select data->>'status' as status, count(*) as n from events where type = 'task.run' group by 1");
    const money = await app.store.db.query<{ kind: string; n: string; cents: string }>("select kind, count(distinct ref) as n, sum(cents) as cents from (select distinct on (visit_id, kind, ref) * from money order by visit_id, kind, ref, id desc) m group by kind");
    return { mode: mode(), ai: await ai.usage(), taskRuns: runs, money };
  }));

  server.post("/api/solve-preview", wrap(async (req) => {
    const b = z.object({ affected: z.array(z.string()).max(8) }).parse(req.body);
    const [members, households, visits] = await Promise.all([app.store.members(), app.store.households(), app.store.visits()]);
    return solve({ members, households, visits, absences: [], affected: b.affected });
  }));

  server.post("/api/paypal/webhook", wrap(async (req) => {
    const body = req.body as { event_type?: string; resource?: Record<string, unknown> };
    await app.store.event("paypal.webhook", null, "paypal", { type: body.event_type, id: body.resource?.id });
    return { ok: true };
  }));
}
