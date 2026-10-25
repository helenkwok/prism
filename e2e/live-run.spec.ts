// APP-02 / SC2: an admin submits an own-list URL and watches the fixture run
// (PRISM_LIVE_RUNNER=fixture: no network, no model call) reach Done; an off-list
// URL is refused with nothing fetched; other roles get the 403 page.
import { expect, test } from "@playwright/test";
import { app, inApp, stateFor } from "./helpers.ts";

test.describe("admin", () => {
  test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

  test("submits https://p01.example/, watches the stages reach Done and opens the report", async ({ page }) => {
    await page.goto(app("/run"));
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
    await expect(open).toHaveAttribute("href", app("/p/P01"));
    await open.click();
    await page.waitForURL((u) => inApp(u) === "/p/P01");
    await expect(page.locator("[data-notice=fixture]")).toBeVisible();
    await page.goto(app("/run"));
    await expect(page.locator("[data-run]").first()).toContainText("p01.example");
  });

  test("an off-list URL is refused above the form with the URL kept and no job created", async ({ page }) => {
    await page.goto(app("/run"));
    // The fixture runner spends nothing, so the $1.00 cap from e2e/serve.mjs is untouched.
    await expect(page.locator("[data-budget]")).toHaveText("Live-run budget: $0.00 of $1.00 spent");
    await expect(page.locator("[data-budget] meter")).toHaveAttribute("max", "1");
    await expect(page.getByRole("button", { name: "Run PRISM on this URL" })).toBeEnabled();
    const before = await page.locator("[data-run]").count();
    const field = page.getByLabel("Project URL");
    await field.fill("https://not-listed.example/");
    await page.getByRole("button", { name: "Run PRISM on this URL" }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toHaveText("Not run: this URL is not on the own or opt-in list. Nothing was fetched.");
    await expect(notice).toBeFocused();
    await expect(field).toHaveValue("https://not-listed.example/");
    expect(inApp(page.url())).toBe("/run");
    await page.reload();
    await expect(page.locator("[data-run]")).toHaveCount(before);
  });

  test("shows what is left on PRISM's demo budget and names the limit, its reset and the way round it", async ({ page }) => {
    // e2e/serve.mjs: a fake PRISM Tavily key (the fixture runner never calls Tavily) and 2 Tavily runs per session.
    await page.goto(app("/run"));
    await expect(page.locator("[data-demo-model]")).toContainText(/\d of 5 model runs left today on PRISM's demo budget\./);
    await expect(page.locator("[data-demo-tavily]")).toHaveText("2 of 2 Tavily runs left today on PRISM's demo budget (90 of 90 Tavily credits left; up to 10 per run).");
    for (let i = 0; i < 2; i++) {
      await page.getByLabel("Project URL").fill("https://p01.example/");
      await page.getByLabel("Evidence collector").selectOption("tavily");
      await page.getByRole("button", { name: "Run PRISM on this URL" }).click();
      await page.waitForURL(/\/run\/\d+$/);
      await expect(page.locator("[data-end-state=done]")).toBeVisible({ timeout: 20_000 });
      await page.goto(app("/run"));
    }
    await expect(page.locator("[data-demo-tavily]")).toContainText("0 of 2 Tavily runs left today on PRISM's demo budget; the next one frees up");
    await page.getByLabel("Project URL").fill("https://p01.example/");
    await page.getByLabel("Evidence collector").selectOption("tavily");
    await page.getByRole("button", { name: "Run PRISM on this URL" }).click();
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("Not run: this session has used all 2 Tavily runs on PRISM's demo budget in the last 24 hours. The next one frees up");
    await expect(notice).toContainText("Use your own Tavily key, or the own-site collector, or read the recorded reports.");
    await expect(notice.getByRole("link", { name: "Read the recorded reports" })).toHaveAttribute("href", app("/"));
    expect(inApp(page.url())).toBe("/run");
  });
});

for (const role of ["judge", "companyA"] as const) {
  test.describe(role, () => {
    test.use({ storageState: ({}, use) => stateFor(role).then(use) });
    test("gets the 403 page on /run and /run/1", async ({ page }) => {
      for (const path of ["/run", "/run/1"]) {
        const res = await page.goto(app(path));
        expect(res?.status(), path).toBe(403);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
      }
    });
  });
}
