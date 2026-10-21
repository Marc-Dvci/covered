// The demo story through the real UI, plus an axe-core scan of every screen it visits.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const report: { page: string; violations: { id: string; impact: string | null; nodes: number; targets: string[] }[] }[] = [];

async function axe(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(async () => (await (window as unknown as { axe: { run: (o: unknown) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[]; failureSummary?: string }[] }[] }> } }).axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })));
  const violations = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`.slice(0, 300)) }));
  report.push({ page: name, violations });
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical"), `${name}: ${JSON.stringify(violations)}`).toEqual([]);
}

const api = (page: Page, path: string, body: unknown = {}) =>
  page.evaluate(async ([p, b]) => (await fetch(p as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json(), [path, body] as const);
const clock = (page: Page, hhmm: string) => api(page, "/api/clock", { at: 3 * 1440 + Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) });

test.afterAll(() => writeFileSync("docs/axe-report.json", JSON.stringify(report, null, 1)));

test("Thursday: Sam is out, the board is covered, everyone is paid", async ({ page }) => {
  await page.goto("/");
  await api(page, "/api/demo/reset");
  await axe(page, "home");

  await page.goto("/board");
  await expect(page.locator('[data-visit="v-thu-okafor"][data-kind="real"]')).toContainText("$157.50 held");
  await axe(page, "board");
  await page.getByRole("button", { name: "Send as member" }).click();
  await page.getByRole("button", { name: "Find cover" }).click();
  await expect(page.getByRole("heading", { name: "Proposal: 3 of 3 covered" })).toBeVisible();
  await expect(page.locator('[data-member="marek"] [data-kind="ghost"]')).toHaveCount(1);
  await expect(page.locator('[data-member="teresa"] [data-kind="ghost"]')).toHaveCount(2);
  await axe(page, "board-proposal");
  await page.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.locator('[data-member="teresa"] [data-visit="v-thu-santos"][data-kind="real"]')).toBeVisible();

  await page.goto("/h/okafor");
  await axe(page, "household-ask");
  await page.getByRole("button", { name: "Yes, that's fine" }).click();
  await expect(page.getByText("Marek Nowak")).toBeVisible();

  await clock(page, "09:00");
  await page.goto("/m/marek");
  await page.locator('[data-visit="v-thu-okafor"]').getByRole("button", { name: "Rozpocznij" }).click();
  await clock(page, "13:05");
  await page.locator('[data-visit="v-thu-okafor"]').getByRole("button", { name: "Zakończ" }).click();
  await expect(page.locator('[data-visit="v-thu-okafor"]')).toContainText("$133.00");
  await expect(page.locator('[data-visit="v-thu-okafor"]')).toContainText("Zapłacone", { timeout: 20_000 });
  await axe(page, "member-phone");

  await clock(page, "13:30");
  await page.goto("/h/lindqvist");
  await page.locator('[data-visit="v-thu-lindqvist"]').getByRole("button", { name: "Cancel…" }).click();
  await expect(page.getByText("$35.00")).toBeVisible();
  await page.getByRole("button", { name: "Cancel the visit" }).click();
  await expect(page.getByText(/late-cancel fee/)).toBeVisible({ timeout: 20_000 });

  await page.goto("/m/marek/statement");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await axe(page, "statement");
  await page.getByRole("button", { name: "Make a link for a landlord" }).click();
  const href = await page.locator("a[href*='/s/']").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Marek Nowak" })).toBeVisible();
  await expect(page.getByText("The Okafors")).toHaveCount(0);
  await axe(page, "landlord");

  // the Okafors dispute the charge: the coordinator opens the evidence from the visit
  await page.goto("/board");
  await page.locator('[data-visit="v-thu-okafor"][data-kind="real"]').click();
  await page.getByRole("link", { name: "Evidence if the household disputes" }).click();
  await expect(page.getByRole("heading", { name: "Evidence for a dispute: The Okafors" })).toBeVisible();
  await expect(page.getByText("Member checked in at the door")).toBeVisible();
  await expect(page.locator("td", { hasText: /^capture$/ })).toHaveCount(1);
  await axe(page, "evidence");
});

test("the demo inputs draft from the recorded answer and can be signed", async ({ page }) => {
  await page.goto("/join");
  await page.getByRole("button", { name: "Draft the agreement" }).click();
  await expect(page.getByText("drafted (recorded)")).toBeVisible();
  await expect(page.getByText("Português", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and save PayPal" })).toBeEnabled();
});

test("a new household signs without a model and lands on the board", async ({ page }) => {
  await page.goto("/join");
  await page.getByLabel("Name").fill("The Abernathys");
  await page.getByLabel("The job, in their words").fill("A small flat, floors and bathroom.");
  await page.getByRole("button", { name: "Draft the agreement" }).click();
  await expect(page.getByRole("heading", { name: "Fill in by hand" })).toBeVisible();
  await axe(page, "join");
  await page.getByLabel("Work on each visit").fill("kitchen; bathrooms; floors");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("button", { name: "Sign and save PayPal" }).click();
  await page.waitForURL(/\/h\/abernathys/);
  await expect(page.getByText("Agreement signed and PayPal saved")).toBeVisible();
});

test("the about page shows the evaluation", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByText("55 / 55")).toBeVisible();
  await axe(page, "about");
});
