// APP-02 / SC2: an admin submits an own-list URL and watches the fixture run
// (PRISM_LIVE_RUNNER=fixture: no network, no model call) reach Done; an off-list
// URL is refused with nothing fetched; other roles get the 403 page.
import { expect, test } from "@playwright/test";
import { stateFor } from "./helpers.ts";

test.describe("admin", () => {
  test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

  test("submits https://p01.example/, watches the stages reach Done and opens the report", async ({ page }) => {
    await page.goto("/run");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run PRISM on one URL");
    await page.getByLabel("Project URL").fill("https://p01.example/");
    await page.getByRole("button", { name: "Run PRISM on this URL" }).click();
    await page.waitForURL(/\/run\/\d+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live run: p01.example");
    const items = page.locator("[data-stage-list] > li");
    await expect(items).toHaveCount(7);
    await expect(items.locator("span.font-semibold")).toHaveText([
      "Queued",
      "Screen",
      "Collect (robots.txt first)",
      "Code",
      "Gate",
      "Confirm positives",
      "Build report",
    ]);
    await expect(page.locator('[data-stage-list] > li[data-status="done"]')).toHaveCount(7, { timeout: 20_000 });
    await expect(page.locator("[data-end-state=done]")).toContainText("Report ready.");
    const open = page.getByRole("link", { name: "Open the report" });
    await expect(open).toHaveAttribute("href", "/p/P01");
    await open.click();
    await page.waitForURL((u) => u.pathname === "/p/P01");
    await expect(page.locator("[data-notice=fixture]")).toBeVisible();
    await page.goto("/run");
    await expect(page.locator("[data-run]").first()).toContainText("p01.example");
  });

  test("an off-list URL is refused above the form with the URL kept and no job created", async ({ page }) => {
    await page.goto("/run");
    const before = await page.locator("[data-run]").count();
    const field = page.getByLabel("Project URL");
    await field.fill("https://not-listed.example/");
    await page.getByRole("button", { name: "Run PRISM on this URL" }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toHaveText("Not run: this URL is not on the own or opt-in list. Nothing was fetched.");
    await expect(notice).toBeFocused();
    await expect(field).toHaveValue("https://not-listed.example/");
    expect(new URL(page.url()).pathname).toBe("/run");
    await page.reload();
    await expect(page.locator("[data-run]")).toHaveCount(before);
  });
});

for (const role of ["judge", "companyA"] as const) {
  test.describe(role, () => {
    test.use({ storageState: ({}, use) => stateFor(role).then(use) });
    test("gets the 403 page on /run and /run/1", async ({ page }) => {
      for (const path of ["/run", "/run/1"]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(403);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
      }
    });
  });
}
