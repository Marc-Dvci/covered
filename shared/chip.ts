// The one line of text on a visit's bar: where its money is right now.
import { clock, dollars, type VisitState } from "./domain.ts";

export interface ChipVisit {
  state: VisitState;
  priceCents: number;
  hold: { cents: number; placedAt: number } | null;
  capture: { cents: number } | null;
  payout: { items: { cents: number }[] } | null;
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function chipText(v: ChipVisit): string {
  if (v.state === "paid_out" && v.payout) return `paid ${dollars(v.payout.items.reduce((a, i) => a + i.cents, 0))}`;
  if (v.state === "late_cancel" && v.capture) return `fee ${dollars(v.capture.cents)}`;
  if (v.state === "captured" && v.capture) return `captured ${dollars(v.capture.cents)}`;
  if (v.state === "in_progress") return v.hold ? `${dollars(v.hold.cents)} held, in progress` : "in progress";
  if (v.hold && ["held", "settling"].includes(v.state)) return `${dollars(v.hold.cents)} held since ${WEEKDAY[Math.floor(v.hold.placedAt / 1440)] ?? ""} ${clock(v.hold.placedAt)}`;
  if (v.state === "at_risk") return "hold refused";
  if (v.state === "holding") return "placing hold";
  if (v.state === "voided") return "hold released";
  if (v.state === "cancelled") return "cancelled";
  if (v.state === "done") return "before the demo week";
  return `${dollars(v.priceCents)}, held 24 h before`;
}
