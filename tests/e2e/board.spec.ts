// The Bryntum board's own behaviour in a real browser: the drag guard, the views, and what the board refuses to do.
import { expect, test, type Page } from "@playwright/test";

const bar = (page: Page, visit: string) => page.locator(`.b-sch-event-wrap[data-event-id="${visit}"]`);
const row = (page: Page, member: string) => page.locator(`.b-timeline-sub-grid .b-grid-row[data-id="${member}"]`);

async function dragTo(page: Page, visit: string, member: string, hold?: () => Promise<void>) {
  const from = (await bar(page, visit).boundingBox())!;
  const to = (await row(page, member).boundingBox())!;
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x, to.y + to.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  await hold?.();
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => fetch("/api/demo/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  const guards = page.waitForResponse((r) => r.url().includes("/api/board/guards"));
  await page.goto("/board");
  await expect(bar(page, "v-thu-okafor")).toContainText("held");
  await guards;
});

test("shades each member's non-working time on their own row", async ({ page }) => {
  await expect(page.locator(".b-sch-resource-non-working-time").first()).toBeAttached();
});

test("refuses a drag to a member who cannot take the visit, says why, and the bar stays", async ({ page }) => {
  await dragTo(page, "v-thu-okafor", "joy", async () => {
    await expect(page.locator(".b-tooltip").filter({ hasText: "does not work that day" }).first()).toBeVisible();
  });
  await page.waitForTimeout(800);
  await expect(page.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"][data-resource-id="sam"]')).toBeVisible();
  await expect(page.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"][data-resource-id="joy"]')).toHaveCount(0);
});

test("a same-cleaner household is asked first: the drop leaves the bar and adds a dashed one", async ({ page }) => {
  await dragTo(page, "v-thu-okafor", "marek");
  await expect(page.locator(".toast")).toContainText("asked first");
  await expect(page.locator('.bar-proposed[data-event-id^="proposed-v-thu-okafor"][data-resource-id="marek"]')).toBeVisible();
  await expect(page.locator('.b-sch-event-wrap[data-event-id="v-thu-okafor"][data-resource-id="sam"]')).toBeVisible();
});

test("a valid drag moves the visit on the server and keeps its hold", async ({ page }) => {
  await dragTo(page, "v-thu-weber", "ines");
  await expect(page.locator(".toast")).toContainText("The hold stays with the visit");
  await expect(page.locator('.b-sch-event-wrap[data-event-id="v-thu-weber"][data-resource-id="ines"]')).toBeVisible();
  const v = (await page.evaluate(() => fetch("/api/visits/v-thu-weber").then((r) => r.json()))) as { visit: { memberIds: string[]; hold: { cents: number } } };
  expect(v.visit.memberIds).toEqual(["ines"]);
  expect(v.visit.hold.cents).toBe(12250);
});

test("a click opens the visit's panel with its PayPal authorization", async ({ page }) => {
  await bar(page, "v-thu-okafor").click();
  await expect(page.locator('section[aria-label="Visit"]')).toContainText("Authorization");
});

test("the week view shows six working days on one axis", async ({ page }) => {
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".b-sch-header-text").filter({ hasText: /Mon 16 Nov/ })).toBeVisible();
  await expect(page.locator(".b-sch-header-text").filter({ hasText: /Sat 21 Nov/ })).toBeVisible();
  await expect(bar(page, "v-thu-okafor")).toBeVisible();
});

test("a finished day's bars cannot be picked up, and a double click creates nothing", async ({ page }) => {
  await page.getByRole("button", { name: /Mon, Nov 16/ }).click();
  await expect(page.locator(".b-sch-event-wrap").first()).toBeVisible();
  const count = await page.locator(".b-sch-event-wrap").count();
  const first = page.locator(".b-sch-event-wrap").first();
  const id = await first.getAttribute("data-event-id");
  const before = await first.getAttribute("data-resource-id");
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 130, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(page.locator(`.b-sch-event-wrap[data-event-id="${id}"]`).first()).toHaveAttribute("data-resource-id", before!);
  const empty = (await page.locator(".b-timeline-sub-grid").boundingBox())!;
  await page.mouse.dblclick(empty.x + empty.width - 12, empty.y + empty.height - 12);
  await page.waitForTimeout(300);
  await expect(page.locator(".b-sch-event-wrap")).toHaveCount(count);
});
