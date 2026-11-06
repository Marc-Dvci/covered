// The CI run page as a report: tests by kind, coverage of the decision core per module, and the evaluation scores.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import dev from "../eval/disruptions/results.json" with { type: "json" };
import held from "../eval/heldout/results.json" with { type: "json" };
import table from "../shared/rules/cases.json" with { type: "json" };

interface Metric {
  pct: number;
}
type Coverage = Record<string, { lines: Metric; branches: Metric; functions: Metric }>;
interface Results {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: { name: string; assertionResults: unknown[] }[];
}

const out: string[] = ["### Tests", ""];
if (existsSync("test-results.json")) {
  const r = JSON.parse(readFileSync("test-results.json", "utf8")) as Results;
  out.push(`${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, in random order.`, "", "| File | Tests |", "|---|---|");
  for (const f of r.testResults.sort((a, b) => a.name.localeCompare(b.name))) out.push(`| ${basename(f.name)} | ${f.assertionResults.length} |`);
  out.push("");
}
if (existsSync("coverage/coverage-summary.json")) {
  const c = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")) as Coverage;
  out.push("### Coverage of the decision core", "", "| Module | Lines | Branches |", "|---|---|---|");
  for (const [file, m] of Object.entries(c)) {
    const name = file === "total" ? "**Decision core**" : file.replace(/^.*?covered[\\/]/, "").replace(/\\/g, "/");
    out.push(`| ${name} | ${m.lines.pct}% | ${m.branches.pct}% |`);
  }
  out.push("");
}
out.push(
  "### Evaluation",
  "",
  "| Set | Visits placed | Rules broken by the solver | Baseline placements breaking a rule |",
  "|---|---|---|---|",
  `| Development (60 scenarios) | ${dev.solverCovered} / ${dev.oracleMaxCovered} | ${dev.solverConstraintViolations} | ${dev.baselineVisitsBreakingARule} |`,
  `| Held-out (20 scenarios) | ${held.solverCovered} / ${held.oracleMaxCovered} | ${held.solverConstraintViolations} | ${held.baselineVisitsBreakingARule} |`,
  "",
  `Pay rules: ${table.cases.length} cases worked out by hand, checked by the tests above.`,
);
console.log(out.join("\n"));
