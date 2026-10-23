// APP-01 / SC1: sign-in through the real form, and no public sign-up.
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { credsPath, readCreds, signIn } from "./helpers.ts";

test("harness keeps the seeded credentials in a mode-600 file", () => {
  expect(fs.statSync(credsPath()).mode & 0o777).toBe(0o600);
  expect(fs.statSync(process.env.E2E_DIR ?? "").mode & 0o777).toBe(0o700);
});

test("admin signs in through the form and lands on / with the email shown", async ({ page }) => {
  await signIn(page, "admin");
  await expect(page).toHaveURL((u) => u.pathname === "/");
  await expect(page.getByText(readCreds().admin.email)).toBeVisible();
});
