// D-67: archive whole-page-span positives / confirmations / gold-on-defective
// as exploratory, not_for_publication. Never delete this archive. After SHA
// verify, clear the same rows from the live DB so agreement/gate cannot score them.
// Content-addressed snapshot blobs under pipeline/snapshots are left alone (Task C).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { resolveDataDir } from "../../app/server/db.ts";
import { PROTECTED_BACKUP_BASENAMES, WHOLE_PAGE_SPANS_BACKUP } from "./protected-backups.ts";

export type ArchiveCounts = {
  exploratory: true;
  not_for_publication: true;
  defect: "whole-page-spans";
  gold_policy: string;
  cleared_from_live: string[];
  runtime: {
    positives_pass_claimed: number;
    confirmations: number;
    gold_projects: number;
    gold_labels: number;
    gold_outcomes: number;
  };
  archived_at: string;
};

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function countPositives(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS c FROM pipeline_check_states WHERE filtered_state IN ('pass','claimed')`,
      )
      .get() as { c: number }
  ).c;
}

function probeRuntime(db: Database.Database): ArchiveCounts["runtime"] {
  const tables = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    positives_pass_claimed: tables.has("pipeline_check_states") ? countPositives(db) : 0,
    confirmations: tables.has("pipeline_confirmations")
      ? c(`SELECT count(*) AS c FROM pipeline_confirmations`)
      : 0,
    gold_projects: tables.has("pipeline_gold_labels")
      ? c(`SELECT count(DISTINCT project_n) AS c FROM pipeline_gold_labels`)
      : 0,
    gold_labels: tables.has("pipeline_gold_labels")
      ? c(`SELECT count(*) AS c FROM pipeline_gold_labels`)
      : 0,
    gold_outcomes: tables.has("pipeline_gold_outcomes")
      ? c(`SELECT count(*) AS c FROM pipeline_gold_outcomes`)
      : 0,
  };
}

function writeSha256Sums(backupDir: string): void {
  const lines: string[] = [];
  const walk = (dir: string, rel = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === "SHA256SUMS") continue;
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) lines.push(`${sha256File(full)}  ${r}`);
    }
  };
  walk(backupDir);
  const sumsPath = path.join(backupDir, "SHA256SUMS");
  fs.writeFileSync(sumsPath, lines.join("\n") + "\n", { mode: 0o400 });
}

function chmodTreeReadOnly(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      chmodTreeReadOnly(full);
      fs.chmodSync(full, 0o500);
    } else {
      fs.chmodSync(full, 0o400);
    }
  }
  fs.chmodSync(dir, 0o500);
}

/**
 * Copy live sqlite into backupDir, write COUNTS.json + SHA256SUMS, chmod a-w,
 * then clear live confirmations / gold / pass|claimed check-states.
 * Does not delete pipeline/snapshots. Refuses if backupDir already exists.
 * For the protected basename, first create is allowed; overwrite is not.
 */
export async function archiveWholePageSpans({
  dataDir,
  backupDir,
  clearLive = true,
}: {
  dataDir: string;
  backupDir: string;
  clearLive?: boolean;
}): Promise<{ backupDir: string; counts: ArchiveCounts }> {
  const base = path.basename(path.resolve(backupDir));
  if (fs.existsSync(backupDir)) {
    throw new Error(`archive already exists (refusing overwrite): ${backupDir}`);
  }
  // Other tools must not write protected basenames; this CLI is the one-time writer.
  if (PROTECTED_BACKUP_BASENAMES.has(base) && base !== WHOLE_PAGE_SPANS_BACKUP) {
    throw new Error(`protected backup: refusing write of ${base}`);
  }

  const liveDbPath = path.join(dataDir, "prism.sqlite");
  if (!fs.existsSync(liveDbPath)) throw new Error(`live database missing: ${liveDbPath}`);

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const destDbPath = path.join(backupDir, "prism.sqlite");
  const liveDb = new Database(liveDbPath);
  let runtime: ArchiveCounts["runtime"];
  try {
    runtime = probeRuntime(liveDb);
    if (
      runtime.positives_pass_claimed === 0 &&
      runtime.confirmations === 0 &&
      runtime.gold_projects === 0
    ) {
      liveDb.close();
      fs.rmSync(backupDir, { recursive: true, force: true });
      throw new Error("archive refuse: live store has no positives/confirmations/gold to archive");
    }
    await liveDb.backup(destDbPath);
  } finally {
    liveDb.close();
  }
  fs.chmodSync(destDbPath, 0o600);

  const cleared_from_live = [
    "pipeline_confirmations (DELETE all)",
    "pipeline_gold_labels (DELETE all)",
    "pipeline_gold_outcomes (DELETE all)",
    "pipeline_check_states pass|claimed → filtered_state=unknown (span_ids kept; snapshots untouched)",
  ];

  const counts: ArchiveCounts = {
    exploratory: true,
    not_for_publication: true,
    defect: "whole-page-spans",
    gold_policy:
      "Gold labels produced on defective whole-page spans are archived here only. They must never feed agreement.ts, gate.ts, or publishedStates. Fresh gold runs only after A9 + resegment + recode (Task G).",
    cleared_from_live,
    runtime,
    archived_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(backupDir, "COUNTS.json"), JSON.stringify(counts, null, 2) + "\n", {
    mode: 0o600,
  });

  // Verify backup counts match live probe at archive time.
  const bak = new Database(destDbPath, { readonly: true });
  try {
    const bakRuntime = probeRuntime(bak);
    for (const k of Object.keys(runtime) as (keyof typeof runtime)[]) {
      if (bakRuntime[k] !== runtime[k]) {
        throw new Error(
          `archive verify failed: ${k} live=${runtime[k]} backup=${bakRuntime[k]}`,
        );
      }
    }
  } finally {
    bak.close();
  }

  writeSha256Sums(backupDir);
  chmodTreeReadOnly(backupDir);

  if (clearLive) {
    const live = new Database(liveDbPath);
    try {
      const tx = live.transaction(() => {
        const tables = new Set(
          live
            .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
            .all()
            .map((r) => (r as { name: string }).name),
        );
        if (tables.has("pipeline_confirmations")) {
          live.prepare(`DELETE FROM pipeline_confirmations`).run();
        }
        if (tables.has("pipeline_gold_labels")) {
          live.prepare(`DELETE FROM pipeline_gold_labels`).run();
        }
        if (tables.has("pipeline_gold_outcomes")) {
          live.prepare(`DELETE FROM pipeline_gold_outcomes`).run();
        }
        if (tables.has("pipeline_check_states")) {
          live
            .prepare(
              `UPDATE pipeline_check_states SET filtered_state = 'unknown' WHERE filtered_state IN ('pass','claimed')`,
            )
            .run();
        }
      });
      tx();
    } finally {
      live.close();
    }
  }

  return { backupDir, counts };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "archive-whole-page-spans.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  (async () => {
    const i = process.argv.indexOf("--backup");
    const backupDir =
      i >= 0 && process.argv[i + 1]
        ? process.argv[i + 1]
        : path.join(resolveDataDir(), "backups", WHOLE_PAGE_SPANS_BACKUP);
    const noClear = process.argv.includes("--no-clear-live");
    const dataDir = resolveDataDir();
    const result = await archiveWholePageSpans({
      dataDir,
      backupDir,
      clearLive: !noClear,
    });
    process.stdout.write(`ARCHIVE: ${JSON.stringify({ backupDir: result.backupDir, runtime: result.counts.runtime })}\n`);
    process.stdout.write(`COUNTS: ${JSON.stringify(result.counts)}\n`);
  })().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
