import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { clock, dollars, WEEK_DAYS, type Household } from "../../../shared/domain.ts";
import { api, usePoll, type Mode, type PublicVisit } from "../api.ts";

interface HouseholdView {
  household: Household & { paypalSaved: boolean };
  now: number;
  mode: Mode;
  visits: PublicVisit[];
  members: { id: string; name: string }[];
  messages: { text: string; english?: string; language: string; at: number }[];
  agreement: { readback: { language: string; text: string }[] } | null;
}

interface Preview {
  minutesBefore: number;
  late: boolean;
  feeCents: number;
  releaseCents: number;
  heldCents: number;
  lateFeeCents: number;
  noticeHours: number;
  closed: boolean;
}

export function HouseholdPage() {
  const { id = "okafor" } = useParams();
  const [q] = useSearchParams();
  const { data, reload } = usePoll<HouseholdView>(`/api/households/${id}`, 2000);
  const [preview, setPreview] = useState<{ id: string; p: Preview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <p className="page">Loading…</p>;
  const h = data.household;
  const name = (mid: string) => data.members.find((m) => m.id === mid)?.name ?? mid;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upcoming = data.visits.filter((v) => !["done", "paid_out", "cancelled", "voided", "late_cancel"].includes(v.state));
  const done = data.visits.filter((v) => ["paid_out", "cancelled", "voided", "late_cancel"].includes(v.state));
  const asks = data.visits.filter((v) => v.pendingMember);

  return (
    <div className="phones">
      <div className="phone" aria-label={`${h.name}'s phone`}>
        <div className="phone-bar">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{h.name}</b>
            <span className="mono">
              {WEEK_DAYS[Math.floor(data.now / 1440)]} {clock(data.now)}
            </span>
          </div>
          <small>
            {h.area} · PayPal {h.paypalSaved ? "saved" : "not saved"}
          </small>
        </div>
        <div className="phone-body">
          {q.get("welcome") && <p className="why">Agreement signed and PayPal saved. Your first visit is on the board.</p>}
          {q.get("repaired") && <p className="why">PayPal saved again. Your visits will be held as usual.</p>}
          {data.visits.some((v) => v.state === "at_risk") && (
            <section className="stack" aria-label="Payment problem">
              <h2>PayPal refused the hold</h2>
              <p>We could not hold the pay for your next visit. Save your PayPal again so the visit can go ahead; nothing is charged now.</p>
              <button
                className="btn"
                style={{ justifySelf: "start" }}
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    window.location.href = (await api<{ approveUrl: string }>(`/api/households/${h.id}/repair`, {})).approveUrl;
                  })
                }
              >
                Save PayPal again
              </button>
            </section>
          )}
          {asks.map((v) => (
            <section className="stack" key={`ask-${v.id}`} aria-label="Request">
              <h2>{name(v.memberIds[0]!)} is out</h2>
              <p>
                {name(v.pendingMember!)} can come on {WEEK_DAYS[Math.floor(v.start / 1440)]} at {clock(v.start)} instead. You asked for the same cleaner, so we
                are checking with you first.
              </p>
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => act(() => api(`/api/visits/${v.id}/consent`, { householdId: h.id, approve: true }))}>
                  Yes, that's fine
                </button>
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => act(() => api(`/api/visits/${v.id}/consent`, { householdId: h.id, approve: false }))}
                >
                  No thanks
                </button>
              </div>
            </section>
          ))}
          {data.messages.length > 0 && (
            <section className="stack" aria-label="Messages">
              <h2>Messages</h2>
              {data.messages.slice(0, 2).map((m, i) => (
                <div className="msg" key={i}>
                  <span className="who">Cooperative · {clock(m.at)}</span>
                  <span lang={m.language}>{m.text}</span>
                  {m.english && m.language !== "en" && <span className="en">{m.english}</span>}
                </div>
              ))}
            </section>
          )}
          <section className="stack" aria-label="Visits">
            <h2>Your visits</h2>
            {upcoming.length === 0 && <p className="muted">No upcoming visits this week.</p>}
            {upcoming.map((v) => (
              <div className="visit" key={v.id} data-visit={v.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>
                    {WEEK_DAYS[Math.floor(v.start / 1440)]} {clock(v.start)}–{clock(v.start + v.minutes)}
                  </b>
                  <span className={`chip s-${v.state}`}>
                    {v.hold ? `${dollars(v.hold.cents)} held` : v.state === "at_risk" ? "PayPal refused" : "not held yet"}
                  </span>
                </div>
                <span>{v.memberIds.map(name).join(", ") || "Member to be confirmed"}</span>
                <small>
                  {v.hold
                    ? `${dollars(v.hold.cents)} is held on your PayPal: ${dollars(v.priceCents)} for the visit plus up to ${v.terms.extraAllowanceMinutes} extra minutes you approve. You pay when the visit ends; the rest is released.`
                    : `${dollars(v.holdCents)} will be held on your PayPal ${v.terms.noticeHours} hours before (${WEEK_DAYS[Math.floor((v.start - v.terms.noticeHours * 60) / 1440)]} ${clock(v.start - v.terms.noticeHours * 60)}). Cancel before then and nothing is held.`}
                </small>
                {preview?.id === v.id ? (
                  <div className="stack">
                    <p>
                      {preview.p.late ? (
                        <>
                          Cancelling now is inside the {preview.p.noticeHours}-hour notice: <b>{dollars(preview.p.feeCents)}</b> goes to{" "}
                          {v.memberIds.map(name).join(", ")}
                          {preview.p.releaseCents ? <>, and {dollars(preview.p.releaseCents)} is released.</> : "."}
                        </>
                      ) : (
                        <>Cancelling now is free. {preview.p.heldCents ? `${dollars(preview.p.heldCents)} will be released.` : "Nothing is held yet."}</>
                      )}
                    </p>
                    <div className="row">
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await api(`/api/visits/${v.id}/cancel`, { by: "household", actor: h.id });
                            setPreview(null);
                          })
                        }
                      >
                        Cancel the visit
                      </button>
                      <button className="btn secondary" onClick={() => setPreview(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  v.start > data.now &&
                  ["scheduled", "held", "at_risk"].includes(v.state) && (
                    <button
                      className="btn quiet small"
                      style={{ justifySelf: "start" }}
                      onClick={() => act(async () => setPreview({ id: v.id, p: await api<Preview>(`/api/visits/${v.id}/cancel-preview`) }))}
                    >
                      Cancel…
                    </button>
                  )
                )}
              </div>
            ))}
          </section>
          {done.length > 0 && (
            <section className="stack" aria-label="Receipts">
              <h2>Receipts</h2>
              {done.map((v) => (
                <div className="visit" key={v.id} data-visit={v.id}>
                  <b>
                    {WEEK_DAYS[Math.floor(v.start / 1440)]} {clock(v.start)}
                  </b>
                  {v.capture ? (
                    <span>
                      Paid {dollars(v.capture.cents)}
                      {v.settlement?.releaseCents ? `, ${dollars(v.settlement.releaseCents)} released` : ""}
                      {v.state === "late_cancel" ? " (late-cancel fee)" : ""}
                    </span>
                  ) : (
                    <span>Nothing charged{v.hold ? `; ${dollars(v.hold.cents)} released` : ""}</span>
                  )}
                  {v.capture && <small className="mono">PayPal capture {v.capture.captureId}</small>}
                </div>
              ))}
            </section>
          )}
          {error && (
            <p className="reason" role="alert">
              {error}
            </p>
          )}
          {data.agreement && (
            <details>
              <summary>Your agreement</summary>
              {data.agreement.readback.map((r) => (
                <p key={r.language} lang={r.language} style={{ marginTop: "0.5rem" }}>
                  {r.text}
                </p>
              ))}
            </details>
          )}
        </div>
      </div>
      <HouseholdSwitch current={h.id} />
    </div>
  );
}

function HouseholdSwitch({ current }: { current: string }) {
  const { data } = usePoll<{ households: Household[]; visits: PublicVisit[]; now: number }>("/api/board", 10000);
  if (!data) return null;
  const day = Math.floor(data.now / 1440);
  const today = new Set(data.visits.filter((v) => Math.floor(v.start / 1440) === day).map((v) => v.householdId));
  return (
    <nav aria-label="Households" className="stack" style={{ alignContent: "start", minWidth: 200 }}>
      <h2>Households with a visit today</h2>
      {data.households
        .filter((h) => today.has(h.id) || h.id === current)
        .map((h) => (
          <Link key={h.id} to={`/h/${h.id}`} aria-current={h.id === current ? "page" : undefined} style={{ fontWeight: h.id === current ? 700 : 400 }}>
            {h.name}
          </Link>
        ))}
      <p className="fictional">Fictional households.</p>
    </nav>
  );
}
