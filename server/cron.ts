// Render cron job (every 5 minutes): asks the workflow to sweep for visits whose hold is due.
import { Render } from "@renderinc/sdk";
import { config, loadEnv } from "./context.ts";

loadEnv();
const cfg = config();
if (!cfg.renderApiKey) throw new Error("RENDER_API_KEY is not set");
const run = await new Render({ token: cfg.renderApiKey }).workflows.startTask(`${cfg.workflowSlug}/sweep`, []);
console.log(`sweep started: ${run.taskRunId}`);
