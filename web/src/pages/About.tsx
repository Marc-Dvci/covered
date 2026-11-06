import dev from "../../../eval/disruptions/results.json" with { type: "json" };
import held from "../../../eval/heldout/results.json" with { type: "json" };
import table from "../../../shared/rules/cases.json" with { type: "json" };
import { dollars } from "../../../shared/domain.ts";
import { usePoll, type Mode } from "../api.ts";

interface About {
  mode: Mode;
  ai: { live: boolean; until: string; callsToday: number; dailyCap: number; byTask: { task: string; model: string; n: string; ms: string }[] };
  taskRuns: { status: string; n: string }[];
  money: { kind: string; n: string; cents: string }[];
}

export function AboutPage() {
  const { data } = usePoll<About>("/api/about", 5000);
  return (
    <div className="page">
      <div className="stack">
        <h1>Evidence</h1>
        <p className="lede">What the code decides, what the model does, and the numbers behind both. Rebuild them with <code>npm test</code> and <code>npm run eval</code>.</p>
      </div>
      <section className="stack">
        <h2>Who covers a visit</h2>
        <div className="stats">
          <div className="stat"><small>Development set</small><b>{dev.solverCovered} / {dev.oracleMaxCovered}</b><small>visits placed, of the most any assignment can place ({dev.scenarios} scenarios)</small></div>
          <div className="stat"><small>Held-out set</small><b>{held.solverCovered} / {held.oracleMaxCovered}</b><small>run once, after the solver was frozen</small></div>
          <div className="stat"><small>Rules broken by the solver</small><b>{dev.solverConstraintViolations + held.solverConstraintViolations}</b><small>availability, skills, travel, hours, same cleaner</small></div>
          <div className="stat"><small>"First free member" baseline</small><b>{dev.baselineVisitsBreakingARule + held.baselineVisitsBreakingARule}</b><small>placed visits that break a rule, of {dev.baselinePlaced + held.baselinePlaced}</small></div>
        </div>
      </section>
      <section className="stack">
        <h2>Who gets paid what</h2>
        <p>{table.cases.length} pay rules worked out by hand before the engine was written: on-time, extra time, late cancellations, lock-outs, covers, two and three members, odd rates. The engine matches all {table.cases.length}, and property tests check that money is conserved on thousands of random cases.</p>
      </section>
      <section className="stack">
        <h2>Where the model is, and where it is not</h2>
        <p>Code decides every amount, every fee, who is paid, which assignments are valid and whether an agreement is complete. Gemini reads members' messages, chooses among the solver's plans and explains why, writes each message in the recipient's language, drafts agreements from words and voice, and writes the income cover letter. A message with a number the tools did not give is refused.</p>
      </section>
      {data && (
        <section className="stack">
          <h2>This deployment</h2>
          <dl className="kv">
            <dt>PayPal</dt><dd>{data.mode.paypal === "sandbox" ? `PayPal sandbox (${data.mode.currency})` : "deterministic stand-in (no PayPal keys set)"}</dd>
            <dt>Money tasks</dt><dd>{data.mode.runner === "cloudflare" ? "Cloudflare Workflows" : "in-process runner with the same retry policy"}</dd>
            <dt>Model</dt><dd>{data.ai.live ? `Gemini API, live until ${data.ai.until}, ${data.ai.callsToday} of ${data.ai.dailyCap} calls used today` : "recorded answers and deterministic fallbacks"}</dd>
            <dt>Workflow runs</dt><dd>{data.taskRuns.map((r) => `${r.n} ${r.status}`).join(", ") || "none yet"}</dd>
            <dt>Money moved</dt><dd>{data.money.map((m) => `${m.kind} ${m.n} (${dollars(Number(m.cents))})`).join(", ") || "none yet"}</dd>
          </dl>
          {data.ai.byTask.length > 0 && (
            <table>
              <thead><tr><th>Model task</th><th>Model</th><th className="num">Answers</th><th className="num">Mean time</th></tr></thead>
              <tbody>{data.ai.byTask.map((r) => <tr key={r.task + r.model}><td>{r.task}</td><td>{r.model}</td><td className="num">{r.n}</td><td className="num">{(Number(r.ms) / 1000).toFixed(1)} s</td></tr>)}</tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
