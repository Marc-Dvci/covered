import { defineConfig } from "vitest/config";

// The decision core: every amount, every fee, who can cover, what a visit may do next. PayPal's and the model's
// clients are exercised live and recorded in docs/EVIDENCE.md, so they are left out of this figure.
const DECISION_CORE = [
  "shared/rules/settle.ts",
  "shared/agreement.ts",
  "shared/chip.ts",
  "shared/guide.ts",
  "shared/travel.ts",
  "server/dispatch/solver.ts",
  "server/tasks.ts",
  "server/actions.ts",
  "server/crud.ts",
  "server/core.ts",
  "server/runner.ts",
];

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      include: DECISION_CORE,
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90, branches: 80, functions: 90 },
    },
  },
});
