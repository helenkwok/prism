// APP-01 / SC1: sign-in through the real form, and no public sign-up.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { app, CREDENTIAL_FAILURE, credsPath, inApp, readCreds, signIn, submitSignIn } from "./helpers.ts";
import type { Role } from "./helpers.ts";

test("harness keeps the seeded credentials in a mode-600 file", () => {
  expect(fs.statSync(credsPath()).mode & 0o777).toBe(0o600);
  expect(fs.statSync(process.env.E2E_DIR ?? "").mode & 0o777).toBe(0o700);
});

for (const role of ["admin", "judge", "companyA", "companyB"] as Role[]) {
  test(`${role} signs in through the form and lands on / with the email shown`, async ({ page }) => {
    await signIn(page, role);
    await expect(page).toHaveURL((u) => inApp(u) === "/");
    await expect(page.getByText(readCreds()[role].email)).toBeVisible();
  });
}

test("sign-in page offers no sign-up, and the sign-up API refuses", async ({ page, request, baseURL }) => {
  await page.goto(app("/sign-in"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to PRISM");
  await expect(page.getByRole("link", { name: /sign.?up|register|create.+account/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign.?up|register|create.+account/i })).toHaveCount(0);
  await expect(page.locator('a[href*="sign-up"], form[action*="sign-up"]')).toHaveCount(0);

  const res = await request.post(app("/api/auth/sign-up/email"), {
    headers: { origin: baseURL ?? "" },
    data: { email: `x-${randomBytes(4).toString("hex")}@e2e.example`, password: randomBytes(12).toString("hex"), name: "x" },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
});

test("a wrong password shows the fixed message, never the server's", async ({ page }) => {
  const { email, password } = readCreds().judge;
  let status = await submitSignIn(page, email, `${password}-wrong`);
  // The sign-in rate limit shares one bucket here; wait it out once.
  if (status === 429) {
    await page.waitForTimeout(11_000);
    status = await submitSignIn(page, email, `${password}-wrong`);
  }
  expect(status).toBe(401);
  await expect(page.getByRole("alert")).toHaveText(CREDENTIAL_FAILURE);
  await expect(page).toHaveURL((u) => inApp(u) === "/sign-in");
  const html = await page.content();
  expect(html).not.toContain("INVALID_EMAIL_OR_PASSWORD");
  expect(html).not.toMatch(/invalid email or password/i);
});

test("an anonymous visit to / ends on /sign-in", async ({ page }) => {
  await page.goto(app("/"));
  await expect(page).toHaveURL((u) => inApp(u) === "/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to PRISM");
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });
  test("/sign-in shows the noscript line", async ({ page }) => {
    await page.goto(app("/sign-in"));
    // Playwright's text engine skips <noscript> content, so locate the rendered element itself.
    const line = page.locator("noscript p");
    await expect(line).toBeVisible();
    await expect(line).toHaveText("Signing in needs JavaScript. Turn it on for this site and reload the page.");
  });
});
