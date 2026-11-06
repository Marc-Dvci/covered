import { useState } from "react";
import { useParams } from "react-router-dom";
import { dollars } from "../../../shared/domain.ts";
import { api, usePoll } from "../api.ts";

interface StatementView {
  memberName: string;
  months: { month: string; visits: number; hours: number; cents: number }[];
  lines: {
    visitId: string;
    date: string;
    household: string;
    minutes: number;
    cents: number;
    kind: string;
    transactionId: string | null;
    payoutStatus: string;
    reconciled: string;
  }[];
  totalCents: number;
  reconciledCount: number;
  searchedAt: string | null;
  searchError: string | null;
  letter: { text: string; source: string };
}

export function StatementPage() {
  const { id = "teresa" } = useParams();
  const { data } = usePoll<StatementView>(`/api/members/${id}/statement`, 15000);
  const [link, setLink] = useState<string | null>(null);
  if (!data) return <p className="page">Loading…</p>;
  return (
    <div className="page">
      <div className="stack">
        <h1>{data.memberName}: income statement</h1>
        <p className="lede">Every line is a payout from the cooperative through PayPal, matched by transaction id against PayPal's Transaction Search.</p>
      </div>
      <div className="stats">
        <div className="stat">
          <small>Paid</small>
          <b>{dollars(data.totalCents)}</b>
        </div>
        <div className="stat">
          <small>Payouts</small>
          <b>{data.lines.length}</b>
        </div>
        <div className="stat">
          <small>Matched in PayPal</small>
          <b>
            {data.reconciledCount} / {data.lines.length}
          </b>
        </div>
      </div>
      {data.searchError && (
        <p className="muted">PayPal's Transaction Search has not answered yet, so lines show their payout's transaction id until it does.</p>
      )}
      {!data.searchError && data.reconciledCount < data.lines.length && (
        <p className="muted">
          On the sandbox, PayPal's Transaction Search lists a payout 2 to 3 hours after it happens. Until then, its line reads as pending.
        </p>
      )}
      <p className="why">{data.letter.text}</p>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Household</th>
            <th className="num">Hours</th>
            <th>Kind</th>
            <th className="num">Paid</th>
            <th>PayPal transaction</th>
            <th>Matched</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.visitId}>
              <td>{l.date}</td>
              <td>{l.household}</td>
              <td className="num">{(l.minutes / 60).toFixed(2)}</td>
              <td>{l.kind.replace("_", " ")}</td>
              <td className="num">{dollars(l.cents)}</td>
              <td className="mono">{l.transactionId ?? "pending"}</td>
              <td>{l.reconciled}</td>
            </tr>
          ))}
          {data.lines.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No payouts yet. Check out of a visit on the member's phone and the line appears here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            const r = await api<{ token: string }>(`/api/members/${id}/share`, {});
            setLink(`${location.origin}/s/${r.token}`);
          }}
        >
          Make a link for a landlord
        </button>
        {link && <a href={link}>{link}</a>}
      </div>
      <small className="muted">
        The landlord link shows months, hours, totals and transaction ids. It never shows households or addresses, and it expires in 30 days.
      </small>
    </div>
  );
}
