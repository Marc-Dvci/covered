// One line above the board that tells a first-time visitor what to do next.
import { useState } from "react";
import { Link } from "react-router-dom";
import { clock } from "../../../shared/domain.ts";
import { nextStep, STEP_COUNT } from "../../../shared/guide.ts";
import { api, type Board } from "../api.ts";

export function DemoGuide({ board, reload }: { board: Board; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const step = nextStep(board);
  if (!step) return null;
  const move = async (at: number) => {
    setBusy(true);
    try {
      await api("/api/clock", { at });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="guide" role="status" aria-label="What to do next">
      <span className="guide-n">Step {step.n} of {STEP_COUNT}</span>
      <span className="guide-text">{step.text}</span>
      {step.clockTo !== undefined && <button className="btn small" disabled={busy} onClick={() => void move(step.clockTo!)}>Move the clock to {clock(step.clockTo)}</button>}
      {step.link && <Link className="guide-link" to={step.link.to}>{step.link.label}</Link>}
    </div>
  );
}
