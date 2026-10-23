// scripts/export-hosted-db.mjs: the online backup of PRISM_DATA_DIR/prism.sqlite.
// A writer connection keeps rows in the WAL (no checkpoint) while the backup
// runs, so the test proves the backup API is used rather than a file copy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/export-hosted-db.mjs");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-backup-"));
const backups = path.join(dataDir, "backups");
let writer;

function run(extra = [], env = {}) {
  return spawnSync(process.execPath, [script, ...extra], {
    cwd: repoRoot,
    env: { ...process.env, PRISM_DATA_DIR: dataDir, ...env },
    encoding: "utf8",
  });
}

before(() => {
  writer = new Database(path.join(dataDir, "prism.sqlite"));
  writer.pragma("journal_mode = WAL");
  writer.pragma("wal_autocheckpoint = 0");
  writer.exec("CREATE TABLE user (id TEXT, email TEXT); CREATE TABLE session (id TEXT, token TEXT)");
  const insert = writer.prepare("INSERT INTO user VALUES (?, ?)");
  for (let i = 0; i < 3; i += 1) insert.run(`u${i}`, `secret-row-${i}@backup.example`);
  writer.prepare("INSERT INTO session VALUES ('s1', 'token-value-not-printed')").run();
});

after(() => {
  writer?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("backs up the live database, WAL rows included, mode 600 in a mode-700 directory, one BACKUP line", () => {
  // The rows are still only in the WAL: the main file holds no user rows yet.
  const walBytes = fs.statSync(path.join(dataDir, "prism.sqlite-wal")).size;
  assert.ok(walBytes > 0, "the writer's rows should sit in the WAL");

  const res = run();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const m = /^BACKUP file=(prism-\d{8}T\d{6}Z\.sqlite) tables=2 integrity=ok rows=session:1,user:3$/.exec(lines[0]);
  assert.ok(m, lines[0]);
  assert.ok(!res.stdout.includes("secret-row") && !res.stdout.includes("token-value") && !res.stdout.includes(dataDir));

  const file = path.join(backups, m[1]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
  const copy = new Database(file, { readonly: true });
  assert.equal(copy.prepare("SELECT count(*) FROM user").pluck().get(), 3);
  copy.close();
});

test("--out inside the repository exits non-zero and writes nothing", () => {
  const out = path.join(repoRoot, "prism-backup-must-not-exist.sqlite");
  const res = run(["--out", out]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /^BACKUP error: /);
  assert.equal(fs.existsSync(out), false);
});

test("a missing source database exits non-zero with BACKUP error:", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "prism-backup-empty-"));
  try {
    const res = run([], { PRISM_DATA_DIR: empty });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /^BACKUP error: /);
    assert.equal(fs.existsSync(path.join(empty, "backups")), false);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a WAL database with no open connection (server stopped) backs up too", () => {
  const stopped = fs.mkdtempSync(path.join(os.tmpdir(), "prism-backup-stopped-"));
  try {
    const db = new Database(path.join(stopped, "prism.sqlite"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE user (id TEXT); INSERT INTO user VALUES ('a')");
    db.close();
    const res = run([], { PRISM_DATA_DIR: stopped });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /tables=1 integrity=ok rows=user:1$/m);
  } finally {
    fs.rmSync(stopped, { recursive: true, force: true });
  }
});

test("after three backups, --keep 2 leaves only the two newest", () => {
  fs.rmSync(backups, { recursive: true, force: true });
  fs.mkdirSync(backups, { mode: 0o700 });
  const older = ["prism-20200101T000000Z.sqlite", "prism-20210101T000000Z.sqlite"];
  for (const name of older) assert.equal(run(["--out", path.join(backups, name)]).status, 0);
  const res = run(["--keep", "2"]);
  assert.equal(res.status, 0, res.stdout);
  const newest = /file=(\S+)/.exec(res.stdout)[1];
  assert.deepEqual(fs.readdirSync(backups).filter((f) => f.endsWith(".sqlite")).sort(), [older[1], newest].sort());
});
