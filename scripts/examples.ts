// Saves what the live demo produced into examples/, so a reader can open it without running anything. Run it right
// after scripts/walk.ts, while that run's week is still on the site.
//   LIVE_URL=https://covered-coop.pages.dev npx tsx scripts/examples.ts
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.LIVE_URL ?? "http://localhost:8787";
const get = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
};
const save = (name: string, data: unknown) => writeFileSync(`examples/${name}`, `${JSON.stringify(data, null, 1)}\n`);

mkdirSync("examples", { recursive: true });
save("income-statement-marek.json", await get("/api/members/marek/statement"));
const { token } = (await get("/api/members/marek/share", { method: "POST" })) as { token: string };
save("landlord-link-marek.json", await get(`/api/share/${token}`));
save("dispute-evidence-okafors.json", await get("/api/visits/v-thu-okafor/evidence"));
save("late-cancel-lindqvist.json", (await get("/api/visits/v-thu-lindqvist")).money);
console.log("saved examples");
