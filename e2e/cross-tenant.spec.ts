// APP-01 / SC1: a company opens its own report and is refused every other
// record with the same 403, whether the record exists or not.
import { expect, test } from "@playwright/test";
import { readCreds, stateFor } from "./helpers.ts";

const own = () => readCreds().companyA.grant!;
const other = () => readCreds().companyB.grant!;

test.describe("company A", () => {
  test.use({ storageState: ({}, use) => stateFor("companyA").then(use) });

  test("opens its own report: 200, title, disclaimer, five decisions, checks", async ({ page }) => {
    const res = await page.goto(`/p/${own()}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notewell");
    await expect(page.locator("[data-scope-disclaimer]")).toContainText("This is not a certification or a legal assessment.");
    await expect(page.getByRole("heading", { level: 2, name: "Decisions" })).toBeVisible();
    await expect(page.locator("[data-verdict-row]")).toHaveCount(5);
    await expect(page.getByRole("heading", { level: 2, name: "Checks" })).toBeVisible();
  });

  test("gets 403 and the 403 page on company B's report", async ({ page }) => {
    const res = await page.goto(`/p/${other()}`);
    expect(res?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
    await expect(page.locator("[data-report]")).toHaveCount(0);
  });

  test("gets the identical 403 on a project id that does not exist", async ({ page }) => {
    const b = await page.goto(`/p/${other()}`);
    const bMain = await page.locator("main").innerHTML();
    const res = await page.goto("/p/NOPE");
    expect(res?.status()).toBe(403);
    expect(b?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not available to your account");
    expect(await page.locator("main").innerHTML()).toBe(bMain);
  });
});

test("no session: the report redirects to sign-in with next", async ({ page }) => {
  await page.goto(`/p/${own()}`);
  await expect(page).toHaveURL((u) => u.pathname === "/sign-in" && u.search === `?next=%2Fp%2F${own()}`);
});
