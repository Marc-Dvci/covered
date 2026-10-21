import { useEffect, useMemo, useState } from "react";
import { clock, dollars, LANG_NAMES, WEEK_DAYS } from "../../../shared/domain.ts";
import { api, STATE_LABEL, usePoll, type Board, type Disruption, type EventRow, type PublicVisit } from "../api.ts";
import { chipText, Timeline } from "../components/Timeline.tsx";

function dateOf(weekStart: string, t: number): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.floor(t / 1440));
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function BoardPage() {
  const { data: board, reload } = usePoll<Board>("/api/board", 2000);
  const [day, setDay] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (board && day === null) setDay(Math.floor(board.now / 1440));
  }, [board, day]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const active = board?.disruptions.find((d) => d.status === "open" || d.status === "proposed") ?? null;
  const absent = useMemo(() => new Set((board?.disruptions ?? []).filter((d) => d.status !== "dismissed" && d.affected.length && d.day === day).map((d) => d.memberId)), [board, day]);
  if (!board || day === null) return <p className="page">Loading the board…</p>;
  const ghost = active?.status === "proposed" ? active.proposal?.plan ?? null : null;
  const visit = selected ? board.visits.find((v) => v.id === selected) ?? null : null;
  const counts = board.visits.filter((v) => Math.floor(v.start / 1440) === day).reduce<Record<string, number>>((a, v) => ((a[v.state] = (a[v.state] ?? 0) + 1), a), {});

  return (
    <div className="board-wrap">
      <section className="board-main" aria-label="Board">
        <div className="board-head">
          <div>
            <h1>{board.coop.name}</h1>
            <small>{board.members.length} members · week of {dateOf(board.weekStart, 0)} · coordinator {board.coop.coordinator}</small>
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <DemoClock board={board} onChange={async () => { await reload(); }} setToast={setToast} />
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="days" role="group" aria-label="Day">
            {WEEK_DAYS.slice(0, 6).map((d, i) => (
              <button key={d} aria-pressed={i === day} onClick={() => setDay(i)}>{dateOf(board.weekStart, i * 1440)}</button>
            ))}
          </div>
          <div className="legend" aria-label="Legend">
            {(["done", "scheduled", "held", "in_progress", "paid_out", "late_cancel", "voided", "at_risk"] as const).map((s) => (
              <span key={s} className={`chip s-${s}`}>{STATE_LABEL[s]}{counts[s] ? ` ${counts[s]}` : ""}</span>
            ))}
          </div>
        </div>
        <Timeline board={board} day={day} ghost={ghost} selected={selected} onSelect={setSelected} absent={absent} />
        <p className="muted" style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
          Each visit's pay is held on the household's PayPal 24 hours before it starts, taken when the member checks out, and paid to the member the same minute. Dotted tails are travel time to the next home.
        </p>
      </section>
      <aside className="board-side" aria-label="Coordinator panel">
        {visit ? (
          <VisitPanel board={board} visit={visit} onClose={() => setSelected(null)} reload={reload} setToast={setToast} />
        ) : (
          <>
            <Inbox board={board} active={active} reload={reload} setToast={setToast} />
            <Feed board={board} />
          </>
        )}
      </aside>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function DemoClock({ board, onChange, setToast }: { board: Board; onChange: () => Promise<void>; setToast: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (at: number) => {
    setBusy(true);
    try {
      const r = await api<{ holdsStarted: string[] }>("/api/clock", { at });
      if (r.holdsStarted.length) setToast(`${r.holdsStarted.length} hold${r.holdsStarted.length > 1 ? "s" : ""} placed on PayPal`);
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  const d = Math.floor(board.now / 1440);
  if (!board.mode.demo) return <div className="clock"><span className="time">{dateOf(board.weekStart, board.now)} {clock(board.now)}</span></div>;
  return (
    <div className="clock" aria-label="Demo clock">
      <div style={{ display: "grid" }}>
        <span className="time">{dateOf(board.weekStart, board.now)}, {clock(board.now)}</span>
        <span className="note">Demo clock. PayPal calls are real sandbox calls.</span>
      </div>
      <button className="btn secondary small" disabled={busy} onClick={() => set(board.now + 15)}>+15 min</button>
      <button className="btn secondary small" disabled={busy} onClick={() => set(board.now + 60)}>+1 h</button>
      <select aria-label="Jump to" disabled={busy} value="" onChange={(e) => e.target.value && set(d * 1440 + Number(e.target.value))} style={{ width: "auto" }}>
        <option value="">Jump to…</option>
        {[420, 430, 540, 600, 780, 840, 960, 1080].map((m) => <option key={m} value={m}>{clock(m)}</option>)}
      </select>
      <button className="btn quiet small" disabled={busy} onClick={async () => { if (confirm("Reset the demo week?")) { setBusy(true); await api("/api/demo/reset", {}); setBusy(false); setToast("Demo week reset"); await onChange(); } }}>Reset</button>
    </div>
  );
}

function Inbox({ board, active, reload, setToast }: { board: Board; active: Disruption | null; reload: () => Promise<void>; setToast: (s: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("sam");
  const [text, setText] = useState("Morning Dana, my son woke up with a fever. I can't come in today. So sorry.");
  const name = (id: string) => board.members.find((m) => m.id === id)?.name ?? board.households.find((h) => h.id === id)?.name ?? id;
  const visitLabel = (id: string) => {
    const v = board.visits.find((x) => x.id === id);
    if (!v) return id;
    return `${board.households.find((h) => h.id === v.householdId)?.name}, ${clock(v.start)}–${clock(v.start + v.minutes)}`;
  };
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!active) {
    return (
      <section className="side-section" aria-label="Messages">
        <h2>Messages from members</h2>
        <p className="muted">Members text the coordinator. Send one as a member to see the agent work.</p>
        <label>From
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {board.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Message<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button className="btn" disabled={!!busy || !text.trim()} onClick={() => run("send", () => api("/api/messages", { memberId: from, text }))}>{busy ? "Reading…" : "Send as member"}</button>
        {error && <p className="reason" role="alert">{error}</p>}
      </section>
    );
  }

  const p = active.proposal;
  return (
    <section className="side-section" aria-label="Cover">
      <div className="msg from">
        <span className="who">{name(active.memberId)} · {clock(active.boardAt)}</span>
        <span>{active.text}</span>
      </div>
      {active.affected.length === 0 ? (
        <>
          <p>Nothing on the board needs to change.</p>
          <button className="btn secondary" onClick={() => run("dismiss", () => api(`/api/disruptions/${active.id}/dismiss`, {}))}>Done</button>
        </>
      ) : !p ? (
        <>
          <h2>{active.affected.length} visit{active.affected.length > 1 ? "s" : ""} need cover</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>{active.affected.map((id) => <li key={id}>{visitLabel(id)}</li>)}</ul>
          {busy === "propose" ? (
            <div className="working" role="status"><span className="spinner" /> The agent is working through the solver{board.mode.ai === "gemini" ? " (free-tier model, up to a minute)" : ""}.</div>
          ) : (
            <button className="btn" onClick={() => run("propose", () => api(`/api/disruptions/${active.id}/propose`, {}))}>Find cover</button>
          )}
        </>
      ) : active.status === "proposed" ? (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Proposal: {p.plan.covered} of {active.affected.length} covered</h2>
            <small>{p.source === "template" ? "solver + templates" : `${p.source}${p.model ? `, ${p.model}` : ""}`}</small>
          </div>
          <div>
            {p.plan.assignments.map((a) => (
              <div className="assign" key={a.visitId}>
                <span>{visitLabel(a.visitId)}</span>
                <b>{a.memberId ? name(a.memberId) : "no one"}</b>
                {a.consent && <span className="ask" style={{ gridColumn: "1 / -1" }}>Household asked first: they wanted the same cleaner.</span>}
                {!a.memberId && <span className="reason" style={{ gridColumn: "1 / -1" }}>No one can take it; the hold will be released.</span>}
              </div>
            ))}
          </div>
          {p.why && <p className="why">{p.why}</p>}
          <details>
            <summary>{p.messages.length} messages, in each person's language</summary>
            <div className="stack" style={{ marginTop: "0.6rem" }}>
              {p.messages.map((m) => (
                <div className="msg" key={m.toId}>
                  <span className="who">To {name(m.toId)} · {LANG_NAMES[m.language] ?? m.language}</span>
                  <span lang={m.language}>{m.text}</span>
                  {m.english && m.language !== "en" && <span className="en">{m.english}</span>}
                </div>
              ))}
            </div>
          </details>
          <details>
            <summary>How the agent got here</summary>
            <ol style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.88rem" }}>
              {p.turns.map((t, i) => <li key={i}><code>{t.call}</code></li>)}
              {p.rejected.map((r, i) => <li key={`r${i}`} className="reason">Refused: {r}</li>)}
            </ol>
            {p.alternatives.length > 0 && <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.4rem" }}>{p.alternatives.length} other valid plan{p.alternatives.length > 1 ? "s" : ""}: {p.alternatives.map((x) => `${x.covered} covered, ${x.consent} to ask`).join("; ")}.</p>}
          </details>
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => run("approve", async () => { const r = await api<{ moved: string[]; asked: string[]; released: string[] }>(`/api/disruptions/${active.id}/approve`, {}); setToast(`${r.moved.length} moved, ${r.asked.length} household asked, every hold kept`); })}>Approve and send</button>
            <button className="btn secondary" disabled={!!busy} onClick={() => run("dismiss", () => api(`/api/disruptions/${active.id}/dismiss`, {}))}>Dismiss</button>
          </div>
        </>
      ) : null}
      {error && <p className="reason" role="alert">{error}</p>}
    </section>
  );
}

const EVENT_TEXT: Record<string, (e: EventRow, n: (id: string) => string) => string> = {
  "hold.placed": (e) => `Hold placed: ${dollars(Number(e.data.cents))}`,
  "hold.failed": (e) => `Hold refused (${e.data.issue})`,
  "payment.captured": (e) => `Captured ${dollars(Number(e.data.cents))}, released ${dollars(Number(e.data.releasedCents))}`,
  "payment.voided": (e) => `Hold released: ${dollars(Number(e.data.cents))}`,
  "payout.sent": () => "Payout sent",
  "payout.final": (e) => `Payout ${String(e.data.status).toLowerCase()}`,
  "visit.checked_in": (e, n) => `${n(e.actor)} checked in`,
  "visit.checked_out": (e, n) => `${n(e.actor)} checked out`,
  "visit.cancelled": (e) => `Cancelled ${Math.round(Number(e.data.minutesBefore) / 60)} h before`,
  "visit.reassigned": (e, n) => `Moved to ${n(String(e.data.to))}`,
  "visit.consent_requested": (e, n) => `Asked the household about ${n(String(e.data.memberId))}`,
  "visit.consent_given": () => "Household agreed",
  "disruption.opened": (e, n) => `${n(e.actor)} is out`,
  "disruption.proposed": (e) => `Agent proposed plan ${e.data.rank} (${e.data.source})`,
  "disruption.approved": () => "Coordinator approved",
  "task.run": (e) => `Workflow ${e.data.task}: ${e.data.status}${Number(e.data.attempt) ? ` (attempt ${Number(e.data.attempt) + 1})` : ""}`,
  "task.crashed": () => "Task crashed after capture (test)",
  "clock.set": () => "Demo clock moved",
  "agreement.signed": (e, n) => `${n(e.actor)} signed and saved PayPal`,
  "paypal.webhook": (e) => `PayPal confirmed ${String(e.data.type).toLowerCase().replace(/_/g, " ")}`,
  "paypal.webhook_rejected": () => "Unverified webhook refused",
  "vault.repaired": (e, n) => `${n(e.actor)} saved PayPal again`,
};

function Feed({ board }: { board: Board }) {
  const n = (id: string) => board.members.find((m) => m.id === id)?.name.split(" ")[0] ?? board.households.find((h) => h.id === id)?.name ?? id;
  const hName = (vid: string | null) => {
    const v = vid ? board.visits.find((x) => x.id === vid) : null;
    return v ? board.households.find((h) => h.id === v.householdId)?.name ?? "" : "";
  };
  const rows = board.events.filter((e) => EVENT_TEXT[e.type]).slice(0, 18);
  return (
    <section className="side-section" aria-label="Activity">
      <h2>Activity</h2>
      <div className="feed">
        {rows.map((e) => (
          <div key={e.id}><span className="muted mono">{clock(e.board_at)}</span><span>{hName(e.visit_id) && <b>{hName(e.visit_id)}: </b>}{EVENT_TEXT[e.type]!(e, n)}</span></div>
        ))}
      </div>
    </section>
  );
}

function VisitPanel({ board, visit, onClose, reload, setToast }: { board: Board; visit: PublicVisit; onClose: () => void; reload: () => Promise<void>; setToast: (s: string) => void }) {
  const h = board.households.find((x) => x.id === visit.householdId)!;
  const [to, setTo] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; reasons: string[]; consent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCheck(null);
    if (!to) return;
    void api<{ ok: boolean; reasons: string[]; consent: boolean }>(`/api/visits/${visit.id}/check-move`, { memberId: to }).then(setCheck).catch((e) => setError(e.message));
  }, [to, visit.id]);
  const name = (id: string) => board.members.find((m) => m.id === id)?.name ?? id;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      setToast(msg);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const live = !["paid_out", "cancelled", "voided", "late_cancel", "settling", "captured", "in_progress"].includes(visit.state);
  return (
    <section className="side-section" aria-label="Visit">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{h.name}</h2>
        <button className="btn quiet small" onClick={onClose}>Close</button>
      </div>
      <span className={`chip s-${visit.state}`}>{STATE_LABEL[visit.state]}</span>
      <dl className="kv">
        <dt>When</dt><dd>{WEEK_DAYS[Math.floor(visit.start / 1440)]} {clock(visit.start)}–{clock(visit.start + visit.minutes)}</dd>
        <dt>Where</dt><dd>{h.area}</dd>
        <dt>Member</dt><dd>{visit.memberIds.map(name).join(", ") || "no one yet"}{visit.pendingMember && <span className="ask"> · asking about {name(visit.pendingMember)}</span>}</dd>
        <dt>Needs</dt><dd>{[...h.needs.map((x) => (x === "pets" ? "pets" : x === "eco" ? "fragrance-free" : "deep clean")), h.sameCleaner ? "same cleaner" : ""].filter(Boolean).join(", ") || "none"}</dd>
        <dt>Price</dt><dd className="mono">{dollars(visit.priceCents)} ({dollars(visit.terms.rateCentsPerHour)}/h)</dd>
        <dt>PayPal</dt><dd>{chipText(visit)}</dd>
        {visit.hold && <><dt>Authorization</dt><dd className="mono">{visit.hold.authorizationId}</dd></>}
        {visit.capture && <><dt>Capture</dt><dd className="mono">{dollars(visit.capture.cents)} · {visit.capture.captureId}</dd></>}
        {visit.settlement && <><dt>Released</dt><dd className="mono">{dollars(visit.settlement.releaseCents)}</dd><dt>Cooperative</dt><dd className="mono">{dollars(visit.settlement.coopCents)}</dd></>}
        {visit.payout && <><dt>Payout</dt><dd>{visit.payout.items.map((i) => `${name(i.memberId)} ${dollars(i.cents)} via ${i.wallet === "VENMO" ? "Venmo" : "PayPal"}`).join("; ")} · {visit.payout.status.toLowerCase()}{visit.payout.finalMs ? ` in ${(visit.payout.finalMs / 1000).toFixed(0)} s` : ""}</dd></>}
      </dl>
      {(visit.capture || visit.void) && <a className="btn quiet small" style={{ justifySelf: "start" }} href={`/evidence/${visit.id}`}>Evidence if the household disputes</a>}
      {live && (
        <div className="stack">
          <label>Move to
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a member…</option>
              {board.members.filter((m) => !visit.memberIds.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          {check && (check.ok
            ? <p>{check.consent ? <span className="ask">The household asked for the same cleaner; they will be asked first.</span> : "Fits: availability, skills, travel time and hours all check out."}</p>
            : <ul className="reason" style={{ margin: 0, paddingLeft: "1.1rem" }}>{check.reasons.map((r) => <li key={r}>{r}</li>)}</ul>)}
          <div className="row">
            <button className="btn" disabled={!check?.ok} onClick={() => act(() => api(`/api/visits/${visit.id}/move`, { memberId: to }), "Moved; the hold stays with the visit")}>Move</button>
            {visit.hold && <button className="btn danger" onClick={() => act(() => api(`/api/visits/${visit.id}/release`, {}), "Hold released")}>No cover: release hold</button>}
          </div>
          {board.mode.demo && visit.hold && (
            <button className="btn quiet small" style={{ justifySelf: "start" }} onClick={() => act(() => api("/api/demo/crash-next-settle", { visitId: visit.id }), "The next settlement of this visit will crash once after the capture")}>Test: crash its settlement once after capture</button>
          )}
        </div>
      )}
      {error && <p className="reason" role="alert">{error}</p>}
    </section>
  );
}
