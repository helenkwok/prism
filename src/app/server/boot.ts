// Nitro server plugin: runs once when the built server starts, never during
// `vite build`. A mis-configured deployment exits here instead of serving requests.
import { getAuth } from "./auth.ts";
import { ensureSchema, resolveDataDir } from "./db.ts";

function refuse(check: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  // The message names the failed setting, never a secret value.
  console.error(`[prism] refusing to start: ${check} failed: ${message}`);
  process.exit(1);
}

export default async function boot(): Promise<void> {
  try {
    resolveDataDir(); // PRISM_DATA_DIR is absolute and outside the repo (D-22)
  } catch (err) {
    refuse("data directory check", err);
  }
  try {
    getAuth(); // throws without a BETTER_AUTH_SECRET of at least 32 characters
  } catch (err) {
    refuse("auth secret check", err);
  }
  try {
    await ensureSchema();
  } catch (err) {
    refuse("database migration", err);
  }
}
