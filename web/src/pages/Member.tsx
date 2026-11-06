import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { clock, dollars, LANG_NAMES, WEEK_DAYS, type Household, type Member } from "../../../shared/domain.ts";
import { api, usePoll, type Mode, type PublicVisit } from "../api.ts";
import { hasUi, t } from "../i18n.ts";

interface MemberView {
  member: Member;
  now: number;
  mode: Mode;
  today: PublicVisit[];
  week: PublicVisit[];
  households: Household[];
  messages: { toId: string; language: string; text: string; english?: string; at: number }[];
}

export function MemberPage() {
  const { id = "teresa" } = useParams();
  const { data, reload } = usePoll<MemberView>(`/api/members/${id}/today`, 2000);
  const [english, setEnglish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <p className="page">Loading…</p>;
  const m = data.member;
  const lang = english || !hasUi(m.languages[0]!) ? "en" : m.languages[0]!;
  const hh = (hid: string) => data.households.find((h) => h.id === hid);
  const act = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setError(null);
    try {
      await api(path, body);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const myPay = (v: PublicVisit) => v.payout?.items.find((i) => i.memberId === m.id) ?? null;

  return (
    <div className="phones">
      <div className="phone" aria-label={`${m.name}'s phone`}>
        <div className="phone-bar">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{m.name}</b>
            <span className="mono">
              {WEEK_DAYS[Math.floor(data.now / 1440)]} {clock(data.now)}
            </span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <small>
              {LANG_NAMES[m.languages[0]!]} · paid by {m.payout.wallet === "VENMO" ? "Venmo" : "PayPal"}
            </small>
            {m.languages[0] !== "en" && (
              <button className="btn quiet small" onClick={() => setEnglish(!english)}>
                {english ? LANG_NAMES[m.languages[0]!] : "English"}
              </button>
            )}
          </div>
        </div>
        <div className="phone-body" lang={lang}>
          {data.messages.length > 0 && (
            <section className="stack" aria-label={t(lang, "messages")}>
              <h2>{t(lang, "messages")}</h2>
              {data.messages.slice(0, 3).map((x, i) => (
                <div className="msg" key={i}>
                  <span className="who">Dana · {clock(x.at)}</span>
                  <span lang={english ? "en" : x.language}>{english && x.english ? x.english : x.text}</span>
                </div>
              ))}
            </section>
          )}
          <section className="stack" aria-label={t(lang, "today")}>
            <h2>{t(lang, "today")}</h2>
            {data.today.length === 0 && <p className="muted">{t(lang, "noVisits")}</p>}
            {data.today.map((v) => {
              const h = hh(v.householdId);
              const pay = myPay(v);
              const pending = v.pendingMember === m.id;
              return (
                <div className="visit" key={v.id} data-visit={v.id}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <b>
                      {clock(v.start)}–{clock(v.start + v.minutes)}
                    </b>
                    <span className={`chip s-${v.state}`}>
                      {v.state === "paid_out"
                        ? t(lang, "paid")
                        : v.state === "late_cancel" && v.capture
                          ? dollars(v.capture.cents)
                          : v.hold
                            ? dollars(v.hold.cents)
                            : "–"}
                    </span>
                  </div>
                  <span>
                    {h?.name} · {h?.area}
                  </span>
                  {h && h.needs.length > 0 && (
                    <small>
                      {t(lang, "needs")}: {h.needs.map((n) => t(lang, n === "deep_clean" ? "deep" : n)).join(", ")}
                    </small>
                  )}
                  {pending && <span className="ask">{t(lang, "asked")}</span>}
                  {v.hold && !["paid_out", "late_cancel", "voided", "cancelled"].includes(v.state) && (
                    <small>
                      {dollars(v.hold.cents)} {t(lang, "held")}
                    </small>
                  )}
                  {!v.hold && v.state === "scheduled" && <small>{t(lang, "notHeld")}</small>}
                  {v.state === "in_progress" && (
                    <small>
                      {t(lang, "inProgress")} {clock(v.checkinAt ?? v.start)}
                    </small>
                  )}
                  {pay && (
                    <div className="stack" style={{ gap: "0.2rem" }}>
                      <span className="big-money">{dollars(pay.cents)}</span>
                      <small>
                        {v.state === "late_cancel" ? t(lang, "fee") : t(lang, "yourPay")} {t(lang, "via")} {pay.wallet === "VENMO" ? "Venmo" : "PayPal"} ·{" "}
                        {pay.status === "SUCCESS" ? t(lang, "paid") : t(lang, "pending")}
                        {v.payout?.finalMs ? ` (${Math.round(v.payout.finalMs / 1000)} s)` : ""}
                      </small>
                    </div>
                  )}
                  {v.state === "voided" && <small>{t(lang, "releasedNote")}</small>}
                  {!pending && v.memberIds.includes(m.id) && (
                    <div className="row">
                      {["held", "at_risk", "scheduled"].includes(v.state) && (
                        <button className="btn" disabled={!!busy} onClick={() => act(`in-${v.id}`, `/api/visits/${v.id}/checkin`, { memberId: m.id })}>
                          {t(lang, "checkIn")}
                        </button>
                      )}
                      {["held", "at_risk"].includes(v.state) && (
                        <button
                          className="btn secondary"
                          disabled={!!busy}
                          onClick={() => act(`lock-${v.id}`, `/api/visits/${v.id}/lockout`, { memberId: m.id })}
                        >
                          {t(lang, "lockout")}
                        </button>
                      )}
                      {v.state === "in_progress" && (
                        <button className="btn" disabled={!!busy} onClick={() => act(`out-${v.id}`, `/api/visits/${v.id}/checkout`, { memberId: m.id })}>
                          {t(lang, "checkOut")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
          {error && (
            <p className="reason" role="alert">
              {error}
            </p>
          )}
          <Link to={`/m/${m.id}/statement`}>{t(lang, "statement")}</Link>
        </div>
      </div>
      <MemberSwitch current={m.id} />
    </div>
  );
}

function MemberSwitch({ current }: { current: string }) {
  const { data } = usePoll<{ members: Member[] }>("/api/board", 10000);
  if (!data) return null;
  return (
    <nav aria-label="Members" className="stack" style={{ alignContent: "start", minWidth: 200 }}>
      <h2>Members</h2>
      {data.members.map((m) => (
        <Link key={m.id} to={`/m/${m.id}`} aria-current={m.id === current ? "page" : undefined} style={{ fontWeight: m.id === current ? 700 : 400 }}>
          {m.name}
        </Link>
      ))}
      <p className="fictional">Each member opens their own page on their phone. Fictional people.</p>
    </nav>
  );
}
