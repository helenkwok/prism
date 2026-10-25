import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareFreshSample, validateFreshSample, inventoryFreshCoding, inventoryFreshGold, runFreshValidation } from "../../src/pipeline/validate/fresh-validation.ts";
import { DollarBudget } from "../../src/pipeline/coding/spend-guards.ts";
import { loadGateFile, buildContract } from "../../src/pipeline/coding/contract.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildSnapshot } from "../../src/pipeline/evidence/segment.ts";
import { GOLD_SEED, ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";
import { sortPilotCandidates } from "../../src/pipeline/select/pilot-draw.ts";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureGoldSchema } from "../../src/pipeline/validate/gold.ts";

const starts = ["2025-09-02", "2025-12-02", "2026-03-02", "2026-06-02"];
const previousEntries = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, hn_id: `prior-${i}`, entry_url: `https://prior-${i}.test/` }));
const previousLog = previousEntries.map(e => ({ id: e.hn_id }));
const posts = starts.flatMap((date, q) => Array.from({ length: 21 }, (_, i) => ({ id: `fresh-${q}-${i}`, title: "Synthetic AI project", url: `https://fresh-${q}-${i}.test/`, created_at: `${date}T12:00:00Z` })));
const screeners = {
  screen1: async () => ({ include: true, reasonCode: null }),
  preflight: async p => ({ entry_url: p.url, final_url: p.url, boundary: {}, type_class: "own-domain", page_text: "Synthetic AI project evidence. ".repeat(30), preflight: { robots_blocked: false, boundary_ok: true } }),
  screen2: async () => ({ include: true, reasonCode: null }),
};
const budget = cap => new DollarBudget(cap, { parent: new DollarBudget(10) });
const quiet = () => {};
const codebook = loadCodebook(path.resolve("codebook.md"));
const contract = buildContract(loadGateFile(path.resolve("vendor/ai-output-to-value/schemas/v1/decision-gates.json")).checkIds);

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-fresh-"));
  const entries = await prepareFreshSample({ dataDir, posts, previousEntries, previousLog, screeners, budget: budget(.5), log: quiet });
  const goldBudget = budget(1.1);
  const db = { selectFrom: () => ({ select: () => ({ where: () => ({ execute: async () => entries.map(e => ({ project_n: e.n, coding_all_unknown: 0 })) }) }) }), updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => {} }) }) }) };
  const o = { dataDir, cacheDir: path.join(dataDir, "pipeline/cache"), db, entries, previousEntries, previousLog, codebook, contract, codebookVersion: "fixture", guidance: { version: "fixture-c1", byCheck: { [contract.checkIds[0]]: "Synthetic clarification." } }, priorApprovalProofPath: "synthetic-proof.json", assertGuidanceApproved: () => {}, coding: { apiKeys: { nebius: "fixture", github: "fixture", tavily: "" }, budget: budget(1) }, gold: { budget: goldBudget, client: { dollarBudget: goldBudget, request: async () => { throw new Error("unexpected HTTP"); } } }, log: quiet };
  fs.mkdirSync(path.join(dataDir, "pipeline/snapshots"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "pipeline/manifests"), { recursive: true });
  const snap = buildSnapshot("https://synthetic.example.test/", "2026-01-01T00:00:00Z", "Synthetic cited evidence.");
  fs.writeFileSync(path.join(dataDir, "pipeline/snapshots", `${snap.snapshotHash}.json`), JSON.stringify({ ...snap, redactedText: "Synthetic cited evidence." }));
  for (const e of entries) fs.writeFileSync(path.join(dataDir, "pipeline/manifests", `${e.n}.json`), JSON.stringify({ hnId: e.hn_id, snapshotHashesInCollectionOrder: [snap.snapshotHash] }));
  return o;
}
const proof = () => ({ proofDigest: "synthetic" });

