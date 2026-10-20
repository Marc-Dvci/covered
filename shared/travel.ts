// Travel time between two homes: straight-line distance times a street-grid detour factor at city
// driving speed, plus parking, rounded up to 5 minutes. Deterministic, so the board, the solver and
// the evaluation all agree on the same buffers.
import type { Point } from "./domain.ts";

const DETOUR = 1.35;
const KMH = 22;
const PARKING_MIN = 8;

export function km(a: Point, b: Point): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function travelMinutes(a: Point, b: Point): number {
  const d = km(a, b);
  if (d < 0.05) return 0;
  return Math.ceil(((d * DETOUR * 60) / KMH + PARKING_MIN) / 5) * 5;
}
