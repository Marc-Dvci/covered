// HTTP API for the coordinator board, the member and household phone views, and the landlord link.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COOP, WEEK_START_ISO, TIME_ZONE } from "../shared/seed.ts";
import { holdCents, priceCents } from "../shared/rules/settle.ts";
import { ActionError, activeAbsences, answerConsent, cancel, cancelPreview, canMove, checkIn, checkOut, holdText, lockout, move, noCover } from "./actions.ts";
import { draft, finish, type Draft } from "./agreements.ts";
import { Gemini } from "./ai/gemini.ts";
import { refreshIfIdle, sweep, type App } from "./core.ts";
import { getDisruption, listDisruptions, openDisruption, propose } from "./dispatch/agent.ts";
import { approve } from "./dispatch/approve.ts";
import { solve } from "./dispatch/solver.ts";
import { finishRepair, finishSigning, SIGNUP_AREAS, startRepair, startSigning } from "./signup.ts";
import { activeProposal, guards, toCrud } from "./crud.ts";
import { evidence } from "./evidence.ts";
import { coverLetter, landlordView, openShare, share, statement } from "./statements.ts";
import type { VisitRow } from "./store.ts";
import type { Agreement } from "../shared/agreement.ts";
import type { Lang } from "../shared/domain.ts";

const visitor = (c: Context) => (c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "local").split(",")[0]!.trim();
const json = (c: Context): Promise<unknown> => c.req.json().catch(() => ({}));

function publicVisit(v: VisitRow) {
  return {
    id: v.id,
    householdId: v.householdId,
    memberIds: v.memberIds,
    start: v.start,
    minutes: v.minutes,
    state: v.state,
    priceCents: priceCents(v.terms),
    holdCents: holdCents(v.terms),
    terms: v.terms,
    hold: v.hold,
    capture: v.capture,
    void: v.void,
    payout: v.payout
      ? {
          status: v.payout.status,
          batchId: v.payout.batchId,
          items: v.payout.items,
          sentAt: v.payout.sentAt,
          finalAt: v.payout.finalAt,
          finalMs: v.payout.finalMs,
        }
      : null,
    settlement: v.settlement,
    outcome: v.outcome,
    checkinAt: v.checkinAt,
    checkoutAt: v.checkoutAt,
    pendingMember: v.pendingMember,
    payment: holdText(v),
  };
}

