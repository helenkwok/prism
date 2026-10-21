// D-66 exploratory cross-check — temp fixtures only, never the real archive.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import Database from "better-sqlite3";

import {
  crosscheckLine,
  jaccard,
  normalizeQuote,
  pageSets,
  runCrossCheck,
  writeReport,
} from "../../src/pipeline/validate/tavily-vs-free.ts";

function seedDb(dbPath, { projectN, hashes, checks }) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE pipeline_project_results (
      project_n INTEGER PRIMARY KEY,
      snapshot_hashes_json TEXT
    );
    CREATE TABLE pipeline_check_states (
      project_n INTEGER,
      check_id TEXT,
      filtered_state TEXT,
      PRIMARY KEY (project_n, check_id)
    );
  `);
  db.prepare("INSERT INTO pipeline_project_results VALUES (?, ?)").run(projectN, JSON.stringify(hashes));
  for (const c of checks) {
    db.prepare("INSERT INTO pipeline_check_states VALUES (?, ?, ?)").run(projectN, c.id, c.state);
  }
  db.close();
}

function writeSnap(root, hash, url, texts) {
  const dir = path.join(root, "pipeline", "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${hash}.json`),
    JSON.stringify({
      url,
      snapshotHash: hash,
      spans: texts.map((text, i) => ({ id: `p0-s${i}`, text })),
    }),
  );
}

function writeManifest(root, projectN, urls) {
  const dir = path.join(root, "pipeline", "manifests");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${projectN}.json`),
    JSON.stringify({ projectN, snapshots: urls.map((url) => ({ url })) }),
  );
}

describe("tavily-vs-free helpers", () => {
  test("normalizeQuote collapses case and whitespace", () => {
    assert.equal(normalizeQuote("  Hello\nWorld  "), "hello world");
  });

  test("pageSets and jaccard", () => {
    const s = pageSets(["https://a/x", "https://a/y"], ["https://a/y", "https://a/z"]);
    assert.deepEqual(s.intersection, ["https://a/y"]);
    assert.deepEqual(s.tavilyOnly, ["https://a/x"]);
    assert.deepEqual(s.freeOnly, ["https://a/z"]);
    assert.equal(s.jaccard, 1 / 3);
    assert.equal(jaccard(new Set(), new Set()), 1);
  });
});

describe("runCrossCheck", () => {
  test("compares fixtures; exploratory flags; never writes archive", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prism-xcheck-"));
    const archive = path.join(parent, "2026-10-21-tavily-142");
    const live = path.join(parent, "live");
    fs.mkdirSync(archive, { recursive: true });
    fs.mkdirSync(live, { recursive: true });

    const tHash = "a".repeat(64);
    const fHash = "b".repeat(64);
    seedDb(path.join(archive, "prism.sqlite"), {
      projectN: 1,
      hashes: [tHash],
      checks: [
        { id: "c1", state: "pass" },
        { id: "c2", state: "unknown" },
      ],
    });
    seedDb(path.join(live, "prism.sqlite"), {
      projectN: 1,
      hashes: [fHash],
      checks: [
        { id: "c1", state: "pass" },
        { id: "c2", state: "fail" },
      ],
    });
    writeManifest(archive, 1, ["https://ex.example/", "https://ex.example/a"]);
    writeManifest(live, 1, ["https://ex.example/", "https://ex.example/b"]);
    writeSnap(archive, tHash, "https://ex.example/", ["Shared quote text that is long enough", "Tavily only quote text here"]);
    writeSnap(live, fHash, "https://ex.example/", ["Shared quote text that is long enough", "Free only quote text here!!"]);

    const before = cryptoishList(archive);
    const report = runCrossCheck({ archivePath: archive, liveDataDir: live });
    assert.equal(report.exploratory, true);
    assert.equal(report.not_for_publication, true);
    assert.equal(report.n, 1);
    assert.equal(report.projects[0].checks.agree, 1);
    assert.equal(report.projects[0].checks.n, 2);
    assert.equal(report.projects[0].spanQuoteOverlap.sharedNormalized, 1);
    assert.ok(report.meanPageJaccard > 0);
    const line = crosscheckLine(report);
    assert.match(line, /^CROSSCHECK: n=1 /);
    assert.match(line, /exploratory=true/);

    const out = path.join(parent, "out.json");
    writeReport(report, out);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(written.exploratory, true);
    assert.equal(written.not_for_publication, true);

    assert.deepEqual(cryptoishList(archive), before);

    fs.rmSync(parent, { recursive: true, force: true });
  });

  test("refuses wrong archive basename", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prism-xcheck-bad-"));
    const archive = path.join(parent, "other-backup");
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, "prism.sqlite"), "");
    assert.throws(() => runCrossCheck({ archivePath: archive, liveDataDir: parent }), /basename/);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

function cryptoishList(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), st.size, st.mtimeMs]);
    }
  };
  walk(dir);
  return out;
}
