// The coordinator approves a proposal: the bars move, a same-cleaner household is asked, an uncovered
// visit releases its hold, and the messages go out.
import { move, noCover, type Ctx } from "../actions.ts";
import { getDisruption, type Proposal } from "./agent.ts";

export async function approve(c: Ctx, disruptionId: string, actor = "dana"): Promise<{ moved: string[]; asked: string[]; released: string[] }> {
  const d = await getDisruption(c.store, disruptionId);
  if (!d?.proposal) throw new Error("nothing to approve");
  if (d.status === "approved") return { moved: [], asked: [], released: [] };
  const p: Proposal = d.proposal;
  const moved: string[] = [];
  const asked: string[] = [];
  const released: string[] = [];
  for (const a of p.plan.assignments) {
    if (a.memberId) {
      const r = await move(c, a.visitId, a.memberId, actor);
      (r.pendingConsent ? asked : moved).push(a.visitId);
    } else {
      await noCover(c, a.visitId, actor);
      released.push(a.visitId);
    }
  }
  for (const m of p.messages) await c.store.event("message.sent", null, actor, { ...m, disruptionId });
  await c.store.db.query("update disruptions set status = 'approved' where id = $1", [disruptionId]);
  await c.store.event("disruption.approved", null, actor, { id: disruptionId, moved, asked, released });
  return { moved, asked, released };
}
