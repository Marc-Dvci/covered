import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { dollars } from "../../../shared/domain.ts";
import { api } from "../api.ts";
import { Logo } from "../components/Top.tsx";

interface ShareView {
  name: string;
  months: { month: string; visits: number; hours: number; cents: number }[];
  totalCents: number;
  payouts: number;
  reconciled: number;
  lines: { date: string; hours: number; cents: number; transactionId: string | null; reconciled: string }[];
  expiresAt: string;
  letter: { text: string };
}

export function SharePage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      void api<ShareView>(`/api/share/${token}`)
        .then(setData)
        .catch((e) => setError(e.message)),
    [token],
  );
  if (error)
    return (
      <main className="page">
        <h1>Link not valid</h1>
        <p>{error}</p>
      </main>
    );
  if (!data) return <main className="page">Loading…</main>;
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="row">
        <span className="brand" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ width: 26, height: 26, display: "inline-block" }}>
            <Logo />
          </span>
          <b>Income statement</b>
        </span>
      </div>
      <h1>{data.name}</h1>
      <p>{data.letter.text}</p>
      <div className="stats">
        <div className="stat">
          <small>Paid</small>
          <b>{dollars(data.totalCents)}</b>
        </div>
        <div className="stat">
          <small>Payouts</small>
          <b>{data.payouts}</b>
        </div>
        <div className="stat">
          <small>Matched in PayPal</small>
          <b>
            {data.reconciled} / {data.payouts}
          </b>
        </div>
      </div>
      {data.reconciled < data.payouts && (
        <p className="muted">
          On the sandbox, PayPal's Transaction Search lists a payout about 2 hours after it happens, so newer payouts are not matched yet.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th className="num">Visits</th>
            <th className="num">Hours</th>
            <th className="num">Paid</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month}>
              <td>{m.month}</td>
              <td className="num">{m.visits}</td>
              <td className="num">{m.hours.toFixed(2)}</td>
              <td className="num">{dollars(m.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th className="num">Hours</th>
            <th className="num">Paid</th>
            <th>PayPal transaction</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.date}</td>
              <td className="num">{l.hours.toFixed(2)}</td>
              <td className="num">{dollars(l.cents)}</td>
              <td className="mono">
                {l.transactionId ?? "pending"} {l.reconciled === "matched" ? "✓" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <small className="muted">Shared by the member. Households and addresses are not shown. Valid until {data.expiresAt.slice(0, 10)}.</small>
    </main>
  );
}
