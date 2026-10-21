// D-61: verified backup of prism.sqlite + pipeline/manifests, then clear
// pipeline_* rows and manifests so bulk n=1..300 does not overwrite the pilot.
// Auth tables and the stage cache/snapshots are left alone.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { resolveDataDir } from "../../app/server/db.ts";

export type ResetPilotHooks = {
  /** Runs after backup + manifests are copied, before verification. Tests use this to corrupt the backup. */
  afterBackup?: (backupDir: string) => void;
};

export type ResetPilotResult = {
  backupDir: string;
  tables: Record<string, { before: number; after: number }>;
  manifests: { copied: number; deleted: number };
};

function listUserTables(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
}

function tableCounts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of listUserTables(db)) {
    out[name] = (db.prepare(`SELECT count(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as { c: number }).c;
  }
  return out;
}

function sha256File(filePath: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function listManifestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort();
}

function copyManifests(srcDir: string, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const names = listManifestFiles(srcDir);
  for (const name of names) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
  }
  return names.length;
}

function verifyBackup(liveDbPath: string, backupDir: string, liveManifestDir: string): void {
  const backupDbPath = path.join(backupDir, "prism.sqlite");
  const backupManifestDir = path.join(backupDir, "manifests");

  const live = new Database(liveDbPath, { readonly: true });
  const bak = new Database(backupDbPath, { readonly: true });
  try {
    const liveCounts = tableCounts(live);
    const bakCounts = tableCounts(bak);
    const liveNames = Object.keys(liveCounts);
    const bakNames = Object.keys(bakCounts);
    if (liveNames.length !== bakNames.length || liveNames.some((n, i) => n !== bakNames[i])) {
      throw new Error(
        `backup verification failed: table set mismatch live=[${liveNames.join(",")}] backup=[${bakNames.join(",")}]`,
      );
    }
    for (const name of liveNames) {
      if (liveCounts[name] !== bakCounts[name]) {
        throw new Error(
          `backup verification failed: table ${name} count live=${liveCounts[name]} backup=${bakCounts[name]}`,
        );
      }
    }

    const liveManifests = listManifestFiles(liveManifestDir);
    const bakManifests = listManifestFiles(backupManifestDir);
    if (liveManifests.length !== bakManifests.length || liveManifests.some((n, i) => n !== bakManifests[i])) {
      throw new Error(
        `backup verification failed: manifest set mismatch live=[${liveManifests.join(",")}] backup=[${bakManifests.join(",")}]`,
      );
    }
    for (const name of liveManifests) {
      const liveHash = sha256File(path.join(liveManifestDir, name));
      const bakHash = sha256File(path.join(backupManifestDir, name));
      if (liveHash !== bakHash) {
        throw new Error(`backup verification failed: manifest ${name} sha256 mismatch`);
      }
    }
  } finally {
    live.close();
    bak.close();
  }
}

/** Online backup of live sqlite, then per-table + per-manifest verify, then clear pipeline_* + manifests. */
export async function resetPilot({
  dataDir,
  backupDir,
  hooks,
}: {
  dataDir: string;
  backupDir: string;
  hooks?: ResetPilotHooks;
}): Promise<ResetPilotResult> {
  if (fs.existsSync(backupDir)) {
    throw new Error(`backupDir already exists (refusing overwrite): ${backupDir}`);
  }

  const liveDbPath = path.join(dataDir, "prism.sqlite");
  if (!fs.existsSync(liveDbPath)) {
    throw new Error(`live database missing: ${liveDbPath}`);
  }
  const liveManifestDir = path.join(dataDir, "pipeline", "manifests");

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);

  const destDbPath = path.join(backupDir, "prism.sqlite");
  const liveDb = new Database(liveDbPath);
  try {
    await liveDb.backup(destDbPath);
  } finally {
    liveDb.close();
  }
  fs.chmodSync(destDbPath, 0o600);

  const copied = copyManifests(liveManifestDir, path.join(backupDir, "manifests"));

  hooks?.afterBackup?.(backupDir);

  verifyBackup(liveDbPath, backupDir, liveManifestDir);

  const live = new Database(liveDbPath);
  const tables: Record<string, { before: number; after: number }> = {};
  try {
    const before = tableCounts(live);
    for (const [name, count] of Object.entries(before)) {
      tables[name] = { before: count, after: count };
    }

    const pipelineTables = Object.keys(before).filter((n) => n.startsWith("pipeline_"));
    const del = live.transaction(() => {
      for (const name of pipelineTables) {
        live.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
      }
    });
    del();

    const after = tableCounts(live);
    for (const name of Object.keys(tables)) {
      tables[name].after = after[name] ?? 0;
    }
  } finally {
    live.close();
  }

  let deleted = 0;
  if (fs.existsSync(liveManifestDir)) {
    for (const name of listManifestFiles(liveManifestDir)) {
      fs.unlinkSync(path.join(liveManifestDir, name));
      deleted += 1;
    }
  }

  return { backupDir, tables, manifests: { copied, deleted } };
}

function printReset(result: ResetPilotResult): void {
  process.stdout.write(`RESET: ${JSON.stringify(result)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "reset-pilot.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  (async () => {
    const i = process.argv.indexOf("--backup");
    if (i < 0 || !process.argv[i + 1]) {
      process.stderr.write("usage: node src/pipeline/store/reset-pilot.ts --backup <backupDir>\n");
      process.exit(1);
    }
    const backupDir = process.argv[i + 1];
    const dataDir = resolveDataDir();
    const result = await resetPilot({ dataDir, backupDir });
    printReset(result);
  })().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
