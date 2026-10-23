// Online backup of the app's one database, PRISM_DATA_DIR/prism.sqlite (D-79).
//   node scripts/export-hosted-db.mjs [--out <file>] [--keep <n>]
//
// Uses SQLite's online backup API through better-sqlite3, so rows a running
// server committed to the WAL but not yet checkpointed are in the copy. The
// copy holds password hashes and live session tokens: it goes to
// PRISM_DATA_DIR/backups (mode 700) as prism-<UTC yyyymmddThhmmssZ>.sqlite with
// mode 600, never inside the repository. Prints one line:
//   BACKUP file=<basename> tables=<n> integrity=ok rows=<table>:<count>,...
// and never row content, the source path or a secret. Errors print
// `BACKUP error: <reason>` and exit 1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "./check-data-dir.mjs";

const NAME = /^prism-\d{8}T\d{6}Z\.sqlite$/;

function fail(reason) {
  console.log(`BACKUP error: ${reason}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (args[i + 1] === undefined) fail(`${name} needs a value`);
  return args[i + 1];
};
const outArg = flag("--out");
const keepArg = flag("--keep");
const keep = keepArg === undefined ? undefined : Number(keepArg);
if (keep !== undefined && !(Number.isInteger(keep) && keep >= 1)) fail("--keep must be a whole number of at least 1");

// The data directory exactly as the server resolves it (src/app/server/db.ts).
const cwdRoot = resolveRepoRoot(process.cwd());
let dataDir;
try {
  dataDir = assertOutsideRepo(resolvePrivateDir(process.env, cwdRoot), cwdRoot);
} catch (err) {
  fail(err.code ?? "data directory check failed");
}
const source = path.join(dataDir, "prism.sqlite");
if (!fs.existsSync(source)) fail("source database not found in PRISM_DATA_DIR");

const backupsDir = path.join(dataDir, "backups");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = path.resolve(outArg ?? path.join(backupsDir, `prism-${stamp}.sqlite`));
// Neither the repository the command runs in nor the one this script lives in.
const scriptRoot = resolveRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
for (const root of new Set([cwdRoot, scriptRoot])) {
  try {
    assertOutsideRepo(out, root);
  } catch {
    fail("--out is inside the repository");
  }
}
if (fs.existsSync(out)) fail(`${path.basename(out)} already exists`);

if (!outArg) {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupsDir, 0o700);
}

let rows;
try {
  const src = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await src.backup(out);
  } finally {
    src.close();
  }
  fs.chmodSync(out, 0o600);
  const copy = new Database(out, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("integrity_check did not return ok");
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all();
    rows = tables.map((t) => `${t}:${copy.prepare(`SELECT count(*) FROM "${t.replaceAll('"', '""')}"`).pluck().get()}`);
  } finally {
    copy.close();
  }
} catch (err) {
  fs.rmSync(out, { force: true });
  fail(err instanceof Error ? err.message : String(err));
}

// Retention runs only after a verified backup: keep the newest n by timestamped name.
if (keep !== undefined && fs.existsSync(backupsDir)) {
  const old = fs.readdirSync(backupsDir).filter((f) => NAME.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(backupsDir, f));
}

console.log(`BACKUP file=${path.basename(out)} tables=${rows.length} integrity=ok rows=${rows.join(",")}`);
