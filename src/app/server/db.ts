// The one private database: better-sqlite3 wrapped in Kysely, stored in
// PRISM_DATA_DIR/prism.sqlite. The data directory is checked against the repo
// root on first use (D-22), so a mis-set variable can never put data in git.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { getMigrations } from "better-auth/db/migration";
import {
  assertOutsideRepo,
  resolvePrivateDir,
  resolveRepoRoot,
} from "../../../scripts/check-data-dir.mjs";

let dbInstance: Kysely<any> | undefined;

/** Resolve and verify the private data directory. Throws a coded error when it is unsafe. */
export function resolveDataDir(): string {
  const root = resolveRepoRoot(process.cwd());
  const dir = resolvePrivateDir(process.env, root);
  return assertOutsideRepo(dir, root);
}

export function getDb(): Kysely<any> {
  if (dbInstance) return dbInstance;
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(path.join(dir, "prism.sqlite"));
  sqlite.pragma("journal_mode = WAL");
  dbInstance = new Kysely<any>({ dialect: new SqliteDialect({ database: sqlite }) });
  return dbInstance;
}

/**
 * Create or update the auth tables. Uses the exact same options the running
 * server uses (plugin columns included). Idempotent, so it runs at every start.
 */
export async function ensureSchema(): Promise<void> {
  // Imported here, not at the top, because auth.ts imports this module.
  const { authOptions } = await import("./auth.ts");
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
}
