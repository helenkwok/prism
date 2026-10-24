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
import { ARTCRAFT_HN_ID, GOLD_SEED, SECOND_MODEL_SEED } from "../../src/pipeline/select/draw-sample.ts";
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const book = loadCodebook();
const ids = Object.keys(book.checks).slice(0, 3);
const cb = { ...book, checks: Object.fromEntries(ids.map(id => [id, book.checks[id]])) };
const goldId = "agent:ollama:glm-5.3-flash:cloud";
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
test("revalidation requires fresh estimable evidence and correction on every sample manifest", async () => {
  const f = await fixture(); const revalidation = { sampleNs: Array.from({ length: 76 }, (_, i) => i + 301), checks: [{ checkId: ids[1], goldPasses: 12, ac1: .8, precision: .9 }] };
  const actions = { checks: [{ checkId: ids[1], action: "apply-correction", applied: true }] };
  let g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed");
  for (const n of f.sampleNs) { const file = path.join(f.dataDir, `pipeline/manifests/${n}.json`); const m = JSON.parse(fs.readFileSync(file)); m.codingCorrection = { version: "c1", checks: [ids[1]] }; fs.writeFileSync(file, JSON.stringify(m)); }
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "corrected-revalidated"); assertPublishable(g, ids[1]);
  assert.equal(g.revalidationSampleNs.length, 76); assert.equal(g.checks[1].revalidation.sampleRef, "revalidationSampleNs");
  g = await evaluateGate({ ...f, revalidation: { ...revalidation, sampleNs: [301] }, actions }); assert.equal(g.checks[1].status, "missed");
  g = await evaluateGate({ ...f, revalidation: { ...revalidation, sampleNs: [1, 2] }, actions }); assert.equal(g.checks[1].status, "missed");
  const freshPath = path.join(f.dataDir, "pipeline/fresh-projects.json");
  fs.writeFileSync(freshPath, JSON.stringify(revalidation.sampleNs.map(n => ({ n, quarter: 1 }))));
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "missed");
  fs.writeFileSync(freshPath, JSON.stringify(revalidation.sampleNs.map(n => ({ n, quarter: Math.floor((n - 301) / 19) + 1 }))));
  g = await evaluateGate({ ...f, revalidation, actions }); assert.equal(g.checks[1].status, "corrected-revalidated");
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
