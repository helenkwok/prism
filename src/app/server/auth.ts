// The better-auth instance. Nothing here runs at import time: `vite build`
// needs no secret and opens no database. getAuth() checks the secret on first use.
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getDb } from "./db.ts";

export const MIN_SECRET_LENGTH = 32;

function requireSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

/** Comma-separated TRUSTED_ORIGINS, split and trimmed; defaults to the base URL. */
export function parseOrigins(value: string | undefined, fallback: string): string[] {
  return (value && value.trim() !== "" ? value : fallback)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Built on demand (not a module constant) because the database and the secret
 * are runtime facts. Used by getAuth() and by the migration step, so both see
 * the same plugins and therefore the same columns.
 */
export function authOptions() {
  const baseURL = process.env.BETTER_AUTH_URL || "http://localhost:3000";
  return {
    // { db, type }: a bare Kysely instance silently attaches no database.
    database: { db: getDb(), type: "sqlite" },
    emailAndPassword: {
      enabled: true,
      // No public sign-up: the seed script is the only account-creation path.
      disableSignUp: true,
    },
    // Default admin roles; the judge and company roles are Phase 7 work.
    // tanstackStartCookies must stay the LAST plugin.
    plugins: [admin(), tanstackStartCookies()],
    secret: requireSecret(),
    baseURL,
    trustedOrigins: parseOrigins(process.env.TRUSTED_ORIGINS, baseURL),
  } satisfies BetterAuthOptions;
}

let authInstance: ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>> | undefined;

export function getAuth() {
  authInstance ??= betterAuth(authOptions());
  return authInstance;
}