export function routes(server: Hono, app: App, ai: Gemini) {
  const ctx = { store: app.store, runner: app.runner };
  const fail = (c: Context, e: unknown) => {
    if (e instanceof ActionError) return c.json({ error: e.message }, e.status as 400);
    if (e instanceof z.ZodError) return c.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    console.error(e);
    return c.json({ error: (e as Error).message }, 500);
  };
  // a handler returns a body to send as JSON, or a Response when it sets its own status
  const wrap = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      const out = await fn(c);
      return out instanceof Response ? out : c.json(out as object);
    } catch (e) {
      return fail(c, e);
    }
  };
  const mode = () => ({
    paypal: app.paypal.live ? "sandbox" : "stand-in",
    currency: app.paypal.currency,
    runner: app.runner.kind,
    ai: ai.live ? "gemini" : "recorded",
    demo: app.cfg.demo,
  });
  const id = (c: Context) => c.req.param("id")!;

  server.use("/api/*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));
  // any write marks the demo week as used, so a later visitor gets a fresh one after a quiet spell
  server.use("/api/*", async (c, next) => {
    await next();
    if (app.cfg.demo && c.req.method === "POST" && c.res.ok && c.req.path !== "/api/demo/reset" && c.req.path !== "/api/paypal/webhook")
      await app.store.kvSet("demo_used_at", Date.now());
  });

  server.get("/api/health", (c) => c.json({ ok: true, ...mode() }));

  server.get(
    "/api/board",
    wrap(async () => {
      await refreshIfIdle(app);
      const [members, households, visits, now, disruptions, events, absences] = await Promise.all([
        app.store.members(),
        app.store.households(),
        app.store.visits(),
        app.store.now(),
        listDisruptions(app.store),
        app.store.events(40),
        activeAbsences(app.store),
      ]);
      const shown = disruptions.slice(0, 5);
      const booked = Object.fromEntries(
        members.map((m) => [
          m.id,
          visits.filter((v) => v.memberIds.includes(m.id) && !["cancelled", "late_cancel", "voided"].includes(v.state)).reduce((a, v) => a + v.minutes, 0),
        ]),
      );
      return {
        coop: COOP,
        weekStart: WEEK_START_ISO,
        timeZone: TIME_ZONE,
        now,
        mode: mode(),
        members: members.map((m) => ({ ...m, bookedMinutes: booked[m.id] ?? 0 })),
        households: households.map(({ vaultId, vaultEmail: _, ...h }) => ({ ...h, paypalSaved: Boolean(vaultId) })),
        visits: visits.map(publicVisit),
        disruptions: shown,
        events: events.filter((e) => e.type !== "message.sent"),
        crud: toCrud(members, households, visits, { proposal: activeProposal(shown), now, absences }),
      };
    }),
  );

  // the drag guard's verdicts for one day, fetched when the board changes: every member, every visit that can still move
  server.get(
    "/api/board/guards",
    wrap(async (c) => {
      const [members, households, visits, absences, now] = await Promise.all([
        app.store.members(),
        app.store.households(),
        app.store.visits(),
        activeAbsences(app.store),
        app.store.now(),
      ]);
      const day = Number(c.req.query("day") ?? Math.floor(now / 1440));
      return guards(members, households, visits, absences, day);
    }),
  );

  // ---- demo clock and reset

  server.post(
    "/api/clock",
    wrap(async (c) => {
      if (!app.cfg.demo) return c.json({ error: "demo only" }, 403);
      const body = z
        .object({
          at: z
            .number()
            .int()
            .min(0)
            .max(7 * 1440 - 1),
        })
        .parse(await json(c));
      if (body.at < (await app.store.now())) return c.json({ error: "the demo clock only moves forward; reset the demo to start the day again" }, 409);
      await app.store.setClock(body.at);
      await app.store.event("clock.set", null, "demo", { at: body.at });
      const held = await sweep(app);
      return { now: await app.store.now(), holdsStarted: held };
    }),
  );

  server.post(
    "/api/demo/reset",
    wrap(async (c) => {
      if (!app.cfg.demo) return c.json({ error: "demo only" }, 403);
      // each reset places real sandbox holds, so the public demo allows a fixed number per day
      const today = `demo_resets:${new Date().toISOString().slice(0, 10)}`;
      const used = (await app.store.kvGet<number>(today)) ?? 0;
      if (used >= app.cfg.demoResetsPerDay) return c.json({ error: "the demo has been reset many times today; it resets by itself after a quiet spell" }, 429);
      await app.store.kvSet(today, used + 1);
      await app.runner.idle();
      await app.store.reset(app.cfg.demoVaultId, app.cfg.sandboxPayouts);
      const held = await sweep(app);
      return { ok: true, holdsStarted: held.length };
    }),
  );

  server.post(
    "/api/demo/crash-next-settle",
    wrap(async (c) => {
      if (!app.cfg.demo) return c.json({ error: "demo only" }, 403);
      const { visitId } = z.object({ visitId: z.string() }).parse(await json(c));
      await app.store.kvSet(`crash-after-capture:${visitId}`, true);
      return { armed: visitId };
    }),
  );

  // ---- visits

  server.get(
    "/api/visits/:id",
    wrap(async (c) => {
      const v = await app.store.visit(id(c));
      if (!v) return c.json({ error: "no such visit" }, 404);
      return { visit: publicVisit(v), money: await app.store.moneyRows(id(c)), events: await app.store.events(30, id(c)) };
    }),
  );

  // the cooperative's answer to a dispute, from the ledger only
  server.get(
    "/api/visits/:id/evidence",
    wrap(async (c) => (await evidence(app.store, id(c))) ?? c.json({ error: "no such visit" }, 404)),
  );

  server.post(
    "/api/visits/:id/check-move",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string(), start: z.number().int().optional() }).parse(await json(c));
      return canMove(ctx, id(c), b.memberId, b.start);
    }),
  );

  server.post(
    "/api/visits/:id/move",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string(), start: z.number().int().optional() }).parse(await json(c));
      const r = await move(ctx, id(c), b.memberId, "dana", b.start);
      return { visit: publicVisit(r.visit), pendingConsent: r.pendingConsent };
    }),
  );

  server.post(
    "/api/visits/:id/checkin",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string() }).parse(await json(c));
      return publicVisit(await checkIn(ctx, id(c), b.memberId));
    }),
  );

  server.post(
    "/api/visits/:id/checkout",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string(), extraApproved: z.boolean().default(false) }).parse(await json(c));
      return publicVisit(await checkOut(ctx, id(c), b.memberId, b.extraApproved));
    }),
  );

  server.get(
    "/api/visits/:id/cancel-preview",
    wrap(async (c) => cancelPreview(ctx, id(c))),
  );

  server.post(
    "/api/visits/:id/cancel",
    wrap(async (c) => {
      const b = z.object({ by: z.enum(["household", "cooperative"]), actor: z.string() }).parse(await json(c));
      return publicVisit(await cancel(ctx, id(c), b.by, b.actor));
    }),
  );

  server.post(
    "/api/visits/:id/lockout",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string() }).parse(await json(c));
      return publicVisit(await lockout(ctx, id(c), b.memberId));
    }),
  );

  server.post(
    "/api/visits/:id/release",
    wrap(async (c) => publicVisit(await noCover(ctx, id(c), "dana"))),
  );

  server.post(
    "/api/visits/:id/consent",
    wrap(async (c) => {
      const b = z.object({ householdId: z.string(), approve: z.boolean() }).parse(await json(c));
      return publicVisit(await answerConsent(ctx, id(c), b.householdId, b.approve));
    }),
  );

  // ---- members' messages and the cover agent

  server.post(
    "/api/messages",
    wrap(async (c) => {
      const b = z.object({ memberId: z.string(), text: z.string().min(1).max(1000) }).parse(await json(c));
      return openDisruption(app.store, ai, b.memberId, b.text, visitor(c));
    }),
  );

  server.post(
    "/api/disruptions/:id/propose",
    wrap(async (c) => propose(app.store, ai, id(c), visitor(c))),
  );

  server.post(
    "/api/disruptions/:id/approve",
    wrap(async (c) => approve(ctx, id(c))),
  );

  server.post(
    "/api/disruptions/:id/dismiss",
    wrap(async (c) => {
      await app.store.db.query("update disruptions set status = 'dismissed' where id = $1", [id(c)]);
      return { ok: true };
    }),
  );

  server.get(
    "/api/disruptions/:id",
    wrap(async (c) => (await getDisruption(app.store, id(c))) ?? c.json({ error: "not found" }, 404)),
  );

  // ---- phone views

  server.get(
    "/api/members/:id/today",
    wrap(async (c) => {
      const memberId = id(c);
      const members = await app.store.members();
      const m = members.find((x) => x.id === memberId);
      if (!m) return c.json({ error: "no such member" }, 404);
      const [visits, households, now, msgs] = await Promise.all([
        app.store.visits(),
        app.store.households(),
        app.store.now(),
        app.store.db.query<{ data: Record<string, unknown>; board_at: number }>(
          "select data, board_at from events where type = 'message.sent' and data->>'toId' = $1 order by id desc limit 20",
          [memberId],
        ),
      ]);
      const day = Math.floor(now / 1440);
      const mine = visits.filter((v) => v.memberIds.includes(memberId) || v.pendingMember === memberId);
      return {
        member: m,
        now,
        mode: mode(),
        today: mine.filter((v) => Math.floor(v.start / 1440) === day).map(publicVisit),
        week: mine.map(publicVisit),
        households: households.filter((h) => mine.some((v) => v.householdId === h.id)).map(({ vaultId: _, vaultEmail: __, ...h }) => h),
        messages: msgs.map((r) => ({ ...r.data, at: r.board_at })),
      };
    }),
  );

  server.get(
    "/api/households/:id",
    wrap(async (c) => {
      const householdId = id(c);
      const h = await app.store.household(householdId);
      if (!h) return c.json({ error: "no such household" }, 404);
      const [visits, members, now, msgs] = await Promise.all([
        app.store.visits(),
        app.store.members(),
        app.store.now(),
        app.store.db.query<{ data: Record<string, unknown>; board_at: number }>(
          "select data, board_at from events where type = 'message.sent' and data->>'toId' = $1 order by id desc limit 20",
          [householdId],
        ),
      ]);
      const { vaultId, vaultEmail: _, ...pub } = h;
      const agreement =
        (
          await app.store.db.query<{ data: Agreement; readback: unknown }>(
            "select a.data, a.readback from agreements a join households h on h.agreement_id = a.id where h.id = $1",
            [householdId],
          )
        )[0] ?? null;
      return {
        household: { ...pub, paypalSaved: Boolean(vaultId) },
        now,
        mode: mode(),
        visits: visits.filter((v) => v.householdId === householdId).map(publicVisit),
        members: members.map((m) => ({ id: m.id, name: m.name, languages: m.languages })),
        messages: msgs.map((r) => ({ ...r.data, at: r.board_at })),
        agreement,
      };
    }),
  );

  // ---- agreements and signing

  server.get("/api/signup/areas", (c) => c.json(SIGNUP_AREAS));

  server.post(
    "/api/agreements/draft",
    wrap(async (c) => {
      const b = z
        .object({
          householdName: z.string().min(1).max(80),
          area: z.string().min(1).max(60),
          language: z.string() as z.ZodType<Lang>,
          jobText: z.string().max(3000),
          memberLanguage: z.string() as z.ZodType<Lang>,
          memberText: z.string().max(3000).optional(),
          memberAudio: z.object({ mimeType: z.string(), data: z.string().max(6_000_000) }).optional(),
        })
        .parse(await json(c));
      return draft(app.store, ai, b, visitor(c));
    }),
  );

  server.post(
    "/api/agreements/:id/update",
    wrap(async (c) => {
      const agreementId = id(c);
      const r = (
        await app.store.db.query<{
          status: string;
          data: Agreement & { _draft?: { transcript: string | null; notes: string[]; source: string; memberLanguage: Lang } };
        }>("select data, status from agreements where id = $1", [agreementId])
      )[0];
      if (!r) return c.json({ error: "no such agreement" }, 404);
      if (r.status === "signing" || r.status === "signed") return c.json({ error: "a signed agreement changes only through a new agreement" }, 409);
      const patch = z.record(z.string(), z.unknown()).parse(await json(c));
      const { _draft, ...current } = r.data;
      const allowed = ["scope", "location", "schedule", "rateCentsPerHour", "cancellation", "needs", "sameCleaner", "area"];
      const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))) } as Agreement;
      const d: Draft = {
        id: agreementId,
        agreement: next,
        missing: [],
        readback: [],
        transcript: _draft?.transcript ?? null,
        source: "edited",
        notes: _draft?.notes ?? [],
      };
      return finish(app.store, ai, d, _draft?.memberLanguage ?? "en", visitor(c));
    }),
  );

  server.post(
    "/api/agreements/:id/sign",
    wrap(async (c) => startSigning(app.store, app.paypal, id(c), app.cfg.publicUrl)),
  );

  server.post(
    "/api/households/:id/repair",
    wrap(async (c) => startRepair(app.store, app.paypal, id(c), app.cfg.publicUrl)),
  );

  server.get(
    "/api/vault/return",
    wrap(async (c) => {
      const q = c.req.query();
      if (q.household && q.approval_token_id) {
        await finishRepair(app.store, app.paypal, q.household, q.approval_token_id);
        await sweep(app);
        return c.redirect(`/h/${encodeURIComponent(q.household)}?repaired=1`);
      }
      if (!q.agreement || !q.approval_token_id) return c.json({ error: "missing approval" }, 400);
      const r = await finishSigning(app.store, app.paypal, q.agreement, q.approval_token_id);
      await sweep(app);
      return c.redirect(`/h/${r.householdId}?welcome=1`);
    }),
  );

  // ---- statements and the landlord link

  server.get(
    "/api/members/:id/statement",
    wrap(async (c) => {
      const s = await statement(app.store, app.paypal, id(c));
      return { ...s, letter: await coverLetter(ai, s, visitor(c)) };
    }),
  );

  server.post(
    "/api/members/:id/share",
    wrap(async (c) => share(app.store, app.cfg.linkSecret, id(c))),
  );

  server.get(
    "/api/share/:token",
    wrap(async (c) => {
      const s = await openShare(app.store, app.cfg.linkSecret, c.req.param("token")!);
      if (!s) return c.json({ error: "this link is not valid or has expired" }, 404);
      const st = await statement(app.store, app.paypal, s.memberId);
      return { ...landlordView(st), expiresAt: s.expiresAt, letter: await coverLetter(ai, st) };
    }),
  );

  // ---- evidence and plumbing

  server.get(
    "/api/about",
    wrap(async () => {
      const runs = await app.store.db.query<{ status: string; n: number }>(
        "select data->>'status' as status, count(*) as n from events where type = 'task.run' group by 1",
      );
      const money = await app.store.db.query<{ kind: string; n: number; cents: number }>(
        "select kind, count(distinct ref) as n, sum(cents) as cents from money group by kind",
      );
      return { mode: mode(), ai: await ai.usage(), taskRuns: runs, money };
    }),
  );

  server.post(
    "/api/solve-preview",
    wrap(async (c) => {
      const b = z.object({ affected: z.array(z.string()).max(8) }).parse(await json(c));
      const [members, households, visits] = await Promise.all([app.store.members(), app.store.households(), app.store.visits()]);
      return solve({ members, households, visits, absences: [], affected: b.affected });
    }),
  );

  // PayPal webhooks: kept only when PayPal confirms the signature for our webhook id, and tied to the
  // visit through the invoice id every hold and capture carries (covered-<visit>)
  server.post(
    "/api/paypal/webhook",
    wrap(async (c) => {
      const body = (await json(c)) as { id?: string; event_type?: string; resource?: Record<string, unknown> };
      const headers = Object.fromEntries(c.req.raw.headers.entries());
      const ok = app.cfg.webhookId ? await app.paypal.verifyWebhook(headers, body, app.cfg.webhookId) : false;
      if (!ok) {
        await app.store.event("paypal.webhook_rejected", null, "paypal", {
          type: body.event_type,
          id: body.id,
          why: app.cfg.webhookId ? "signature not verified" : "no webhook id configured",
        });
        return c.json({ error: "webhook not verified" }, 400);
      }
      const r = body.resource ?? {};
      const batch = r.batch_header as { sender_batch_header?: { sender_batch_id?: string } } | undefined;
      const invoice = String(
        r.invoice_id ??
          (r.disputed_transactions as { invoice_number?: string }[] | undefined)?.[0]?.invoice_number ??
          batch?.sender_batch_header?.sender_batch_id ??
          "",
      );
      const visitId = await app.store.visitForInvoice(invoice);
      await app.store.event("paypal.webhook", visitId, "paypal", { type: body.event_type, id: body.id, resourceId: r.id, verified: true });
      return { ok: true };
    }),
  );
}
