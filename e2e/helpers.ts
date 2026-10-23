// Shared spec helpers. Credentials come from E2E_DIR/creds.json, written by
// e2e/serve.mjs; never print them.
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

export type Role = "admin" | "judge" | "companyA" | "companyB";
export interface Account {
  role: "admin" | "judge" | "company";
  email: string;
  password: string;
  grant?: string;
}

export const credsPath = () => path.join(process.env.E2E_DIR ?? "", "creds.json");

export function readCreds(): Record<Role, Account> {
  return JSON.parse(fs.readFileSync(credsPath(), "utf8"));
}

export const CREDENTIAL_FAILURE = "Email or password is incorrect. Check both and try again.";

/** Fills and submits the sign-in form; returns the sign-in API status once the page has moved on or shows its alert. */
export async function submitSignIn(page: Page, email: string, password: string, next?: string) {
  await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/sign-in/email");
  await page.getByRole("button", { name: "Sign in" }).click();
  const status = (await response).status();
  if (status === 200) await page.waitForURL((u) => u.pathname !== "/sign-in");
  else await expect(page.getByRole("alert")).toBeVisible();
  return status;
}

/**
 * Signs a seeded role in through the real form and waits for the landing page.
 * better-auth rate-limits sign-in per client; on its notice this waits out the
 * window once instead of loosening the limit.
 */
export async function signIn(page: Page, role: Role, next = "/") {
  const { email, password } = readCreds()[role];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await submitSignIn(page, email, password, next)) !== 429) break;
    await page.waitForTimeout(11_000);
  }
  await expect(page).toHaveURL((u) => u.pathname === next);
}

/** Signs a role in through the auth API on the given request context (its cookie jar keeps the session). */
export async function signInByApi(request: APIRequestContext, role: Role, baseURL: string) {
  const { email, password } = readCreds()[role];
  const post = () =>
    request.post("/api/auth/sign-in/email", { data: { email, password }, headers: { origin: baseURL } });
  let res = await post();
  if (res.status() === 429) {
    const wait = Math.min(Number(res.headers()["x-retry-after"]) || 10, 30);
    await new Promise((r) => setTimeout(r, wait * 1000 + 250));
    res = await post();
  }
  expect(res.status()).toBe(200);
  return res;
}