test("continuation preserves all 76 and 19 per quarter; resume performs no screening", async () => {
  const o = await fixture();
  assert.equal(o.entries.length, 76);
  for (const q of [1, 2, 3, 4]) assert.equal(o.entries.filter(e => e.quarter === q).length, 19);
  assert.deepEqual(o.entries.map(e => e.n), Array.from({ length: 76 }, (_, i) => i + 301));
  const resumed = await prepareFreshSample({ ...o, posts, screeners: { ...screeners, screen1: async () => { throw new Error("must not screen"); } }, budget: budget(.5) });
  assert.deepEqual(resumed, o.entries);
  await assert.rejects(prepareFreshSample({ ...o, posts: posts.slice(1), screeners, budget: budget(.5) }), /provenance changed/);
  assert.throws(() => validateFreshSample(o.entries.slice(1), previousEntries, previousLog), /complete disjoint/);
});

test("screening budget failure never writes a final partial sample", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-fresh-stop-"));
  let calls = 0;
  const lines = [];
  const bounded = { ...screeners, screen1: async () => { if (++calls === 5) { const error = new Error("budget"); error.name = "BudgetExceededError"; throw error; } return { include: true, reasonCode: null }; } };
  await assert.rejects(prepareFreshSample({ dataDir, posts, previousEntries, previousLog, screeners: bounded, budget: budget(.5), log: line => lines.push(line) }), /budget/);
  assert.equal(fs.existsSync(path.join(dataDir, "pipeline/fresh-projects.json")), false);
  const accounting = JSON.parse(lines.find(line => line.startsWith("ACCOUNTING: ")).slice(12));
  assert.equal(accounting.complete, false);
  assert.equal(accounting.success, 0);
  assert.ok(lines.some(line => line.startsWith("BUDGET:")));
});

test("inventory preserves complete prompt bodies and refuses over-cap coding before its runner", async () => {
  const o = await fixture();
  const report = inventoryFreshCoding(o);
  assert.equal(report.chunks, 76);
  assert.equal(report.overCap, 0);
  assert.ok(report.requests.every(r => r.retryInputTokens >= r.inputTokens && r.maximumInputTokens === r.retryInputTokens));
  assert.ok(report.requests.every(r => r.requestDigest !== r.retryRequestDigest));
  assert.equal(JSON.stringify(report).includes("Synthetic cited evidence"), false);
  let codingCalls = 0;
  o.guidance.byCheck[contract.checkIds[0]] = "Synthetic guidance. ".repeat(5000);
  await assert.rejects(runFreshValidation({ ...o, stage: "code" }, { proof, pipeline: async () => { codingCalls++; } }), /complete numbered span|no coding started/);
  assert.equal(codingCalls, 0);
});

test("complete initial and citation-regeneration inventories subdivide without losing evidence", async () => {
  const o = await fixture();
  const dir = path.join(o.dataDir, "pipeline/snapshots");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  snapshot.redactedText = Array.from({ length: 2400 }, (_, i) => `Synthetic evidence ${i}.`).join("\n\n");
  fs.writeFileSync(file, JSON.stringify(snapshot));
  const report = inventoryFreshCoding(o);
  assert.ok(report.chunks > 76);
  assert.equal(report.overCap, 0);
  assert.ok(report.maxInputTokens <= 20000);
  assert.ok(report.requests.every(r => r.retryInputTokens >= r.inputTokens));
  const gold = inventoryFreshGold(o);
  assert.ok(gold.chunks > 76);
  assert.equal(gold.overCap, 0);
  assert.ok(gold.maxInputTokens <= 20000);
  assert.ok(gold.requests.every(r => r.requestDigests.length === 4));
});

test("coding and collect stages use retained proof, free collection, no second coder and one shared meter", async () => {
  const o = await fixture();
  let calls = 0;
  for (const stage of ["collect", "code"]) {
    const result = await runFreshValidation({ ...o, stage }, { proof, pipeline: async options => {
      calls++;
      assert.equal(options.collectOnly, stage === "collect");
      assert.equal(options.overrides.useTavily, false);
      assert.equal(options.overrides.tfBudget, o.coding.budget);
      assert.equal(options.priorApprovalProofPath, o.priorApprovalProofPath);
      assert.equal(options.secondCoderIds.size, 0);
      assert.deepEqual(options.guidance, o.guidance);
      return { ok: true, totalProjects: 76, succeeded: 76, failed: 0 };
    } });
    assert.equal(result.ok, true);
  }
  assert.equal(calls, 2);
  await assert.rejects(runFreshValidation({ ...o, stage: "code", assertGuidanceApproved: () => { throw new Error("unsigned guidance"); } }, { proof, pipeline: async () => { calls++; } }), /unsigned guidance/);
  assert.equal(calls, 2);
});

