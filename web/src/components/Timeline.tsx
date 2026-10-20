// The coordinator's day: one row per member, one bar per visit, coloured by where its money is.
// Dotted tails are travel time to the next home. Dashed bars are the agent's proposal.
import { clock, dollars, type Member } from "../../../shared/domain.ts";
import { travelMinutes } from "../../../shared/travel.ts";
import { STATE_LABEL, type Board, type Plan, type PublicVisit } from "../api.ts";

const FROM = 7 * 60;
const SPAN = 12 * 60;
const pct = (m: number) => `${((m - FROM) / SPAN) * 100}%`;

export function chipText(v: PublicVisit): string {
  if (v.state === "paid_out" && v.payout) return `paid ${dollars(v.payout.items.reduce((a, i) => a + i.cents, 0))}`;
  if (v.state === "late_cancel" && v.capture) return `fee ${dollars(v.capture.cents)}`;
  if (v.state === "captured" && v.capture) return `captured ${dollars(v.capture.cents)}`;
  if (v.state === "in_progress") return v.hold ? `${dollars(v.hold.cents)} held, in progress` : "in progress";
  if (v.hold && ["held", "settling"].includes(v.state)) return `${dollars(v.hold.cents)} held since ${weekday(v.hold.placedAt)} ${clock(v.hold.placedAt)}`;
  if (v.state === "at_risk") return "hold refused";
  if (v.state === "holding") return "placing hold";
  if (v.state === "voided") return "hold released";
  if (v.state === "cancelled") return "cancelled";
  if (v.state === "done") return "before the demo week";
  return `${dollars(v.priceCents)}, held 24 h before`;
}

const weekday = (t: number) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(t / 1440)] ?? "";

export function Timeline({ board, day, ghost, selected, onSelect, absent }: {
  board: Board;
  day: number;
  ghost: Plan | null;
  selected: string | null;
  onSelect: (id: string) => void;
  absent: Set<string>;
}) {
  const hh = new Map(board.households.map((h) => [h.id, h]));
  const dayVisits = board.visits.filter((v) => Math.floor(v.start / 1440) === day);
  const orphans = dayVisits.filter((v) => v.memberIds.length === 0 && !["cancelled", "voided", "late_cancel"].includes(v.state));
  const now = board.now;
  const showNow = Math.floor(now / 1440) === day && now % 1440 >= FROM && now % 1440 <= FROM + SPAN;
  const ghostFor = (memberId: string) => (ghost?.assignments ?? []).filter((a) => a.memberId === memberId).map((a) => board.visits.find((v) => v.id === a.visitId)!).filter(Boolean);
  const pendingFor = (memberId: string) => dayVisits.filter((v) => v.pendingMember === memberId);

  const renderBar = (v: PublicVisit, kind: "real" | "ghost" | "orphan") => {
    const h = hh.get(v.householdId);
    const m = v.start % 1440;
    const cls = kind === "ghost" ? "bar ghost" : kind === "orphan" ? `bar orphan` : `bar s-${v.state}`;
    return (
      <button
        key={`${kind}-${v.id}`}
        className={`${cls}${selected === v.id ? " selected" : ""}`}
        style={{ left: pct(m), width: `calc(${(v.minutes / SPAN) * 100}% - 2px)` }}
        onClick={() => onSelect(v.id)}
        aria-label={`${h?.name}, ${clock(v.start)} to ${clock(v.start + v.minutes)}, ${kind === "ghost" ? "proposed" : STATE_LABEL[v.state]}`}
        data-visit={v.id}
        data-kind={kind}
      >
        <b>{h?.name}</b>
        <span>{clock(v.start)} · {kind === "ghost" ? (v.pendingMember || ghost?.assignments.find((a) => a.visitId === v.id)?.consent ? "proposed, household asked first" : "proposed") : chipText(v)}</span>
      </button>
    );
  };

  const travelTails = (vs: PublicVisit[]) => {
    const sorted = [...vs].sort((a, b) => a.start - b.start);
    return sorted.slice(0, -1).map((v, i) => {
      const next = sorted[i + 1]!;
      const a = hh.get(v.householdId);
      const b = hh.get(next.householdId);
      if (!a || !b) return null;
      const t = travelMinutes(a.at, b.at);
      const end = (v.start % 1440) + v.minutes;
      return <span key={`t-${v.id}`} className="travel" style={{ left: pct(end), width: `${(t / SPAN) * 100}%` }} title={`${t} min to ${b.name}`} />;
    });
  };

  const row = (m: Member & { bookedMinutes: number }) => {
    const mine = dayVisits.filter((v) => v.memberIds.includes(m.id));
    const works = m.availability.find((w) => w.day === day);
    const isOut = absent.has(m.id);
    return (
      <div className={`tl-row${isOut ? " out" : ""}`} key={m.id} data-member={m.id}>
        <div className="tl-name">
          <b>{m.name}</b>
          <small>{isOut ? "out today" : works ? `${clock(works.from)}–${clock(works.to)} · ${(m.bookedMinutes / 60).toFixed(1)}/${m.weeklyHoursCap} h` : "not working"} · {m.languages.join(", ")}</small>
        </div>
        <div className="tl-track" style={works ? undefined : { background: "var(--wash)" }}>
          {travelTails(mine)}
          {mine.map((v) => renderBar(v, "real"))}
          {ghostFor(m.id).map((v) => renderBar(v, "ghost"))}
          {pendingFor(m.id).map((v) => renderBar(v, "ghost"))}
          {showNow && <span className="tl-now" style={{ left: pct(now % 1440) }} />}
        </div>
      </div>
    );
  };

  return (
    <div className="tl" role="region" aria-label="Day board">
      <div className="tl-hours" aria-hidden="true">
        {Array.from({ length: 13 }, (_, i) => (
          <span key={i} style={{ left: `${(i / 12) * 100}%` }}>{String(7 + i).padStart(2, "0")}:00</span>
        ))}
        {showNow && <span className="tl-now" data-label={`now ${clock(now)}`} style={{ left: pct(now % 1440), top: "1.4rem", bottom: "auto", height: 0 }} />}
      </div>
      {orphans.length > 0 && (
        <div className="tl-row out" data-member="none">
          <div className="tl-name"><b>Needs cover</b><small>{orphans.length} visit{orphans.length > 1 ? "s" : ""}</small></div>
          <div className="tl-track">{orphans.map((v) => renderBar(v, "orphan"))}</div>
        </div>
      )}
      {board.members.map(row)}
    </div>
  );
}
