import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { prepareShortfallReviews } from "../../src/pipeline/validate/shortfall-review.ts";

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
async function fixture(count = 4) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-shortfall-"));
  for (const dir of ["pipeline/manifests", "pipeline/snapshots"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensurePipelineSchema(db); await ensureGoldSchema(db);
  const codebook = { codebookVersion: "fixture-v1", relationTypes: [], checks: { fixture: { decision: "rely", label: "Fixture", operationalDefinition: "Complete operational rule.", passRule: "Pass requires working evidence.", failRule: "Fail requires contrary evidence.", claimedRule: "Claimed requires own claim.", notApplicableNote: "No exception.", anchors: { positive: ["Full positive anchor."], negative: ["Full negative anchor."] }, crosswalk: {} }, other: { label: "Unused" } } };
  const entries = Array.from({ length: count }, (_, i) => ({ n: i + 1, hn_id: String(1000 + i) }));
  fs.writeFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), JSON.stringify(entries));
  const protocolPath = path.join(dataDir, "protocol.md");
  fs.writeFileSync(protocolPath, "## Addendum (A7)\n### A7.4 Shortfall step 1\nOne clarification, fresh 76.\n### A7.5 Shortfall step 2\nWithhold unresolved.\n### A7.6 Other\nNot needed.\n");
  for (const e of entries) {
    fs.writeFileSync(path.join(dataDir, "pipeline", "manifests", `${e.n}.json`), JSON.stringify({ snapshotHashesInCollectionOrder: e.n === 3 ? [`fixture-${e.n}`, `fixture-${e.n}`] : [`fixture-${e.n}`] }));
    fs.writeFileSync(path.join(dataDir, "pipeline", "snapshots", `fixture-${e.n}.json`), JSON.stringify({ redactedText: e.n === 3 ? "Repeated synthetic evidence." : `Synthetic evidence ${e.n}.` }));
    const spans = projectSpans(dataDir, e.n); const input_digest = spansDigest(spans);
    const primary = e.n === 1 ? "unknown" : e.n === 2 ? "claimed" : "pass"; const gold = e.n === 1 ? "pass" : "unknown";
    await db.insertInto("pipeline_check_states").values({ project_n: e.n, check_id: "fixture", filtered_state: primary, proposed_state: primary, span_ids_json: JSON.stringify(primary === "unknown" ? [] : spans.map(s => s.id)) }).execute();
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: e.n, codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", input_digest, outcome: "labelled" }).execute();
    await db.insertInto("pipeline_gold_labels").values({ project_n: e.n, check_id: "fixture", codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", provider: "ollama", model_id: "glm-5.3-flash:cloud", reasoning: "low", filtered_state: gold, raw_state: gold, input_digest, span_ids_json: JSON.stringify(gold === "unknown" ? [] : [spans[0].id]) }).execute();
  }
  const gate = { codebookVersion: codebook.codebookVersion, sampleNs: entries.map(e => e.n), checks: [{ checkId: "fixture", status: "missed", n: count, ac1: .5, precision: .4 }, { checkId: "other", status: "released" }] };
  return { db, dataDir, codebook, gate, protocolPath };
}

test("review ordering prioritizes false positives, preserves distinct cited IDs and writes only private evidence", async () => {
  const f = await fixture(); const spans = projectSpans(f.dataDir, 3); assert.equal(spans.length, 2);
  await f.db.updateTable("pipeline_check_states").set({ span_ids_json: JSON.stringify([spans[0].id, spans[0].id, spans[1].id]) }).where("project_n", "=", 3).execute();
  await f.db.insertInto("pipeline_injection_flags").values({ project_n: 3, span_id: spans[1].id }).execute();
  const [review] = await prepareShortfallReviews(f);
  assert.equal(review.examples, 4); assert.equal(review.fp, 2); assert.equal(review.fn, 1); assert.deepEqual(review.caseDocuments.map(row => row.projectN), [3, 4, 1, 2]);
  const text = fs.readFileSync(review.documentPath, "utf8"); assert.equal(sha(text), review.docDigest); assert.ok(text.includes("Full positive anchor.")); assert.ok(text.includes("Full negative anchor.")); assert.ok(text.includes("not human ground truth"));
  const repeated = fs.readFileSync(review.caseDocuments[0].documentPath, "utf8"); assert.equal(repeated.split("Repeated synthetic evidence.").length - 1, 2); assert.ok(repeated.includes("Injection flag: flagged"));
  assert.equal(fs.statSync(review.documentPath).mode & 0o777, 0o600); assert.ok(review.context.includes("A7.4")); assert.ok(!review.context.includes("Complete operational rule."));
  const actions = JSON.parse(fs.readFileSync(path.join(f.dataDir, "validation", "shortfall-actions.json"), "utf8")); assert.equal(actions.checks.length, 1); assert.equal(actions.checks[0].action, "step-1-correction"); assert.equal(actions.checks[0].evidenceDigest, review.docDigest);
  await f.db.destroy();
});

test("only ten ordered examples are selected and stale gold cannot enter a review", async () => {
  const f = await fixture(13);
  await f.db.updateTable("pipeline_gold_outcomes").set({ input_digest: "stale" }).where("project_n", "=", 13).execute();
  const [review] = await prepareShortfallReviews(f);
  assert.equal(review.examples, 10); assert.deepEqual(review.caseDocuments.map(row => row.projectN), Array.from({ length: 10 }, (_, i) => i + 3));
  await f.db.destroy();
});

test("unresolved citations are refused rather than guessed or dropped", async () => {
  const f = await fixture();
  await f.db.updateTable("pipeline_check_states").set({ span_ids_json: '["missing"]' }).where("project_n", "=", 3).execute();
  await assert.rejects(prepareShortfallReviews(f), /citation unresolved/); await f.db.destroy();
});

test("oversize single examples retain all text and are flagged instead of truncated", async () => {
  const f = await fixture(1); const spans = projectSpans(f.dataDir, 1);
  f.codebook.checks.fixture.operationalDefinition = "Complete rule " + "x".repeat(85_000);
  const [review] = await prepareShortfallReviews(f);
  assert.equal(review.tooLarge, true); assert.equal(review.caseDocuments[0].tooLarge, true);
  assert.ok(fs.readFileSync(review.caseDocuments[0].documentPath, "utf8").includes("x".repeat(85_000))); assert.ok(spans.length > 0);
  await f.db.destroy();
});