test("a shared reserve envelope supersedes planning ceilings while standalone budgets stay bounded", async () => {
  const o = await fixture();
  const parent = new DollarBudget(2);
  const hostBound = new DollarBudget(1.5, { parent });
  let calls = 0;
  const pipeline = async options => { calls++; assert.equal(options.overrides.tfBudget, hostBound); return { ok: true, outcomes: [] }; };
  assert.equal((await runFreshValidation({ ...o, stage: "code", coding: { ...o.coding, budget: hostBound } }, { proof, pipeline })).ok, true);
  await assert.rejects(runFreshValidation({ ...o, stage: "code", coding: { ...o.coding, budget: new DollarBudget(1.5) } }, { proof, pipeline }), /bounded budget/);
  assert.equal(calls, 1); assert.equal(parent.spent, 0);
});

test("gold locks its independent role, accounts honest no-gold and never starts another stage", async () => {
  const o = await fixture();
  const lines = [];
  let labelled = 0;
  const result = await runFreshValidation({ ...o, stage: "gold", log: line => lines.push(line), concurrency: 2 }, { proof, label: async options => {
    assert.deepEqual(options.role, { provider: "ollama", model: "glm-5.3-flash:cloud", reasoning: "low" });
    assert.equal(options.codebookVersion, "fixture");
    assert.equal(options.boundedChunks, true);
    return { outcome: ++labelled === 1 ? "no-gold" : "labelled" };
  } });
  assert.equal(result.complete, true);
  assert.equal(result.accounted, 76);
  assert.equal(result.labelled, 75);
  assert.equal(result.noGold, 1);
  assert.equal(result.remaining, 0);
  assert.ok(lines.some(line => line.startsWith("ACCOUNTING:")));
});

test("fresh coding never counts retry-exhausted or partially invalid coding as success", async () => {
  for (const partial of [false, true]) {
    const o = await fixture();
    if (!partial) o.db = { selectFrom: () => ({ select: () => ({ where: () => ({ execute: async () => o.entries.map((e, i) => ({ project_n: e.n, coding_all_unknown: i === 0 ? 1 : 0 })) }) }) }) };
    const result = await runFreshValidation({ ...o, stage: "code" }, { proof, pipeline: async () => ({ ok: true, totalProjects: 76, succeeded: 76, failed: 0, outcomes: o.entries.map((e, i) => ({ n: e.n, status: "ok", codingFailedChunks: partial && i === 0 ? 1 : 0 })) }) });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 1);
    assert.equal(result.succeeded, 75);
    assert.equal(result.outcomes.filter(r => r.status === "failed").length, 1);
  }
});

