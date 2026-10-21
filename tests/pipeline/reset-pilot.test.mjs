// D-61: verified backup then pilot reset — temp dirs only, never the live store.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import Database from "better-sqlite3";

import { resetPilot } from "../../src/pipeline/store/reset-pilot.ts";

function seedDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-reset-data-"));
  const dbPath = path.join(dataDir, "prism.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE pipeline_project_results (project_n INTEGER PRIMARY KEY, hn_id TEXT);
    CREATE TABLE pipeline_check_states (project_n INTEGER, check_id TEXT);
    CREATE TABLE auth_users (id TEXT PRIMARY KEY, email TEXT);
    INSERT INTO pipeline_project_results VALUES (1, 'h1'), (2, 'h2');
    INSERT INTO pipeline_check_states VALUES (1, 'c1'), (1, 'c2'), (2, 'c1');
    INSERT INTO auth_users VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com');
  `);
  db.close();

  const manifestDir = path.join(dataDir, "pipeline", "manifests");
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(manifestDir, `${n}.json`), JSON.stringify({ n, ok: true }), { mode: 0o600 });
  }
  return dataDir;
}

function count(dbPath, table) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  } finally {
    db.close();
  }
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("resetPilot (D-61)", () => {
  test("verified backup then clears pipeline_* and manifests; auth rows stay", async () => {
    const dataDir = seedDataDir();
    const backupDir = path.join(os.tmpdir(), `prism-reset-bak-${Date.now()}-a`);
    const liveDb = path.join(dataDir, "prism.sqlite");
    const liveManifests = path.join(dataDir, "pipeline", "manifests");
    const liveHashes = Object.fromEntries(
      [1, 2, 3].map((n) => [n, digest(path.join(liveManifests, `${n}.json`))]),
    );

    const result = await resetPilot({ dataDir, backupDir });

    assert.equal(result.manifests.copied, 3);
    assert.equal(result.manifests.deleted, 3);
    assert.ok(fs.existsSync(path.join(backupDir, "prism.sqlite")));

    assert.equal(count(path.join(backupDir, "prism.sqlite"), "pipeline_project_results"), 2);
    assert.equal(count(path.join(backupDir, "prism.sqlite"), "pipeline_check_states"), 3);
    assert.equal(count(path.join(backupDir, "prism.sqlite"), "auth_users"), 2);

    for (const n of [1, 2, 3]) {
      const bak = path.join(backupDir, "manifests", `${n}.json`);
      assert.ok(fs.existsSync(bak));
      assert.equal(digest(bak), liveHashes[n]);
      assert.equal(fs.existsSync(path.join(liveManifests, `${n}.json`)), false);
    }

    assert.equal(count(liveDb, "pipeline_project_results"), 0);
    assert.equal(count(liveDb, "pipeline_check_states"), 0);
    assert.equal(count(liveDb, "auth_users"), 2);
    assert.equal(result.tables.pipeline_project_results.before, 2);
    assert.equal(result.tables.pipeline_project_results.after, 0);
    assert.equal(result.tables.auth_users.before, 2);
    assert.equal(result.tables.auth_users.after, 2);

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  test("verification failure deletes nothing from the live store", async () => {
    const dataDir = seedDataDir();
    const backupDir = path.join(os.tmpdir(), `prism-reset-bak-${Date.now()}-b`);
    const liveDb = path.join(dataDir, "prism.sqlite");

    await assert.rejects(
      () =>
        resetPilot({
          dataDir,
          backupDir,
          hooks: {
            afterBackup(dir) {
              fs.unlinkSync(path.join(dir, "manifests", "2.json"));
            },
          },
        }),
      /backup verification failed/,
    );

    assert.equal(count(liveDb, "pipeline_project_results"), 2);
    assert.equal(count(liveDb, "pipeline_check_states"), 3);
    assert.equal(count(liveDb, "auth_users"), 2);
    assert.equal(
      fs.readdirSync(path.join(dataDir, "pipeline", "manifests")).filter((n) => n.endsWith(".json")).length,
      3,
    );

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  test("refuses to overwrite an existing backupDir", async () => {
    const dataDir = seedDataDir();
    const backupDir = path.join(os.tmpdir(), `prism-reset-bak-${Date.now()}-c`);
    fs.mkdirSync(backupDir, { recursive: true });

    await assert.rejects(() => resetPilot({ dataDir, backupDir }), /already exists/);

    assert.equal(count(path.join(dataDir, "prism.sqlite"), "pipeline_project_results"), 2);
    assert.equal(fs.readdirSync(path.join(dataDir, "pipeline", "manifests")).length, 3);

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  });
});
