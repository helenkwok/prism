import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { evaluateGate, renderGateMarkdown, assertPublishable, loadSignedGate } from "../../src/pipeline/validate/gate.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { ensurePipelineSchema } from "../../src/pipeline/store/results.ts";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";
import { PINNED_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import { ensureConfirmationSchema, ensureEditsSchema, inputDigest, projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { A9_ITEMS, a9Section } from "../../src/pipeline/signoff/a9.ts";
import { ARTCRAFT_HN_ID, GOLD_SEED, SECOND_MODEL_SEED, SAMPLING_SEED, QUARTER_STARTS } from "../../src/pipeline/select/draw-sample.ts";
import { buildContract } from "../../src/pipeline/coding/contract.ts";
import { buildCodingMessages, chunkSpans } from "../../src/pipeline/run.ts";
import { verifyRevalidationProof } from "../../src/pipeline/revalidation-proof.ts";
import { prepareGateReviewBundle } from "../../src/pipeline/validate/gate-review-bundle.ts";
import { loadCorrectionApprovalFailures } from "../../src/pipeline/validate/correction-approval-failure.ts";
import { SIGNOFF_MODEL } from "../../src/pipeline/signoff/signoff.ts";
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const book = loadCodebook();
const ids = Object.keys(book.checks).slice(0, 3);
const cb = { ...book, checks: Object.fromEntries(ids.map(id => [id, book.checks[id]])) };
const goldId = "agent:ollama:glm-5.3-flash:cloud";
test("an explicit missing detached proof fails without falling back to the signature ledger", async () => {
  const read = fs.readFileSync;
  let ledgerReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === "string" && file.endsWith("/decisions/signoff.jsonl")) { ledgerReads++; throw new Error("ledger read prohibited"); }
    return read.call(this, file, ...args);
  };
  try {
    await assert.rejects(evaluateGate({ dataDir: os.tmpdir(), priorApprovalProofPath: path.join(os.tmpdir(), "missing-release-proof.json") }));
    assert.equal(ledgerReads, 0);
  } finally { fs.readFileSync = read; }
});
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-gate-"));
  for (const dir of ["pipeline/manifests", "pipeline/snapshots", "validation", "decisions"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pipeline/snapshots/fixture.json"), JSON.stringify({ redactedText: "Synthetic reusable fixture evidence." }));
  const docDigest = sha(a9Section(fs.readFileSync("protocol/PROTOCOL.md", "utf8")));
  fs.writeFileSync(path.join(dataDir, "decisions/signoff.jsonl"), A9_ITEMS.map(item => JSON.stringify({ item, decision: "approved", docDigest, decidedAt: "2026-10-23T00:00:00.000Z" })).join("\n"));
  fs.writeFileSync(path.join(dataDir, "validation/screening-audit.json"), JSON.stringify({ n: 50, assessable: 50, errors: 1, errorRate: .02, withinThreshold: true, wilson95: [.001, .1], action: { kind: "none" }, records: [{ quote: "NEVER_EXPORT_FIXTURE" }] }));
  fs.writeFileSync(path.join(dataDir, "validation/recall.json"), JSON.stringify({ figure: { projects: 10, contributing: 10, items: 20, found: 18, recall: .9, acceptanceMet: true, withinThreshold: true, perProject: [{ quote: "NEVER_EXPORT_FIXTURE" }] }, action: { kind: "none" }, wording: null }));
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensurePipelineSchema(db); await ensureGoldSchema(db); await ensureConfirmationSchema(db); await ensureEditsSchema(db);
  const sampleNs = Array.from({ length: 30 }, (_, i) => i + 1);
  for (const n of sampleNs) {
    fs.writeFileSync(path.join(dataDir, `pipeline/manifests/${n}.json`), JSON.stringify({ hnId: String(1000 + n), recodedAt: "2026-10-24T00:00:00.000Z", snapshotHashesInCollectionOrder: ["fixture"] }));
    await db.insertInto("pipeline_project_results").values({ project_n: n, hn_id: String(1000 + n), model_id: PINNED_MODEL, codebook_version: cb.codebookVersion, completed_at: "2026-10-24T00:00:00.000Z", snapshot_hashes_json: '["fixture"]', missing_data: 0 }).execute();
    const digest = spansDigest(projectSpans(dataDir, n));
    await db.insertInto("pipeline_gold_outcomes").values({ project_n: n, codebook_version: cb.codebookVersion, labeller_id: goldId, input_digest: digest, outcome: "labelled", decided_at: "2026-10-24T00:00:00.000Z" }).execute();
    for (const [j, id] of ids.entries()) {
      const b = n <= (j === 2 ? 6 : 12) ? "pass" : "unknown";
      const a = n <= (j === 1 ? 18 : j === 2 ? 6 : 12) ? "pass" : "unknown";
      await db.insertInto("pipeline_check_states").values({ project_n: n, check_id: id, proposed_state: a, filtered_state: a, span_ids_json: a === "pass" ? '["p1-s001"]' : "[]" }).execute();
      await db.insertInto("pipeline_gold_labels").values({ project_n: n, check_id: id, codebook_version: cb.codebookVersion, labeller_id: goldId, labeller_kind: "agent", provider: "ollama", model_id: "glm-5.3-flash:cloud", reasoning: "low", raw_state: b, filtered_state: b, span_ids_json: b === "pass" ? '["p1-s001"]' : "[]", input_digest: digest, labelled_at: "2026-10-24T00:00:00.000Z" }).execute();
      await db.insertInto("pipeline_second_coder_states").values({ project_n: n, check_id: id, model_id: "nemotron-3-super:cloud", proposed_state: b, filtered_state: b, span_ids_json: b === "pass" ? '["p1-s001"]' : "[]", coding_all_unknown: 0 }).execute();
    }
  }
  return { db, dataDir, sampleNs, subsets: { seeds: { gold: GOLD_SEED, secondModel: SECOND_MODEL_SEED }, secondModel: sampleNs.map(n => String(1000 + n)) }, codebook: cb, codebookVersion: cb.codebookVersion, gateFile: { checkIds: ids, sha256: "a".repeat(64), path: "synthetic", checkLabels: {} } };
}
test("point estimates release each estimable passing check and label rare checks", async () => {
  const f = await fixture(); const g = await evaluateGate(f);
  assert.equal(g.checks[0].status, "released"); assert.equal(g.checks[1].status, "missed"); assert.equal(g.checks[2].status, "released-not-estimable");
  assert.match(g.checks[2].reason, /not estimable/); assert.equal(g.checks[0].goldPasses, 12);
  assert.ok(g.checks[0].ac1CI); assert.ok(g.checks[0].precisionCI); assert.equal(g.bootstrap.resamples, 2000);
  assert.ok(g.checks[0].fourStateAc1CI); assert.ok(g.checks[0].fourStatePaCI); assert.ok(g.checks[0].fourStateKappaCI);
  assertPublishable(g, ids[0]); assertPublishable(g, ids[2]); assert.throws(() => assertPublishable(g, ids[1]));
  await f.db.destroy();
});
test("a favorable pooled figure never rescues a failing check", async () => {
  const f = await fixture(); const g = await evaluateGate(f); g.pooled.ac1 = .99; g.pooled.precision = .99;
  assert.equal(g.checks[1].status, "missed"); assert.throws(() => assertPublishable(g, ids[1]));
  await f.db.destroy();
});
test("a partial correction cannot release a formerly missed check through current point estimates", async () => {
  const f = await fixture();
  try {
    assert.equal((await evaluateGate(f)).checks[1].status, "missed");
    await f.db.updateTable("pipeline_check_states").set({ filtered_state: "unknown", span_ids_json: "[]" }).where("check_id", "=", ids[1]).where("project_n", ">", 12).execute();
    const file = path.join(f.dataDir, "pipeline/manifests/13.json"), manifest = JSON.parse(fs.readFileSync(file));
    manifest.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(file, JSON.stringify(manifest));
    const gate = await evaluateGate(f);
    assert.equal(gate.checks[1].ac1, 1); assert.equal(gate.checks[1].precision, 1);
    assert.equal(gate.checks[1].status, "missed");
    assert.throws(() => assertPublishable(gate, ids[1]));
    for (const n of f.sampleNs) {
      const name = path.join(f.dataDir, `pipeline/manifests/${n}.json`), current = JSON.parse(fs.readFileSync(name));
      current.codingCorrection = { version: "c1", checks: [ids[1], ids[2]] }; fs.writeFileSync(name, JSON.stringify(current));
    }
    const completeWithoutProof = await evaluateGate(f);
    assert.equal(completeWithoutProof.checks[1].status, "missed");
    assert.equal(completeWithoutProof.checks[2].status, "missed");
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});
test("funding withholding after partial correction requires a bound original missed gate", async () => {
  const f = await fixture();
  try {
    const baseline = await evaluateGate(f); baseline.generatedAt = new Date(Date.now() - 60_000).toISOString();
    const documentPath = path.join(f.dataDir, "validation/original-gate.json");
    const save = () => { const text = JSON.stringify(baseline); fs.writeFileSync(documentPath, text); return { documentPath, docDigest: sha(text) }; };
    const correctionBaseline = save(), funding = fundingFiles(f);
    await f.db.updateTable("pipeline_check_states").set({ filtered_state: "unknown", span_ids_json: "[]" }).where("check_id", "=", ids[1]).where("project_n", ">", 12).execute();
    const name = path.join(f.dataDir, "pipeline/manifests/13.json"), manifest = JSON.parse(fs.readFileSync(name));
    manifest.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(name, JSON.stringify(manifest));
    await f.db.updateTable("pipeline_project_results").set({ completed_at: new Date().toISOString() }).where("project_n", "=", 13).execute();
    const options = { ...f, fundingFallback: { policyPath: funding.policyPath, decisionPath: funding.decisionPath }, actions: funding.actions };
    await assert.rejects(evaluateGate(options), /bound pre-application baseline/);
    const gate = await evaluateGate({ ...options, correctionBaseline });
    assert.equal(gate.checks[1].ac1, 1); assert.equal(gate.checks[1].status, "withheld");
    assert.equal(gate.correctionBaselineEvidence.docDigest, correctionBaseline.docDigest);
    assert.doesNotMatch(gate.checks[1].reason, /fresh correction did not pass/);
    await assert.rejects(evaluateGate({ ...options, correctionBaseline: { ...correctionBaseline, docDigest: "0".repeat(64) } }), /baseline digest/);
    baseline.checks[1].status = "released";
    await assert.rejects(evaluateGate({ ...options, correctionBaseline: save() }), /missed its original gate/);
    baseline.checks[1].status = "missed"; baseline.generatedAt = new Date(Date.now() + 10_000).toISOString();
    await assert.rejects(evaluateGate({ ...options, correctionBaseline: save() }), /pre-application provenance/);
    baseline.generatedAt = new Date(Date.now() - 60_000).toISOString(); baseline.sampleNs.pop();
    await assert.rejects(evaluateGate({ ...options, correctionBaseline: save() }), /baseline digest, scope/);
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});
test("current labelled gold alone contributes; stale version/digest/outcome and wrong model are counted", async () => {
  const f = await fixture();
  await f.db.updateTable("pipeline_gold_outcomes").set({ outcome: "no-gold" }).where("project_n", "=", 1).execute();
  await f.db.updateTable("pipeline_gold_outcomes").set({ input_digest: "stale" }).where("project_n", "=", 2).execute();
  await f.db.updateTable("pipeline_gold_labels").set({ model_id: "unapproved-fixture" }).where("project_n", "=", 3).execute();
  await f.db.updateTable("pipeline_gold_labels").set({ codebook_version: "stale" }).where("project_n", "=", 4).execute();
  const g = await evaluateGate(f); assert.equal(g.checks[0].n, 26); assert.equal(g.exclusions.noGoldProjects, 1); assert.equal(g.exclusions.staleGoldProjects, 1); assert.equal(g.exclusions.incompleteGoldProjects, 2);
  assert.equal(g.secondModel.vsPrimary.checks[0].n, 30); assert.equal(g.secondModel.vsGold.checks[0].n, 26);
  await f.db.destroy();
});
test("pre-recovery labels and archive paths never enter the gate", async () => {
  const f = await fixture(); await f.db.updateTable("pipeline_gold_labels").set({ labelled_at: "2026-10-20T00:00:00.000Z" }).where("project_n", "=", 1).execute();
  const g = await evaluateGate(f); assert.equal(g.checks[0].n, 29); assert.equal(g.exclusions.incompleteGoldProjects, 1);
  await assert.rejects(() => evaluateGate({ ...f, dataDir: path.join(f.dataDir, "backups/2026-10-21-whole-page-spans") }), /archive/);
  await f.db.destroy();
});
test("worked case and projects beyond sample cannot inflate agreement", async () => {
  const f = await fixture(); await f.db.updateTable("pipeline_project_results").set({ hn_id: ARTCRAFT_HN_ID }).where("project_n", "=", 1).execute();
  await f.db.insertInto("pipeline_check_states").values({ project_n: 999, check_id: ids[0], filtered_state: "pass", span_ids_json: "[]" }).execute();
  const g = await evaluateGate(f); assert.equal(g.checks[0].n, 29); assert.equal(g.exclusions.a3Projects, 1); assert.equal(g.sampleNs.length, 30);
  await f.db.destroy();
});
test("claimed revalidation and correction markers never substitute for independently verified fresh evidence", async () => {
  const f = await fixture(); const revalidation = { sampleNs: Array.from({ length: 76 }, (_, i) => i + 301), checks: [{ checkId: ids[1], goldPasses: 12, ac1: .8, precision: .9 }] };
  const actions = { checks: [{ checkId: ids[1], action: "apply-correction", applied: true }] };
  let g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed");
  for (const n of f.sampleNs) { const file = path.join(f.dataDir, `pipeline/manifests/${n}.json`); const m = JSON.parse(fs.readFileSync(file)); m.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(file, JSON.stringify(m)); }
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed"); assert.throws(() => assertPublishable(g, ids[1]));
  assert.equal(g.revalidationSampleNs.length, 76); assert.equal(g.checks[1].revalidation.sampleRef, "revalidationSampleNs");
  g = await evaluateGate({ ...f, revalidation: { ...revalidation, sampleNs: [301] }, actions }); assert.equal(g.checks[1].status, "missed");
  g = await evaluateGate({ ...f, revalidation: { ...revalidation, sampleNs: [1, 2] }, actions }); assert.equal(g.checks[1].status, "missed");
  const freshPath = path.join(f.dataDir, "pipeline/fresh-projects.json");
  fs.writeFileSync(freshPath, JSON.stringify(revalidation.sampleNs.map(n => ({ n, quarter: 1 }))));
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed");
  fs.writeFileSync(freshPath, JSON.stringify(revalidation.sampleNs.map(n => ({ n, quarter: Math.floor((n - 301) / 19) + 1 }))));
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed");
  g = await evaluateGate({ ...f, revalidation: { ...revalidation, checks: [{ ...revalidation.checks[0], goldPasses: 6 }] }, actions: { checks: [{ checkId: ids[1], action: "withhold", applied: true }] } }); assert.equal(g.checks[1].status, "withheld"); assert.throws(() => assertPublishable(g, ids[1]));
  g = await evaluateGate({ ...f, actions: { checks: [{ checkId: ids[1], action: "withhold", applied: true }] } }); assert.equal(g.checks[1].status, "missed");
  await f.db.destroy();
});
test("full-sample current person coding is required for that publication path", async () => {
  const f = await fixture(); const action = { checks: [{ checkId: ids[1], action: "person-coded", applied: true }] };
  for (const n of f.sampleNs.slice(0, -1)) await f.db.insertInto("pipeline_edits").values({ project_n: n, check_id: ids[1], state: "unknown", filtered_state: "unknown", span_ids_json: "[]", actor_id: "person:fixture", actor_kind: "person", input_digest: sha(JSON.stringify({ checkId: ids[1], state: "unknown", spanIds: [], spans: [] })), edited_at: "2026-10-24T01:00:00.000Z" }).execute();
  let g = await evaluateGate({ ...f, actions: action }); assert.equal(g.checks[1].status, "missed");
  await f.db.insertInto("pipeline_edits").values({ project_n: 30, check_id: ids[1], state: "unknown", filtered_state: "unknown", span_ids_json: "[]", actor_id: "person:fixture", actor_kind: "person", input_digest: sha(JSON.stringify({ checkId: ids[1], state: "unknown", spanIds: [], spans: [] })), edited_at: "2026-10-24T01:00:00.000Z" }).execute();
  g = await evaluateGate({ ...f, actions: action }); assert.equal(g.checks[1].status, "person-coded"); assertPublishable(g, ids[1]);
  await f.db.destroy();
});
test("second comparisons are scoped, seeded, reported without gating and without private text", async () => {
  const f = await fixture(); const g = await evaluateGate(f);
  assert.equal(g.secondModel.seed, SECOND_MODEL_SEED); assert.equal(g.secondModel.usedAsGate, false); assert.equal(g.secondModel.vsGold.checks[0].n, 30); assert.equal(g.secondModel.vsPrimary.checks[0].n, 30);
  assert.equal(g.screeningAudit.status, "within"); assert.equal(g.collectionRecall.status, "within");
  assert.equal(JSON.stringify(g).includes("NEVER_EXPORT_FIXTURE"), false); assert.equal(renderGateMarkdown(g).includes("Synthetic reusable fixture"), false);
  await f.db.destroy();
});
test("published secondary excludes unconfirmed, stale and flagged positives", async () => {
  const f = await fixture(); const spans = projectSpans(f.dataDir, 1); const digest = inputDigest(cb, { projectN: 1, checkId: ids[0], state: "pass", spans });
  await f.db.insertInto("pipeline_confirmations").values({ project_n: 1, check_id: ids[0], confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-on", confirmer_kind: "agent", model_id: "nemotron-3-ultra:cloud", decision: "confirmed", confirmed_state: "pass", reason: "synthetic fixture", input_digest: digest, span_ids_json: '["p1-s001"]', decided_at: "2026-10-24T02:00:00.000Z" }).execute();
  let g = await evaluateGate(f); assert.equal(g.published.checks[0].coderPasses, 1);
  await f.db.insertInto("pipeline_injection_flags").values({ project_n: 1, span_id: "p1-s001" }).execute();
  g = await evaluateGate(f); assert.equal(g.published.checks[0].coderPasses, 0); assert.equal(g.injection.flaggedProjects, 1);
  assert.equal(g.injection.invalidFlaggedDecisions, 1);
  await f.db.destroy();
});
test("only latest approved exact-byte final sign-off permits loading a record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-gate-signature-")); const file = path.join(dir, "gate.json"); const sig = path.join(dir, "signoff.jsonl"); const text = JSON.stringify({ checks: [{ checkId: "x", status: "released" }] }) + "\n";
  fs.writeFileSync(file, text); assert.equal(loadSignedGate(file, sig), null);
  const record = { item: "VAL-07 gate record (final)", docDigest: sha(text), decision: "approved", decidedAt: "2026-10-24T00:00:00.000Z" }; fs.writeFileSync(sig, JSON.stringify(record) + "\n"); assert.ok(loadSignedGate(file, sig));
  fs.appendFileSync(sig, JSON.stringify({ ...record, decision: "rejected", decidedAt: "2026-10-24T01:00:00.000Z" }) + "\n"); assert.equal(loadSignedGate(file, sig), null);
  fs.writeFileSync(sig, JSON.stringify(record) + "\n"); fs.appendFileSync(file, " "); assert.equal(loadSignedGate(file, sig), null);
});

test("signed matrix manifests expand only with every exact component approval", async () => {
  const f = await fixture();
  try {
    const gate = await evaluateGate(f);
    const dir = path.join(f.dataDir, "validation");
    const bundle = prepareGateReviewBundle(gate, dir);
    const file = path.join(dir, "gate-bundle.json"), sig = path.join(dir, "release-signoffs.jsonl");
    fs.writeFileSync(file, bundle.manifestText);
    const final = { item: "VAL-07 gate record (final)", docDigest: sha(bundle.manifestText), decision: "approved", decidedAt: "2026-10-25T00:00:00Z" };
    fs.writeFileSync(sig, JSON.stringify(final) + "\n");
    assert.equal(loadSignedGate(file, sig), null);
    fs.appendFileSync(sig, bundle.components.map(c => JSON.stringify({ item: c.item, docDigest: c.docDigest, decision: "approved", decidedAt: final.decidedAt })).join("\n") + "\n");
    assert.deepEqual(loadSignedGate(file, sig), gate);
    fs.appendFileSync(sig, JSON.stringify({ item: bundle.components[0].item, docDigest: bundle.components[0].docDigest, decision: "rejected", decidedAt: "2026-10-26T00:00:00Z" }) + "\n");
    assert.equal(loadSignedGate(file, sig), null);
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

function fundingFiles(f) {
  const dir = path.join(f.dataDir, "validation");
  const snapshot = { tokenFactory: { remainingUsd: 3, reserveUsd: 1, observedAt: new Date().toISOString(), source: "user-verified-balance" }, ollama: { remainingIncludedUsd: 2, reserveUsd: .5, observedAt: new Date().toISOString(), source: "user-verified-balance" } };
  const budget = { version: 1, snapshot, snapshotDigest: sha(JSON.stringify(snapshot)), stages: { paid: { host: "ollama", cap: 1, spent: .5, reserved: .1, estimated: .7 } } };
  const budgetText = JSON.stringify(budget);
  const budgetEvidencePath = path.join(dir, `funding-budget-${sha(budgetText)}.json`);
  fs.writeFileSync(budgetEvidencePath, budgetText);
  const policy = { version: 1, source: "standing-user-directive", existingBalancesOnly: true, topUpAllowed: false, tokenFactoryReserveUsd: 1, ollamaReserveUsd: .5, noSpendAction: "withhold" };
  const policyPath = path.join(dir, "funding-policy.json"); fs.writeFileSync(policyPath, JSON.stringify(policy));
  const decision = { version: 1, policyDigest: sha(fs.readFileSync(policyPath, "utf8")), sampleNs: f.sampleNs, checkIds: [ids[1]], step: "fresh-validation", reason: "projection-exceeds-envelope", projectionUsd: { tokenFactory: 2.1, ollama: .5 }, availableUsd: { tokenFactory: 2, ollama: .9 }, budgetEvidenceDigest: sha(budgetText), budgetEvidencePath };
  const decisionPath = path.join(dir, "funding-decision.json"); fs.writeFileSync(decisionPath, JSON.stringify(decision));
  return { policy, decision, budget, policyPath, decisionPath, budgetEvidencePath, actions: { checks: [{ checkId: ids[1], action: "withhold", applied: true, basis: "funding-envelope" }] } };
}

async function verifiedFreshFixture() {
  const f = await fixture();
  const write = (name, value) => fs.writeFileSync(path.join(f.dataDir, name), JSON.stringify(value));
  const hash = value => sha(JSON.stringify(value));
  const guidance = { version: "c1", checks: { [ids[1]]: "Synthetic unchanged-rule clarification." } };
  const doc = JSON.stringify(guidance), context = "Synthetic full rule context.", item = "Codebook correction c1";
  write("validation/guidance.json", guidance); write("validation/proposal.json", { doc, context, item });
  fs.writeFileSync(path.join(f.dataDir, "decisions/release-signoff.jsonl"), JSON.stringify({ item, docDigest: sha(doc), inputDigest: hash({ doc, context, item }), decision: "approved", decidedAt: "2026-10-23T01:00:00Z", reviewer: { kind: "agent", id: `agent:${SIGNOFF_MODEL}`, modelId: SIGNOFF_MODEL } }) + "\n");
  const previousEntries = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, hn_id: String(1001 + i), quarter: Math.floor(i / 75) + 1, created_at: QUARTER_STARTS[Math.floor(i / 75)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const entries = Array.from({ length: 76 }, (_, i) => ({ n: i + 301, hn_id: String(2001 + i), quarter: Math.floor(i / 19) + 1, created_at: QUARTER_STARTS[Math.floor(i / 19)] + "T00:00:00Z", final_url: "https://example.test/" }));
  const source = { posts: entries.map(e => ({ id: e.hn_id, created_at: e.created_at })), previousEntries, previousLog: [] };
  write("validation/sampling-source.json", source); write("pipeline/fresh-projects.json", entries);
  write("pipeline/fresh-validation-sample.json", { version: 1, seed: SAMPLING_SEED, perQuarter: 19, entriesDigest: hash(entries), sourceDigest: hash({ seed: SAMPLING_SEED, perQuarter: 19, ...source }) });
  const text = "Synthetic reusable fixture evidence.", sourceHash = sha(text);
  write(`pipeline/snapshots/${sourceHash}.json`, { redactedText: text });
  const runtime = { version: "c1", byCheck: guidance.checks }, schema = buildContract(ids).jsonSchema;
  for (const entry of [...previousEntries, ...entries]) {
    const fresh = entry.n > 300;
    write(`pipeline/manifests/${entry.n}.json`, { hnId: entry.hn_id, snapshotHashesInCollectionOrder: [sourceHash], ...(fresh ? { codingCorrection: { version: "c1", checks: [ids[1]] } } : {}) });
    const spans = projectSpans(f.dataDir, entry.n), digest = spansDigest(spans);
    if (entry.n <= 30) await f.db.updateTable("pipeline_project_results").set({ snapshot_hashes_json: JSON.stringify([sourceHash]) }).where("project_n", "=", entry.n).execute();
    else {
      await f.db.insertInto("pipeline_project_results").values({ project_n: entry.n, hn_id: entry.hn_id, model_id: PINNED_MODEL, codebook_version: cb.codebookVersion, completed_at: "2026-10-24T00:00:00Z", snapshot_hashes_json: JSON.stringify([sourceHash]), coding_all_unknown: 0, prompt_hash: fresh ? hash({ schema, guidance: runtime, messages: chunkSpans(spans).map(chunk => buildCodingMessages(ids, cb, schema, chunk, runtime)) }) : "original" }).execute();
      for (const id of ids) {
        const state = fresh && entry.n <= 312 ? "pass" : "unknown", cited = state === "pass" ? '["p1-s001"]' : "[]";
        await f.db.insertInto("pipeline_check_states").values({ project_n: entry.n, check_id: id, proposed_state: state, filtered_state: state, span_ids_json: cited }).execute();
        if (fresh) await f.db.insertInto("pipeline_gold_labels").values({ project_n: entry.n, check_id: id, codebook_version: cb.codebookVersion, labeller_id: goldId, provider: "ollama", model_id: "glm-5.3-flash:cloud", reasoning: "low", filtered_state: state, span_ids_json: cited, input_digest: digest, labelled_at: "2026-10-24T00:00:00Z" }).execute();
      }
      if (fresh) await f.db.insertInto("pipeline_gold_outcomes").values({ project_n: entry.n, codebook_version: cb.codebookVersion, labeller_id: goldId, input_digest: digest, outcome: "labelled", decided_at: "2026-10-24T00:00:00Z" }).execute();
    }
  }
  f.sampleNs = previousEntries.map(e => e.n);
  const proof = Object.fromEntries([["guidancePath", "guidance.json"], ["proposalPath", "proposal.json"], ["samplingSourcePath", "sampling-source.json"]].map(([key, name]) => [key, path.join(f.dataDir, "validation", name)]));
  proof.signoffPath = path.join(f.dataDir, "decisions/release-signoff.jsonl");
  const verified = await verifyRevalidationProof({ ...f, checkIds: ids, freshNs: entries.map(e => e.n), cutoff: Date.parse("2026-10-23T00:00:00Z"), proof });
  return { ...f, revalidationProof: proof, revalidation: { sampleNs: entries.map(e => e.n), checks: verified.metrics.checks } };
}

test("verified fresh values must agree even when the affected check is withheld for funding", async () => {
  const f = await verifiedFreshFixture();
  try {
    const funding = fundingFiles(f);
    const options = { ...f, fundingFallback: { policyPath: funding.policyPath, decisionPath: funding.decisionPath }, actions: funding.actions };
    const gate = await evaluateGate(options);
    assert.equal(gate.checks[1].status, "withheld");
    assert.equal(gate.checks[1].revalidation.ac1, 1);
    assert.equal(gate.recomputedRevalidation.checks[1].ac1, 1);
    for (const mutate of [
      rows => { rows[1].ac1 = .8; }, rows => { rows[1].precision = .9; }, rows => { rows[1].goldPasses = 11; },
      rows => { rows.pop(); }, rows => { rows[1] = rows[0]; },
    ]) {
      const checks = structuredClone(f.revalidation.checks); mutate(checks);
      await assert.rejects(evaluateGate({ ...options, revalidation: { ...f.revalidation, checks } }), /supplied revalidation metrics/);
    }
    assert.equal(f.revalidation.checks[1].ac1, 1);
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

test("complete verified corrections require current independent Ultra-on decisions for every positive", async () => {
  const f = await verifiedFreshFixture();
  try {
    const contract = buildContract([ids[1]]), guidance = { version: "c1", byCheck: { [ids[1]]: "Synthetic unchanged-rule clarification." } };
    for (const n of f.sampleNs) {
      const file = path.join(f.dataDir, `pipeline/manifests/${n}.json`), manifest = JSON.parse(fs.readFileSync(file));
      manifest.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(file, JSON.stringify(manifest));
      const prompt_hash = sha(JSON.stringify({ schema: contract.jsonSchema, guidance, messages: chunkSpans(projectSpans(f.dataDir, n)).map(chunk => buildCodingMessages([ids[1]], cb, contract.jsonSchema, chunk, guidance)) }));
      await f.db.updateTable("pipeline_project_results").set({ prompt_hash }).where("project_n", "=", n).execute();
    }
    const options = { ...f, actions: { checks: [{ checkId: ids[1], action: "apply-correction", applied: true }] } };
    assert.equal((await evaluateGate(options)).checks[1].status, "missed");
    for (let n = 1; n <= 18; n++) {
      const positive = { projectN: n, checkId: ids[1], state: "pass", spans: projectSpans(f.dataDir, n), flaggedSpanIds: [] };
      await f.db.insertInto("pipeline_confirmations").values({ project_n: n, check_id: ids[1], input_digest: inputDigest(cb, positive), decision: "rejected", confirmed_state: null, reason: "Synthetic independent rejection.", span_ids_json: JSON.stringify(positive.spans.map(s => s.id)), confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-on", confirmer_kind: "agent", model_id: "nemotron-3-ultra:cloud", decided_at: "2026-10-24T01:00:00Z" }).execute();
    }
    assert.equal((await evaluateGate(options)).checks[1].status, "corrected-revalidated");
    // Project 300 has no gold outcome, but its changed positive still needs independent confirmation.
    await f.db.updateTable("pipeline_check_states").set({ filtered_state: "pass", proposed_state: "pass", span_ids_json: '["p1-s001"]' }).where("project_n", "=", 300).where("check_id", "=", ids[1]).execute();
    assert.equal((await evaluateGate(options)).checks[1].status, "missed");
    const noGoldPositive = { projectN: 300, checkId: ids[1], state: "pass", spans: projectSpans(f.dataDir, 300), flaggedSpanIds: [] };
    await f.db.insertInto("pipeline_confirmations").values({ project_n: 300, check_id: ids[1], input_digest: inputDigest(cb, noGoldPositive), decision: "rejected", confirmed_state: null, reason: "Synthetic no-gold rejection.", span_ids_json: '["p1-s001"]', confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-on", confirmer_kind: "agent", model_id: "nemotron-3-ultra:cloud", decided_at: "2026-10-24T01:00:00Z" }).execute();
    assert.equal((await evaluateGate(options)).checks[1].status, "corrected-revalidated");
    await f.db.updateTable("pipeline_confirmations").set({ confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-off" }).where("project_n", "=", 18).execute();
    assert.equal((await evaluateGate(options)).checks[1].status, "missed");
    await f.db.updateTable("pipeline_confirmations").set({ confirmer_id: "agent:ollama:nemotron-3-ultra:thinking-on", input_digest: "stale" }).where("project_n", "=", 18).execute();
    assert.equal((await evaluateGate(options)).checks[1].status, "missed");
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

test("funding stops withhold a missed check without inventing failed fresh validation", async () => {
  const f = await fixture();
  try {
    const p = fundingFiles(f);
    const options = { ...f, fundingFallback: { policyPath: p.policyPath, decisionPath: p.decisionPath }, actions: p.actions };
    let gate = await evaluateGate(options);
    assert.equal(gate.checks[1].status, "withheld");
    assert.match(gate.checks[1].reason, /funding envelope/);
    assert.equal(gate.checks[1].fundingDecisionDigest, sha(fs.readFileSync(p.decisionPath, "utf8")));
    assert.equal(gate.checks[1].revalidation, undefined);
    assert.throws(() => assertPublishable(gate, ids[1]));
    p.decision.step = "apply-correction"; fs.writeFileSync(p.decisionPath, JSON.stringify(p.decision));
    gate = await evaluateGate({ ...options, revalidation: { sampleNs: Array.from({ length: 76 }, (_, i) => i + 301), checks: [{ checkId: ids[1], goldPasses: 12, ac1: .8, precision: .9 }] } });
    assert.equal(gate.checks[1].status, "withheld");
    assert.equal(gate.checks[1].revalidation.ac1, .8);
    assert.doesNotMatch(gate.checks[1].reason, /did not pass|not estimable/);
    assert.equal(gate.checks[0].status, "released");
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

test("funding evidence rejects policy tampering, fake available funds and scope mismatches", async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      p => { p.policy.ollamaReserveUsd = 0; },
      p => { p.decision.availableUsd.ollama = .1; },
      p => { p.decision.projectionUsd = { tokenFactory: 1, ollama: .5 }; },
      p => { p.decision.sampleNs = [1]; },
      p => { p.decision.checkIds = [ids[1], ids[1]]; },
      p => { p.decision.checkIds = ["unknown-check"]; },
      p => { p.decision.checkIds = [ids[0]]; p.actions.checks[0].checkId = ids[0]; },
      p => { p.actions.checks[0].applied = false; },
      p => { p.decision.projectionUsd.ollama = -1; },
      p => { p.decision.availableUsd.unrecognisedHost = 0; },
      p => { p.decision.budgetEvidenceDigest = "f".repeat(64); },
    ]) {
      const p = fundingFiles(f); mutate(p);
      fs.writeFileSync(p.policyPath, JSON.stringify(p.policy));
      fs.writeFileSync(p.decisionPath, JSON.stringify(p.decision));
      await assert.rejects(() => evaluateGate({ ...f, fundingFallback: { policyPath: p.policyPath, decisionPath: p.decisionPath }, actions: p.actions }), /funding/);
    }
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

function rejectedCorrectionFiles(f) {
  const dir = path.join(f.dataDir, "validation");
  const item = `Codebook correction adjudication (${ids[1]})`;
  const proposal = { item, doc: "Synthetic correction proposal with complete method evidence.", context: "Synthetic unchanged prior rule.", requiresExplicitAuthorization: true };
  const record = { item, decision: "rejected", narrowsWhatPasses: false, reason: "Synthetic correction lacks approval.", docDigest: sha(proposal.doc), inputDigest: sha(JSON.stringify({ doc: proposal.doc, context: proposal.context, item })), decidedAt: "2026-10-24T00:00:00Z", reviewer: { id: `agent:${SIGNOFF_MODEL}`, kind: "agent", modelId: SIGNOFF_MODEL } };
  const proposalPath = path.join(dir, "synthetic-proposal.json"), recordPath = path.join(dir, "synthetic-rejection.json"), signoffPath = path.join(f.dataDir, "decisions", "release-signoff.jsonl");
  fs.writeFileSync(proposalPath, JSON.stringify(proposal)); fs.writeFileSync(recordPath, JSON.stringify(record)); fs.writeFileSync(signoffPath, JSON.stringify(record) + "\n");
  return { proposal, record, failure: { checkId: ids[1], proposalPath, recordPath, signoffPath }, actions: { checks: [{ checkId: ids[1], action: "withhold", applied: true, basis: "correction-approval-failed" }] } };
}

test("a signed correction rejection withholds the original miss without pretending fresh failure or funding shortfall", async () => {
  const f = await fixture();
  try {
    const p = rejectedCorrectionFiles(f);
    const options = { ...f, correctionApprovalFailures: [p.failure], actions: p.actions, revalidation: { sampleNs: Array.from({ length: 76 }, (_, i) => i + 301), checks: [{ checkId: ids[1], goldPasses: 12, ac1: .8, precision: .9 }] } };
    const gate = await evaluateGate(options);
    assert.equal(gate.checks[1].status, "withheld");
    assert.match(gate.checks[1].reason, /approval.*rejected/);
    assert.doesNotMatch(gate.checks[1].reason, /funding|did not pass/);
    assert.equal(gate.checks[1].revalidation.ac1, .8);
    assert.match(gate.checks[1].approvalFailureEvidenceDigest, /^[a-f0-9]{64}$/);
    assert.equal(gate.checks[1].correctionApplied, false);
    assert.throws(() => assertPublishable(gate, ids[1]));
    await assert.rejects(() => evaluateGate({ ...f, actions: p.actions }), /approval failure evidence/);
    const file = path.join(f.dataDir, "pipeline/manifests/1.json"), manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(file, JSON.stringify(manifest));
    await assert.rejects(() => evaluateGate(options), /must remain unapplied/);
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

test("correction rejection evidence rejects changed proposals, later approval, old ledgers and false scope", async () => {
  const f = await fixture();
  try {
    const cutoff = Date.parse("2026-10-23T00:00:00Z");
    for (const mutate of [
      p => { p.proposal.doc += " changed"; },
      p => { p.proposal.context += " changed"; },
      p => { p.record.decision = "approved"; },
      p => { p.record.decidedAt = "invalid"; },
      p => { p.failure.checkId = "unknown-check"; },
      p => { p.failure.signoffPath = path.join(f.dataDir, "decisions", "signoff.jsonl"); },
      p => { p.actions.checks[0].applied = false; },
      p => { fs.appendFileSync(p.failure.signoffPath, JSON.stringify({ ...p.record, decision: "approved", decidedAt: "2026-10-24T01:00:00Z" }) + "\n"); },
      p => { const link = path.join(f.dataDir, "validation", "linked-receipt.json"); fs.symlinkSync(p.failure.recordPath, link); p.failure.recordPath = link; },
    ]) {
      const p = rejectedCorrectionFiles(f); mutate(p);
      fs.writeFileSync(p.failure.proposalPath, JSON.stringify(p.proposal));
      if (!p.failure.recordPath.endsWith("linked-receipt.json")) fs.writeFileSync(p.failure.recordPath, JSON.stringify(p.record));
      assert.throws(() => loadCorrectionApprovalFailures([p.failure], f.dataDir, ids, p.actions.checks, cutoff), /correction approval failure/);
    }
    const p = rejectedCorrectionFiles(f);
    p.proposal.item = `Correction (${ids[0]})`; p.record.item = p.proposal.item; p.record.inputDigest = sha(JSON.stringify({doc:p.proposal.doc,context:p.proposal.context,item:p.proposal.item}));
    p.failure.checkId = ids[0]; p.actions.checks[0].checkId = ids[0];
    fs.writeFileSync(p.failure.proposalPath, JSON.stringify(p.proposal)); fs.writeFileSync(p.failure.recordPath, JSON.stringify(p.record)); fs.writeFileSync(p.failure.signoffPath, JSON.stringify(p.record) + "\n");
    await assert.rejects(() => evaluateGate({ ...f, correctionApprovalFailures: [p.failure], actions: p.actions }), /originally missed/);
  } finally { await f.db.destroy(); fs.rmSync(f.dataDir, { recursive: true, force: true }); }
});

test("same-case screening refit never replaces the raw miss; an approved companion permits limitation wording only", async () => {
  const f = await fixture();
  const audit = { n: 50, assessable: 41, notAssessable: 9, errors: 5, errorRate: 5 / 41, withinThreshold: false, action: { kind: "tightened-rescreen", remeasured: { errors: 1, errorRate: 1 / 41 }, finalStatus: "within" } };
  fs.writeFileSync(path.join(f.dataDir, "validation/screening-audit.json"), JSON.stringify(audit));
  let g = await evaluateGate(f); assert.equal(g.screeningAudit.status, "missed"); assert.equal(g.validationReady, false);
  const documentPath = path.join(f.dataDir, "validation/synthetic-action.md"); const doc = "Synthetic signed action: same-case refit is exploratory; retain selection limitation.\n"; fs.writeFileSync(documentPath, doc);
  fs.appendFileSync(path.join(f.dataDir, "decisions/signoff.jsonl"), "\n" + JSON.stringify({ item: "Screening audit action (A7.10)", docDigest: sha(doc), decision: "approved", decidedAt: "2026-10-24T00:00:00Z" }));
  g = await evaluateGate({ ...f, screeningAuditAction: { documentPath } });
  assert.equal(g.screeningAudit.status, "selection-limitation"); assert.equal(g.screeningAudit.figure.errorRate, 5 / 41); assert.equal(g.screeningAudit.action.exploratoryOnly, true); assert.equal(g.validationReady, true);
  fs.appendFileSync(documentPath, "changed"); g = await evaluateGate({ ...f, screeningAuditAction: { documentPath } }); assert.equal(g.screeningAudit.status, "missed");
  await f.db.destroy();
});