test("gold budget stop drains two active projects and preserves the successful in-flight result", async () => {
  const o = await fixture();
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const promise = runFreshValidation({ ...o, stage: "gold", concurrency: 2 }, { proof, label: async () => {
    const i = ++calls;
    if (i === 1) { await Promise.resolve(); const error = new Error("budget"); error.name = "BudgetExceededError"; throw error; }
    await held;
    return { outcome: "labelled" };
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  let finished = false; promise.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  const result = await promise;
  assert.equal(calls, 2);
  assert.equal(result.labelled, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 75);
  assert.equal(result.complete, false);
  assert.equal(result.ok, false);
});

test("fresh gold allows exactly two no-gold outcomes in the first twenty", async () => {
  const o = await fixture(); const lines = []; let calls = 0;
  const result = await runFreshValidation({ ...o, stage: "gold", concurrency: 2, log: line => lines.push(line) }, { proof, label: async () => ({ outcome: ++calls <= 2 ? "no-gold" : "labelled" }) });
  assert.equal(calls, 76); assert.equal(result.complete, true); assert.equal(result.noGold, 2);
  const gate = JSON.parse(lines.find(line => line.startsWith("GOLD_GATE:")).slice(10));
  assert.deepEqual(gate, { projects: 20, failed: 2, rate: .1, threshold: .1, passed: true });
});

test("fresh gold stops after twenty accounted outcomes when three have no gold", async () => {
  const o = await fixture(); const lines = []; let calls = 0;
  const result = await runFreshValidation({ ...o, stage: "gold", concurrency: 2, log: line => lines.push(line) }, { proof, label: async () => ({ outcome: ++calls <= 3 ? "no-gold" : "labelled" }) });
  assert.equal(calls, 20); assert.equal(result.accounted, 20); assert.equal(result.noGold, 3); assert.equal(result.remaining, 56); assert.equal(result.ok, false); assert.equal(result.complete, false);
  const gate = JSON.parse(lines.find(line => line.startsWith("GOLD_GATE:")).slice(10)); assert.deepEqual(gate, { projects: 20, failed: 3, rate: .15, threshold: .1, passed: false });
  const retained = JSON.parse(fs.readFileSync(path.join(o.dataDir, "validation/fresh-gold-accounting.json"), "utf8")); assert.equal(retained.accounted, 20); assert.equal(retained.noGold, 3);
});

test("the twenty-first gold project waits for the entire seeded prefix", async () => {
  const o = await fixture(); let calls = 0, release;
  const hold = new Promise(resolve => { release = resolve; });
  const ordered = sortPilotCandidates(o.entries.map(e => ({ ...e, id: String(e.hn_id) })), GOLD_SEED);
  const promise = runFreshValidation({ ...o, stage: "gold", concurrency: 2 }, { proof, label: async options => { calls++; if (options.projectN === ordered[19].n) await hold; return { outcome: "labelled" }; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 20); release(); assert.equal((await promise).accounted, 76);
});

test("zero-span coding remains accounted as explicit missing evidence", async () => {
  const o = await fixture(); const n = o.entries[0].n; const lines = [], flagged = [];
  fs.writeFileSync(path.join(o.dataDir, "pipeline/manifests", `${n}.json`), JSON.stringify({ hnId: o.entries[0].hn_id, snapshotHashesInCollectionOrder: [] }));
  o.db = { selectFrom: () => ({ select: () => ({ where: () => ({ execute: async () => o.entries.map(e => ({ project_n: e.n, coding_all_unknown: e.n === n ? 1 : 0, missing_data: 0 })) }) }) }), updateTable: () => ({ set: fields => { assert.equal(fields.missing_data, 1); return { where: (_key, _operator, projectN) => ({ execute: async () => { flagged.push(projectN); } }) }; } }) };
  const result = await runFreshValidation({ ...o, stage: "code", log: line => lines.push(line) }, { proof, pipeline: async () => ({ ok: true, totalProjects: 76, succeeded: 76, failed: 0, outcomes: o.entries.map(e => ({ n: e.n, status: "ok", codingFailedChunks: 0 })) }) });
  assert.equal(result.ok, true); assert.equal(result.succeeded, 76); assert.equal(result.failed, 0); assert.equal(result.noEvidence, 1); assert.deepEqual(result.noEvidenceProjects, [n]); assert.deepEqual(flagged, [n]);
  const accounting = JSON.parse(lines.find(line => line.startsWith("ACCOUNTING:")).slice(12)); assert.equal(accounting.noEvidence, 1); assert.equal(accounting.totalProjects, 76);
});

test("the worked case has a durable excluded outcome and no label request", async () => {
  const o = await fixture(); const n = o.entries[0].n; o.entries[0].hn_id = ARTCRAFT_HN_ID;
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) }); await ensureGoldSchema(db); let calls = 0;
  const result = await runFreshValidation({ ...o, db, stage: "gold", concurrency: 2 }, { proof, label: async options => { calls++; assert.notEqual(options.projectN, n); return { outcome: "labelled" }; } });
  assert.equal(calls, 75); assert.equal(result.accounted, 76); assert.equal(result.excludedA3, 1); assert.equal(result.noGold, 0); assert.equal(result.goldGate.projects, 20); assert.equal(result.complete, true);
  const row = await db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "=", n).executeTakeFirst(); assert.equal(row.outcome, "excluded-a3");
  await db.destroy();
});
