import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { verifyRevalidationProof } from "../../src/pipeline/revalidation-proof.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildContract } from "../../src/pipeline/coding/contract.ts";
import { PINNED_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import { SIGNOFF_MODEL } from "../../src/pipeline/signoff/signoff.ts";
import { buildCodingMessages, chunkSpans, guidedCodingChunks } from "../../src/pipeline/run.ts";
import { uniqueProjectSpans } from "../../src/pipeline/coding/span-packing.ts";
import { projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { SAMPLING_SEED, QUARTER_STARTS } from "../../src/pipeline/select/draw-sample.ts";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const hash = value => sha(JSON.stringify(value));
const book = loadCodebook(), id = Object.keys(book.checks)[0];
const codebook = { ...book, checks: { [id]: book.checks[id] } };
const at = "2026-10-24T01:00:00.000Z";

async function fixture(t, { activeBook = codebook, text = "Synthetic test evidence." } = {}) {
  const codebook = activeBook, checkIds = Object.keys(codebook.checks);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-revalidation-proof-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  t.after(() => db.destroy()); await ensurePipelineSchema(db); await ensureGoldSchema(db);
  const file = name => path.join(dataDir, name);
  const write = (name, value) => { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), JSON.stringify(value)); };
  const guidance = { version: "c1", checks: { [id]: "Synthetic fixed clarification." } };
  const doc = JSON.stringify(guidance), context = "Synthetic complete rule context.", item = "Codebook correction c1";
  const approved = { item, decision: "approved", docDigest: sha(doc), inputDigest: hash({ doc, context, item }), decidedAt: "2026-10-24T00:00:00.000Z", reviewer: { id: `agent:${SIGNOFF_MODEL}`, kind: "agent", modelId: SIGNOFF_MODEL } };
  write("validation/guidance.json", guidance); write("validation/proposal.json", { doc, context, item });
  fs.mkdirSync(file("decisions")); fs.writeFileSync(file("decisions/release-signoff.jsonl"), JSON.stringify(approved) + "\n");
  const previousEntries = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, hn_id: String(i + 1001), quarter: Math.floor(i / 75) + 1, created_at: QUARTER_STARTS[Math.floor(i / 75)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const entries = Array.from({ length: 76 }, (_, i) => ({ n: i + 301, hn_id: String(i + 2001), quarter: Math.floor(i / 19) + 1, created_at: QUARTER_STARTS[Math.floor(i / 19)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const source = { posts: entries.map(e => ({ id: e.hn_id, created_at: e.created_at })), previousEntries, previousLog: [] };
  write("validation/sampling-source.json", source); write("pipeline/fresh-projects.json", entries);
  write("pipeline/fresh-validation-sample.json", { version: 1, seed: SAMPLING_SEED, perQuarter: 19, entriesDigest: hash(entries), sourceDigest: hash({ seed: SAMPLING_SEED, perQuarter: 19, ...source }) });
  const sourceHash = sha(text);
  write(`pipeline/snapshots/${sourceHash}.json`, { redactedText: text });
  const runtime = { version: guidance.version, byCheck: guidance.checks };
  for (const e of [...previousEntries, ...entries]) {
    write(`pipeline/manifests/${e.n}.json`, { hnId: e.hn_id, snapshotHashesInCollectionOrder: [sourceHash], codingCorrection: { version: "c1", checks: [id] } });
    const spans = projectSpans(dataDir, e.n), digest = spansDigest(spans);
    const requestIds = e.n <= 300 ? [id] : checkIds, contract = buildContract(requestIds), schema = contract.jsonSchema;
    const prompt = hash({ schema, guidance: runtime, messages: guidedCodingChunks(spans, codebook, contract, runtime).map(chunk => buildCodingMessages(requestIds, codebook, schema, chunk, runtime)) });
    await db.insertInto("pipeline_project_results").values({ project_n: e.n, hn_id: e.hn_id, model_id: PINNED_MODEL, codebook_version: codebook.codebookVersion, completed_at: at, snapshot_hashes_json: JSON.stringify([sourceHash]), prompt_hash: prompt, coding_all_unknown: 0 }).execute();
    if (e.n <= 300) continue;
    const state = e.n <= 312 ? "pass" : "unknown", citations = state === "pass" ? '["p1-s001"]' : "[]";
    for (const checkId of checkIds) await db.insertInto("pipeline_check_states").values({ project_n: e.n, check_id: checkId, proposed_state: state, filtered_state: state, span_ids_json: citations }).execute();
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: e.n, codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", input_digest: digest, outcome: "labelled", decided_at: at }).execute();
    for (const checkId of checkIds) await db.insertInto("pipeline_gold_labels").values({ project_n: e.n, check_id: checkId, codebook_version: codebook.codebookVersion, labeller_id: "agent:ollama:glm-5.3-flash:cloud", provider: "ollama", model_id: "glm-5.3-flash:cloud", reasoning: "low", filtered_state: state, span_ids_json: citations, input_digest: digest, labelled_at: at }).execute();
  }
  return { db, dataDir, codebook, checkIds, sampleNs: previousEntries.map(e => e.n), freshNs: entries.map(e => e.n), cutoff: Date.parse("2026-10-23T00:00:00Z"),
    proof: { guidancePath: file("validation/guidance.json"), proposalPath: file("validation/proposal.json"), samplingSourcePath: file("validation/sampling-source.json"), signoffPath: file("decisions/release-signoff.jsonl") },
    write, file, approved };
}

test("fresh proof recomputes complete current metrics and approved application across all 300", async t => {
  const f = await fixture(t), result = await verifyRevalidationProof(f);
  assert.equal(result.metrics.checks[0].n, 76); assert.equal(result.metrics.checks[0].goldPasses, 12);
  assert.equal(result.metrics.checks[0].ac1, 1); assert.equal(result.metrics.checks[0].precision, 1);
  assert.ok(result.metrics.checks[0].ac1CI); assert.deepEqual(result.appliedCheckIds, [id]);
  assert.equal(result.evidence.pairedProjects, 76); assert.match(result.evidence.currentEvidenceDigest, /^[a-f0-9]{64}$/);
});
test("a missing fresh draw, forged provenance or original-project overlap cannot validate", async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.file("pipeline/fresh-projects.json"), "utf8");
  fs.unlinkSync(f.file("pipeline/fresh-projects.json")); await assert.rejects(verifyRevalidationProof(f));
  fs.writeFileSync(f.file("pipeline/fresh-projects.json"), original);
  f.write("pipeline/fresh-validation-sample.json", { version: 1, seed: SAMPLING_SEED, perQuarter: 19, entriesDigest: hash(JSON.parse(original)), sourceDigest: "0".repeat(64) });
  await assert.rejects(verifyRevalidationProof(f), /sampling provenance/);
});
test("rejected or after-scoring approvals and changed guidance cannot authorize promotion", async t => {
  const f = await fixture(t), original = fs.readFileSync(f.proof.signoffPath, "utf8");
  fs.appendFileSync(f.proof.signoffPath, JSON.stringify({ ...f.approved, decision: "rejected", decidedAt: at }) + "\n");
  await assert.rejects(verifyRevalidationProof(f), /lacks independent approval/);
  fs.writeFileSync(f.proof.signoffPath, JSON.stringify({ ...f.approved, decidedAt: "2026-10-24T02:00:00Z" }) + "\n");
  await assert.rejects(verifyRevalidationProof(f), /not the current approved guided request/);
  fs.writeFileSync(f.proof.signoffPath, original);
  f.write("validation/guidance.json", { version: "c1", checks: { [id]: "Changed unapproved guidance." } });
  await assert.rejects(verifyRevalidationProof(f), /exact guidance bytes/);
});
test("incomplete fresh labels, stale citations and wrong prompt hashes fail closed", async t => {
  const f = await fixture(t);
  await f.db.deleteFrom("pipeline_gold_labels").where("project_n", "=", 376).execute();
  await assert.rejects(verifyRevalidationProof(f), /gold labels are incomplete/);
  await f.db.updateTable("pipeline_check_states").set({ span_ids_json: '["missing"]' }).where("project_n", "=", 301).execute();
  await assert.rejects(verifyRevalidationProof(f), /primary coding is incomplete/);
  await f.db.updateTable("pipeline_project_results").set({ prompt_hash: "0".repeat(64) }).where("project_n", "=", 301).execute();
  await assert.rejects(verifyRevalidationProof(f), /not the current approved guided request/);
});
test("current data changes recompute metrics rather than trusting a stored perfect figure", async t => {
  const f = await fixture(t);
  await f.db.updateTable("pipeline_check_states").set({ filtered_state: "unknown", span_ids_json: "[]" }).where("project_n", "=", 301).execute();
  await f.db.updateTable("pipeline_project_results").set({ prompt_hash: "stale" }).where("project_n", "=", 300).execute();
  const result = await verifyRevalidationProof(f);
  assert.ok(result.metrics.checks[0].ac1 < 1); assert.deepEqual(result.appliedCheckIds, []);
});
test("missing gold outcomes remain explicit and source mutations invalidate proof", async t => {
  const f = await fixture(t);
  await f.db.updateTable("pipeline_gold_outcomes").set({ outcome: "no-gold" }).where("project_n", "=", 376).execute();
  const result = await verifyRevalidationProof(f);
  assert.equal(result.metrics.checks[0].n, 75); assert.equal(result.evidence.noGoldProjects, 1);
  const snap = fs.readdirSync(f.file("pipeline/snapshots"))[0];
  f.write(`pipeline/snapshots/${snap}`, { redactedText: "Different evidence under old hash." });
  await assert.rejects(verifyRevalidationProof(f), /source integrity mismatch/);
});

test("full-schema fresh proof binds whole-span subdivisions rather than over-cap legacy chunks", async t => {
  const text = Array.from({ length: 2400 }, (_, i) => `Clause ${String(i).padStart(4, "0")} test.`).join("\n\n");
  const f = await fixture(t, { activeBook: book, text });
  const spans = projectSpans(f.dataDir, 301), contract = buildContract(f.checkIds);
  const guidance = { version: "c1", byCheck: { [id]: "Synthetic fixed clarification." } };
  const packed = guidedCodingChunks(spans, book, contract, guidance), legacy = chunkSpans(uniqueProjectSpans(spans));
  assert.ok(packed.length > legacy.length);
  assert.deepEqual(packed.flat(), uniqueProjectSpans(spans));
  assert.ok(packed.every(chunk => chunk.reduce((n, span) => n + span.text.length, 0) <= 40_000));
  const verified = await verifyRevalidationProof(f);
  assert.equal(verified.metrics.checks.length, 24);
  assert.ok(verified.metrics.checks.every(row => row.n === 76 && row.ac1 === 1));
  assert.deepEqual(verified.appliedCheckIds, [id]);
  const wrongPrompt = hash({ schema: contract.jsonSchema, guidance, messages: legacy.map(chunk => buildCodingMessages(f.checkIds, book, contract.jsonSchema, chunk, guidance)) });
  await f.db.updateTable("pipeline_project_results").set({ prompt_hash: wrongPrompt }).where("project_n", "=", 301).execute();
  await assert.rejects(verifyRevalidationProof(f), /not the current approved guided request/);
});
