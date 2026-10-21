// D-67 whole-page-spans archive — temp paths only; never touch real ~/.prism-data backups.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import Database from "better-sqlite3";

import { archiveWholePageSpans } from "../../src/pipeline/store/archive-whole-page-spans.ts";
import {
  assertBackupWritable,
  PROTECTED_BACKUP_BASENAMES,
  WHOLE_PAGE_SPANS_BACKUP,
} from "../../src/pipeline/store/protected-backups.ts";

function seedDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-wps-"));
  const dbPath = path.join(dataDir, "prism.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE pipeline_check_states (
      project_n INTEGER, check_id TEXT, filtered_state TEXT, span_ids_json TEXT
    );
    CREATE TABLE pipeline_confirmations (
      project_n INTEGER, check_id TEXT, confirmer_id TEXT, decision TEXT
    );
    CREATE TABLE pipeline_gold_labels (
      project_n INTEGER, check_id TEXT, filtered_state TEXT
    );
    CREATE TABLE pipeline_gold_outcomes (
      project_n INTEGER, outcome TEXT
    );
  `);
  db.prepare(
    `INSERT INTO pipeline_check_states VALUES (1,'c1','pass','["s001"]'), (1,'c2','claimed','["s002"]'), (1,'c3','unknown','[]')`,
  ).run();
  db.prepare(`INSERT INTO pipeline_confirmations VALUES (1,'c1','agent:x','confirmed')`).run();
  db.prepare(`INSERT INTO pipeline_gold_labels VALUES (1,'c1','pass')`).run();
  db.prepare(`INSERT INTO pipeline_gold_outcomes VALUES (1,'labelled')`).run();
  db.close();
  return dataDir;
}

describe("archiveWholePageSpans", () => {
  test("PROTECTED includes whole-page-spans; assertBackupWritable refuses it", () => {
    assert.ok(PROTECTED_BACKUP_BASENAMES.has(WHOLE_PAGE_SPANS_BACKUP));
    assert.ok(PROTECTED_BACKUP_BASENAMES.has("2026-10-21-tavily-142"));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prism-wps-prot-"));
    const backupDir = path.join(parent, WHOLE_PAGE_SPANS_BACKUP);
    assert.throws(() => assertBackupWritable(backupDir), /protected backup/);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  test("archives counts, writes COUNTS+SHA256SUMS, clears live, refuses overwrite", async () => {
    const dataDir = seedDataDir();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prism-wps-bak-"));
    const backupDir = path.join(parent, "test-archive-wps");

    const { counts } = await archiveWholePageSpans({ dataDir, backupDir, clearLive: true });
    assert.equal(counts.exploratory, true);
    assert.equal(counts.not_for_publication, true);
    assert.equal(counts.defect, "whole-page-spans");
    assert.ok(counts.gold_policy);
    assert.equal(counts.runtime.positives_pass_claimed, 2);
    assert.equal(counts.runtime.confirmations, 1);
    assert.equal(counts.runtime.gold_projects, 1);

    assert.ok(fs.existsSync(path.join(backupDir, "prism.sqlite")));
    assert.ok(fs.existsSync(path.join(backupDir, "COUNTS.json")));
    assert.ok(fs.existsSync(path.join(backupDir, "SHA256SUMS")));
    const c = JSON.parse(fs.readFileSync(path.join(backupDir, "COUNTS.json"), "utf8"));
    assert.equal(c.exploratory, true);
    assert.equal(c.not_for_publication, true);

    const live = new Database(path.join(dataDir, "prism.sqlite"));
    assert.equal(live.prepare(`SELECT count(*) AS c FROM pipeline_confirmations`).get().c, 0);
    assert.equal(live.prepare(`SELECT count(*) AS c FROM pipeline_gold_labels`).get().c, 0);
    assert.equal(
      live.prepare(`SELECT count(*) AS c FROM pipeline_check_states WHERE filtered_state IN ('pass','claimed')`).get()
        .c,
      0,
    );
    assert.equal(
      live.prepare(`SELECT count(*) AS c FROM pipeline_check_states WHERE filtered_state = 'unknown'`).get().c,
      3,
    );
    live.close();

    await assert.rejects(() => archiveWholePageSpans({ dataDir, backupDir }), /already exists/);

    fs.rmSync(dataDir, { recursive: true, force: true });
    // backup is mode 500 — chmod u+w before rm
    fs.chmodSync(backupDir, 0o700);
    for (const name of fs.readdirSync(backupDir)) {
      try {
        fs.chmodSync(path.join(backupDir, name), 0o600);
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
});
