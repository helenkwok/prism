import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { loadConfirmationRequestRefusals, verifySignedConfirmationRefusalCoverage } from "../../src/pipeline/validate/confirmation-refusal.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { ensureConfirmationSchema, ensureEditsSchema, inputDigest, spansDigest, projectSpans, buildConfirmationBody } from "../../src/pipeline/confirm/confirm.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { estimateMessagesTokens } from "../../src/pipeline/coding/spend-guards.ts";
import { APPROVED_CAPS, APPROVED_OLLAMA_CAP } from "../../src/pipeline/validate/approved-budget.ts";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const model = "nemotron-3-ultra:cloud", at = "2026-10-24T00:00:00Z";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirmation-refusal-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  t.after(() => db.destroy()); await ensurePipelineSchema(db); await ensureGoldSchema(db); await ensureConfirmationSchema(db); await ensureEditsSchema(db);
  for (const dir of ["pipeline/manifests", "pipeline/snapshots", "validation", "decisions"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  const file = name => path.join(dataDir, name), write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value));
  const book = loadCodebook(), [target, other] = Object.keys(book.checks), codebook = { ...book, checks: { [target]: book.checks[target], [other]: book.checks[other] } };
  for (const n of [1, 2]) {
    const text = n === 1 ? Array.from({ length: 70 }, (_, i) => `Clause ${i} ${"e".repeat(1400)}.`).join("\n\n") : "Synthetic small evidence.";
    const h = sha(text); write(`pipeline/snapshots/${h}.json`, { redactedText: text }); write(`pipeline/manifests/${n}.json`, { snapshotHashesInCollectionOrder: [h] });
    const spans = projectSpans(dataDir, n);
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: n, codebook_version: codebook.codebookVersion, labeller_id: "fixture", input_digest: spansDigest(spans), outcome: "labelled", decided_at: at }).execute();
    await db.insertInto("pipeline_check_states").values({ project_n: n, check_id: target, proposed_state: "pass", filtered_state: "pass", span_ids_json: JSON.stringify(spans.map(s => s.id)) }).execute();
  }
  await db.insertInto("pipeline_check_states").values({ project_n: 1, check_id: other, proposed_state: "unknown", filtered_state: "unknown", span_ids_json: "[]" }).execute();
  const short = projectSpans(dataDir, 2);
  await db.insertInto("pipeline_check_states").values({ project_n: 2, check_id: other, proposed_state: "pass", filtered_state: "pass", span_ids_json: JSON.stringify(short.map(s => s.id)) }).execute();
  const outside = { projectN: 2, checkId: other, state: "pass", spans: short, flaggedSpanIds: [] };
  await db.insertInto("pipeline_confirmations").values({ project_n: 2, check_id: other, confirmer_kind: "agent", confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-on", model_id: model, decision: "confirmed", confirmed_state: "pass", reason: "p1-s001 supports the synthetic state.", input_digest: inputDigest(codebook, outside), span_ids_json: JSON.stringify(short.map(s => s.id)), decided_at: at }).execute();
  const positive = { projectN: 1, checkId: target, state: "pass", spans: projectSpans(dataDir, 1), flaggedSpanIds: [] }, body = buildConfirmationBody(codebook, positive, model, true);
  const request = { projectN: 1, checkId: target, inputDigest: inputDigest(codebook, positive), requestDigest: sha(JSON.stringify(body)), inputTokens: estimateMessagesTokens(body.messages), tokenCap: 20000, model, thinking: true };
  assert.ok(request.inputTokens > 20000 && request.inputTokens < 50000);
  const plan = { approved: true, approvalDate: "2026-10-24", stage: "full-confirm", model, currentCap: 20000, proposedCap: 50000, otherRequestsKeepCap: 20000, outputLimit: 8192, stageBudget: APPROVED_CAPS["full-confirm"], sharedOllamaBudget: APPROVED_OLLAMA_CAP, preserveAllCitedText: true, confirmationEnvelopeParser: false, maxInputEstimate: 21000,
    scope: Array.from({ length: 9 }, (_, i) => ({ projectN: i ? 900 + i : 1, checkId: target, estimatedTokens: 21000, inputDigest: sha(`old-input-${i}`), requestDigest: sha(`old-request-${i}`) })) };
  write("validation/confirmation-request-cap-plan.json", plan);
  const proof = { version: 1, checkIds: [target], exceptionsPath: file("validation/confirmation-request-cap-plan.json"), exceptionsDigest: sha(JSON.stringify(plan)), requests: [request] };
  write("validation/correction-confirmation-request-refusals.json", proof);
  const options = { documentPath: file("validation/correction-confirmation-request-refusals.json") };
  return { db, dataDir, codebook, sampleNs: [1, 2], cutoff: Date.parse("2026-10-23T00:00:00Z"), options, target, other, proof, plan, request, write, file };
}

test("changed inputs at an old approved identity remain refused and all pending work stays visible", async t => {
  const f = await fixture(t), result = await loadConfirmationRequestRefusals(f);
  assert.equal(result.evidence.refused, 1); assert.equal(result.evidence.pending, 2); assert.equal(result.validCached, 1);
  assert.deepEqual(result.evidence.requests, [f.request]); assert.equal(result.evidence.checkIds[0], f.target);
});

test("refusal proof rejects omitted, stale, invented or newly exempt requests", async t => {
  const f = await fixture(t);
  for (const mutate of [p => { p.requests = []; }, p => { p.requests[0].inputTokens--; }, p => { p.requests[0].requestDigest = "f".repeat(64); }, p => { p.checkIds.push(f.other); }, p => { p.requests.push(p.requests[0]); }, p => { p.exceptionsDigest = "0".repeat(64); }]) {
    const proof = structuredClone(f.proof); mutate(proof); f.write("validation/correction-confirmation-request-refusals.json", proof);
    await assert.rejects(loadConfirmationRequestRefusals(f), /confirmation refusal/);
  }
  f.write("validation/correction-confirmation-request-refusals.json", f.proof);
  f.plan.scope[0] = { projectN: 1, checkId: f.target, estimatedTokens: f.request.inputTokens, inputDigest: f.request.inputDigest, requestDigest: f.request.requestDigest };
  f.plan.maxInputEstimate = Math.max(...f.plan.scope.map(row => row.estimatedTokens));
  f.write("validation/confirmation-request-cap-plan.json", f.plan);
  f.proof.exceptionsDigest = sha(JSON.stringify(f.plan)); f.write("validation/correction-confirmation-request-refusals.json", f.proof);
  await assert.rejects(loadConfirmationRequestRefusals(f), /current non-exempt oversized inventory/);
});

test("missing injection metadata or a missing current check cannot shrink the accepted scope", async t => {
  const f = await fixture(t);
  await f.db.deleteFrom("pipeline_check_states").where("project_n", "=", 1).where("check_id", "=", f.other).execute();
  await assert.rejects(loadConfirmationRequestRefusals(f), /primary check coverage is incomplete/);
  await f.db.insertInto("pipeline_check_states").values({ project_n: 1, check_id: f.other, proposed_state: "unknown", filtered_state: "unknown", span_ids_json: "[]" }).execute();
  await f.db.schema.dropTable("pipeline_injection_flags").execute();
  await assert.rejects(loadConfirmationRequestRefusals(f), /pipeline_injection_flags/);
});

test("only signed exact withholding permits unfinished full confirmation with complete outside coverage", async t => {
  const f = await fixture(t), current = await loadConfirmationRequestRefusals(f);
  const gate = { sampleNs: [1, 2], approvalEvidence: { recoveryCutoffUpperBound: "2026-10-23T00:00:00Z" }, checks: [{ checkId: f.target, status: "withheld", confirmationRefusalProofDigest: current.evidence.proofDigest }, { checkId: f.other, status: "released" }], confirmationRequestRefusals: current.evidence };
  const gatePath = f.file("validation/gate-v1.0.json"), signoffPath = f.file("decisions/release-signoff.jsonl");
  const sign = () => { f.write("validation/gate-v1.0.json", gate); const text = fs.readFileSync(gatePath, "utf8"); fs.writeFileSync(signoffPath, JSON.stringify({ item: "VAL-07 gate record (final)", docDigest: sha(text), decision: "approved", decidedAt: at }) + "\n"); };
  f.write("validation/gate-v1.0.json", gate);
  await assert.rejects(verifySignedConfirmationRefusalCoverage({ ...f, gatePath, signoffPath }), /signed final gate/);
  sign();
  const result = await verifySignedConfirmationRefusalCoverage({ ...f, gatePath, signoffPath });
  assert.equal(result.accounting.total, 3); assert.equal(result.accounting.valid, 1); assert.equal(result.accounting.cached, 1); assert.equal(result.accounting.remaining, 2);
  assert.equal(result.accounting.complete, false); assert.equal(result.accounting.ok, false); assert.equal(result.scope.completeForPublishedScope, true); assert.equal(result.scope.modelCalls, 0);
  gate.checks[0].status = "released"; sign(); await assert.rejects(verifySignedConfirmationRefusalCoverage({ ...f, gatePath, signoffPath }), /signed withholding/);
  gate.checks[0].status = "withheld"; sign();
  await f.db.updateTable("pipeline_confirmations").set({ confirmed_state: null }).where("check_id", "=", f.other).execute();
  await assert.rejects(verifySignedConfirmationRefusalCoverage({ ...f, gatePath, signoffPath }), /signed withholding|outside the signed refusal scope/);
});
