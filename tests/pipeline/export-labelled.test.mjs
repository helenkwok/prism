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

import { ensureConfirmationSchema, ensureEditsSchema, projectSpans, spansDigest, inputDigest } from "../../src/pipeline/confirm/confirm.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
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
        input_digest: inputDigest(loadCodebook(), { projectN: 1, checkId: "output-reproducible", state: "claimed", spans }),
        span_ids_json: JSON.stringify([spanId]),
        confirmed_state: "claimed",
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

    await db.schema.createTable("pipeline_check_states").addColumn("project_n", "integer").addColumn("check_id", "text").addColumn("filtered_state", "text").addColumn("span_ids_json", "text").execute();
    await db.insertInto("pipeline_check_states").values({project_n: 1, check_id: "output-reproducible", filtered_state: "pass", span_ids_json: JSON.stringify([spanId])}).execute();
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: 1, codebook_version: "v1.0", labeller_id: "person:a@example.com", input_digest: digest, outcome: "labelled" }).execute();
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
    fs.chmodSync(result.path, 0o644);
    await exportLabelled({ db, dataDir, sampleNs: [1], codebookVersion: "v1.0" });
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);

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

  test("binds confirmations to current evidence and attributes hosts without guessing", async () => {
    const dataDir = makeDataDir(2);
    const db = memDb();
    try {
      await ensureConfirmationSchema(db);
      await db.schema.createTable("pipeline_check_states").addColumn("project_n", "integer").addColumn("check_id", "text").addColumn("filtered_state", "text").addColumn("span_ids_json", "text").execute();
      const spans = projectSpans(dataDir, 2);
      const checkId = "output-reproducible";
      await db.insertInto("pipeline_check_states").values({project_n: 2, check_id: checkId, filtered_state: "pass", span_ids_json: JSON.stringify(spans.map(s => s.id))}).execute();
      const digest = inputDigest(loadCodebook(), {projectN: 2, checkId, state: "pass", spans});
      for (const [id, model, provider, stale] of [
        ["agent:ollama:nemotron-3-ultra:thinking-on", "nemotron-3-ultra:cloud", "ollama", false],
        ["agent:nvidia/Nemotron-3-Ultra-550b-a55b", "nvidia/Nemotron-3-Ultra-550b-a55b", "nebius", false],
        ["person:reviewer", null, null, false],
        ["agent:unknown", "unknown", null, false],
        ["agent:stale", "unknown", null, true],
      ]) {
        await db.insertInto("pipeline_confirmations").values({project_n:2, check_id:checkId, confirmer_id:id, confirmer_kind:id.startsWith("person:")?"person":"agent", model_id:model, decision:"confirmed", confirmed_state:"pass", reason:"synthetic", decided_at:"2026-10-21T00:00:00.000Z", input_digest:stale?"old":digest, span_ids_json:JSON.stringify(spans.map(s=>s.id))}).execute();
      }
      const result = await exportLabelled({db, dataDir, sampleNs:[2], codebookVersion:"v1.0"});
      assert.equal(result.confirmation, 4);
      assert.equal(result.excluded.confirmationStale, 1);
      const records = fs.readFileSync(result.path,"utf8").trim().split("\n").map(JSON.parse);
      const providers = new Map(records.map(r => [r.actor.id, r.actor.provider]));
      assert.equal(providers.get("agent:ollama:nemotron-3-ultra:thinking-on"), "ollama");
      assert.equal(providers.get("agent:nvidia/Nemotron-3-Ultra-550b-a55b"), "nebius");
      assert.equal(providers.get("person:reviewer"), null);
      assert.equal(providers.get("agent:unknown"), null);
      await db.schema.createTable("pipeline_injection_flags").addColumn("project_n", "integer").addColumn("span_id", "text").execute();
      await db.insertInto("pipeline_injection_flags").values({ project_n: 2, span_id: spans[0].id }).execute();
      const flagged = await exportLabelled({ db, dataDir, sampleNs: [2], codebookVersion: "v1.0" });
      assert.equal(flagged.confirmation, 0);
      assert.equal(flagged.excluded.confirmationStale, 5);
      await db.deleteFrom("pipeline_injection_flags").execute();
      fs.writeFileSync(path.join(dataDir,"pipeline","snapshots","snap1.json"), JSON.stringify({redactedText:"Changed synthetic evidence."}));
      const changed = await exportLabelled({db,dataDir,sampleNs:[2],codebookVersion:"v1.0"});
      assert.equal(changed.confirmation,0);
      assert.equal(changed.excluded.confirmationStale,5);
    } finally { await db.destroy(); fs.rmSync(dataDir,{recursive:true,force:true}); }
  });

  test("reports gold excluded for stale evidence, old version and non-labelled outcomes", async () => {
    const dataDir = makeDataDir(3);
    const db = memDb();
    try {
      await ensureGoldSchema(db);
      const spans = projectSpans(dataDir,3);
      const digest = spansDigest(spans);
      for (const [id,version,d,outcome] of [["current","v1.0",digest,"labelled"],["stale","v1.0","old","labelled"],["old-version","v0",digest,"labelled"],["no-gold","v1.0",digest,"no-gold"],["missing","v1.0",digest,null]]) {
        await db.insertInto("pipeline_gold_labels").values({project_n:3,check_id:"output-reproducible",codebook_version:version,labeller_id:id,labeller_kind:"person",raw_state:"pass",filtered_state:"pass",span_ids_json:JSON.stringify(spans.map(s=>s.id)),input_digest:d,labelled_at:"2026-10-21T00:00:00.000Z"}).execute();
        if(outcome) await db.insertInto("pipeline_gold_outcomes").values({project_n:3,codebook_version:version,labeller_id:id,input_digest:d,outcome}).execute();
      }
      const result = await exportLabelled({db,dataDir,sampleNs:[3],codebookVersion:"v1.0"});
      assert.equal(result.gold,1);
      assert.deepEqual(result.excluded,{confirmationStale:0,goldStale:1,goldCodebook:1,goldNoGold:1,goldMissingOutcome:1});
      assert.equal(loadValidator()(JSON.parse(fs.readFileSync(result.path,"utf8"))),true);
    } finally { await db.destroy(); fs.rmSync(dataDir,{recursive:true,force:true}); }
  });

  test("refuses archived stores before reading rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),"prism-export-"));
    const dataDir = path.join(dir,"backups","2026-10-21-span-defect");
    fs.mkdirSync(dataDir,{recursive:true});
    const db=memDb();
    try { await assert.rejects(()=>exportLabelled({db,dataDir,sampleNs:[1],codebookVersion:"v1.0"}),/archiv|backup/i); }
    finally { await db.destroy(); fs.rmSync(dir,{recursive:true,force:true}); }
  });

  test("refuses a requested version that differs from the current codebook", async () => {
    const dataDir = makeDataDir(1);
    const db = memDb();
    try { await assert.rejects(() => exportLabelled({ db, dataDir, sampleNs: [1], codebookVersion: "v0" }), /codebook version is not current/); }
    finally { await db.destroy(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
