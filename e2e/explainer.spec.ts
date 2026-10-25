// J6: the first-visit explainer on the home page. Server-rendered (shown without
// JavaScript), dismissed by a labelled button, remembered in localStorage.
import { expect, test } from "@playwright/test";
import { app, stateFor } from "./helpers.ts";

test.use({ storageState: ({}, use) => stateFor("admin").then(use) });

test("shown on first visit; the labelled close button dismisses it from the keyboard; it stays dismissed", async ({ page }) => {
  await page.goto(app("/"));
  const box = page.locator("[data-explainer]");
  await expect(box).toBeVisible();
  await expect(box).toContainText("a checklist for users, a tour guide for builders and a benchmark for investors");
  for (const words of ["Publicly evidenced", "Not publicly evidenced", "Required check not met on own pages"]) {
    await expect(box.locator("dt", { hasText: words }).first()).toBeVisible();
  }
  await expect(box.getByRole("link", { name: "start a live run on one URL" })).toHaveAttribute("href", app("/run"));
  const close = page.getByRole("button", { name: "Dismiss the introduction" });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(box).toHaveCount(0);
  await expect(page.locator("#projects-heading")).toBeFocused();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Your projects" })).toBeVisible();
  await expect(page.locator("[data-explainer]")).toHaveCount(0);
});

test("renders without JavaScript, from the server alone", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: await stateFor("admin") });
  const page = await ctx.newPage();
  await page.goto(app("/"));
  await expect(page.locator("[data-explainer]")).toBeVisible();
  await ctx.close();
});

test("a page whose storage throws still renders the explainer and the list", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app("/"));
  await expect(page.locator("[data-explainer]")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss the introduction" }).click();
  await expect(page.locator("[data-explainer]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Your projects" })).toBeVisible();
  expect(errors).toEqual([]);
});
