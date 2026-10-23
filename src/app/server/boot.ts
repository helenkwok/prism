// Start-up checks, run once by the server entry (src/app/server.ts) when the built
// server starts, never during `rsbuild build`. A mis-configured deployment exits
// here instead of serving requests.
import { getAuth } from "./auth.ts";
import { ensureAccessSchema } from "./access-store.ts";
import { ensureSchema, getDb, resolveDataDir } from "./db.ts";
import { ensureReportViewSchema } from "../../report/store.ts";
import { ensureLiveRunSchema, markInterruptedJobs, runnerFromEnv } from "./live-run.ts";

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
  try {
    await ensureAccessSchema(getDb());
  } catch (err) {
    refuse("access tables", err);
  }
  try {
    // The project list reads this table even before any view is materialised.
    await ensureReportViewSchema(getDb());
  } catch (err) {
    refuse("report view table", err);
  }
  try {
    await ensureLiveRunSchema(getDb());
    // Pattern 6 boot rule: a run cut off by a restart is interrupted and its $0.10 charged.
    const n = await markInterruptedJobs(getDb());
    if (n > 0) console.log(`[prism] live run: ${n} unfinished run(s) marked interrupted; their reservations were charged as spent`);
  } catch (err) {
    refuse("live-run tables", err);
  }
  // T-07-36: a fixture runner left on in production is visible in the log.
  if (runnerFromEnv().name === "fixture") {
    console.log("[prism] live run: fixture runner active (no network, no model calls, reports flagged fixture)");
  }
}
