// D-59 / COD-08: labelled dataset schema + export CLI.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { ensureConfirmationSchema, ensureEditsSchema, projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { exportLabelled } from "../../src/pipeline/validate/export-labelled.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = path.join(repoRoot, "protocol/labelled-dataset.schema.json");
const examplePath = path.join(repoRoot, "protocol/labelled-dataset.example.jsonl");

function loadValidator() {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function memDb() {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
}

function makeDataDir(projectN, text = "We publish a status page for customers.") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-export-"));
  const hash = "snap1";
  fs.mkdirSync(path.join(dir, "pipeline", "manifests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pipeline", "snapshots"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pipeline", "manifests", `${projectN}.json`),
    JSON.stringify({ snapshotHashesInCollectionOrder: [hash] }),
  );
  fs.writeFileSync(
    path.join(dir, "pipeline", "snapshots", `${hash}.json`),
    JSON.stringify({ redactedText: text }),
  );
  return dir;
}

describe("labelled-dataset schema and example", () => {
  test("every example.jsonl line validates; covers confirmation, gold, edit", () => {
    const validate = loadValidator();
    const lines = fs.readFileSync(examplePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const kinds = new Set();
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.equal(validate(obj), true, JSON.stringify(validate.errors));
      kinds.add(obj.kind);
    }
    assert.deepEqual([...kinds].sort(), ["confirmation", "edit", "gold"]);
  });
});

describe("exportLabelled", () => {
  test("exports one of each kind to labelled-v1.0.jsonl under dataDir/exports with mode 0o600", async () => {
    const dataDir = makeDataDir(1);
    const db = memDb();
    await ensureConfirmationSchema(db);
    await ensureEditsSchema(db);
    await ensureGoldSchema(db);

    const spans = projectSpans(dataDir, 1);
    const spanId = spans[0].id;
    const digest = spansDigest(spans);

    await db
      .insertInto("pipeline_confirmations")
      .values({
        project_n: 1,
        check_id: "output-reproducible",
        confirmer_id: "agent:m",
        confirmer_kind: "agent",
        model_id: "nvidia/test",
        decision: "confirmed",
        reason: "span shows it",
        decided_at: "2026-10-21T00:00:00.000Z",
        input_digest: "abc",
        span_ids_json: JSON.stringify([spanId]),
        confirmed_state: "pass",
      })
      .execute();

    await db
      .insertInto("pipeline_gold_labels")
      .values({
        project_n: 1,
        check_id: "output-reproducible",
        codebook_version: "v1.0",
        labeller_id: "person:a@example.com",
        labeller_kind: "person",
        provider: null,
        model_id: null,
        reasoning: null,
        raw_state: "pass",
        filtered_state: "pass",
        span_ids_json: JSON.stringify([spanId]),
        input_digest: digest,
        labelled_at: "2026-10-21T00:01:00.000Z",
      })
      .execute();

    await db
      .insertInto("pipeline_edits")
      .values({
        project_n: 1,
        check_id: "output-reproducible",
        state: "claimed",
        filtered_state: "claimed",
        span_ids_json: JSON.stringify([spanId]),
        reason: "only a claim",
        actor_id: "person:b@example.com",
        actor_kind: "person",
        input_digest: "editdigest",
        edited_at: "2026-10-21T00:02:00.000Z",
      })
      .execute();

    const result = await exportLabelled({
      db,
      dataDir,
      sampleNs: [1],
      codebookVersion: "v1.0",
      version: "v1.0",
    });

    assert.equal(result.confirmation, 1);
    assert.equal(result.gold, 1);
    assert.equal(result.edit, 1);
    assert.equal(result.path, path.join(dataDir, "exports", "labelled-v1.0.jsonl"));
    assert.ok(fs.existsSync(result.path));
    const mode = fs.statSync(result.path).mode & 0o777;
    assert.equal(mode, 0o600);

    const validate = loadValidator();
    const outLines = fs.readFileSync(result.path, "utf8").trim().split("\n");
    assert.equal(outLines.length, 3);
    for (const line of outLines) {
      const obj = JSON.parse(line);
      assert.equal(validate(obj), true, JSON.stringify(validate.errors));
      assert.ok(obj.checkId);
      assert.ok(Array.isArray(obj.spanIds));
      assert.ok(Array.isArray(obj.quotes));
      assert.ok(obj.quotes[0]?.text);
      assert.ok(obj.verdict);
      assert.ok(obj.actor?.id);
      assert.ok(obj.actor?.kind);
      assert.ok(obj.timestamp);
      assert.ok(obj.codebookVersion);
      assert.ok(obj.inputDigest);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("refuses an --out path inside the repository", async () => {
    const dataDir = makeDataDir(1);
    const db = memDb();
    const inside = path.join(repoRoot, "protocol", "should-not-write.jsonl");
    await assert.rejects(
      () => exportLabelled({ db, dataDir, sampleNs: [1], codebookVersion: "v1.0", out: inside }),
      /refusing|outside|repository|in-repo|inside/i,
    );
    assert.equal(fs.existsSync(inside), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
