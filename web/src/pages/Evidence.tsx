import { useParams } from "react-router-dom";
import { usePoll } from "../api.ts";

interface EvidenceView {
  visitId: string;
  household: { name: string; area: string };
  members: string[];
  scheduled: { date: string; start: string; end: string; timeZone: string };
  terms: { rate: string; price: string; hold: string; noticeHours: number; lateCancelPct: number; lockoutPct: number; extraAllowanceMinutes: number };
  agreementId: string | null;
  attendance: { checkIn: string | null; checkOut: string | null; minutesOnSite: number | null; extraApproved: boolean | null };
  outcome: string;
  money: { step: string; amount: string; paypalId: string | null; status: string; at: string }[];
  timeline: { at: string; what: string; by: string }[];
  summary: string;
}

export function EvidencePage() {
  const { id = "" } = useParams();
  const { data, error } = usePoll<EvidenceView>(`/api/visits/${id}/evidence`, 15000);
  if (error) return <p className="page reason" role="alert">{error}</p>;
  if (!data) return <p className="page">Loading…</p>;
  const t = data.terms;
  return (
    <div className="page">
      <div className="stack">
        <h1>Evidence for a dispute: {data.household.name}</h1>
        <p className="lede">If the household disputes this charge with PayPal, this is the cooperative's answer. It is built from the ledger only: the agreed terms, the check-in and check-out, and each PayPal id.</p>
      </div>
      <p className="why">{data.summary}</p>
      <dl className="kv">
        <dt>Visit</dt><dd className="mono">{data.visitId}</dd>
        <dt>Booked for</dt><dd>{data.scheduled.date}, {data.scheduled.start}–{data.scheduled.end} ({data.scheduled.timeZone})</dd>
        <dt>Where</dt><dd>{data.household.area}</dd>
        <dt>Member</dt><dd>{data.members.join(", ") || "no one"}</dd>
        <dt>Agreed terms</dt><dd>{t.rate} an hour, {t.price} a visit; {t.hold} held {t.noticeHours} h ahead; late cancel {t.lateCancelPct}%, no access {t.lockoutPct}%; up to {t.extraAllowanceMinutes} extra minutes with the household's approval</dd>
        {data.agreementId && <><dt>Agreement</dt><dd className="mono">{data.agreementId}</dd></>}
        <dt>Checked in</dt><dd>{data.attendance.checkIn ?? "no"}</dd>
        <dt>Checked out</dt><dd>{data.attendance.checkOut ?? "no"}{data.attendance.minutesOnSite !== null && ` (${data.attendance.minutesOnSite} minutes on site${data.attendance.extraApproved ? ", extra time approved" : ""})`}</dd>
        <dt>Outcome</dt><dd>{data.outcome}</dd>
      </dl>
      <h2>Money</h2>
      <table>
        <thead><tr><th>Step</th><th className="num">Amount</th><th>PayPal id</th><th>Status</th><th>When</th></tr></thead>
        <tbody>
          {data.money.map((m) => <tr key={`${m.step}${m.paypalId}`}><td>{m.step}</td><td className="num">{m.amount}</td><td className="mono">{m.paypalId ?? "none"}</td><td>{m.status.toLowerCase()}</td><td>{m.at}</td></tr>)}
          {data.money.length === 0 && <tr><td colSpan={5} className="muted">No money has moved for this visit.</td></tr>}
        </tbody>
      </table>
      <h2>What happened</h2>
      <table>
        <thead><tr><th>When</th><th>What</th><th>By</th></tr></thead>
        <tbody>{data.timeline.map((e, i) => <tr key={i}><td>{e.at}</td><td>{e.what}</td><td>{e.by}</td></tr>)}</tbody>
      </table>
      <div className="row">
        <button className="btn secondary" onClick={() => window.print()}>Print</button>
        <a className="btn quiet" href={`/api/visits/${data.visitId}/evidence`} download={`evidence-${data.visitId}.json`}>Download as JSON</a>
      </div>
    </div>
  );
}
