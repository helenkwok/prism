import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareFreshSample, validateFreshSample, inventoryFreshCoding, runFreshValidation } from "../../src/pipeline/validate/fresh-validation.ts";
import { DollarBudget } from "../../src/pipeline/coding/spend-guards.ts";
import { loadGateFile, buildContract } from "../../src/pipeline/coding/contract.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildSnapshot } from "../../src/pipeline/evidence/segment.ts";

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
  const db = { selectFrom: () => ({ select: () => ({ where: () => ({ execute: async () => entries.map(e => ({ project_n: e.n, coding_all_unknown: 0 })) }) }) }) };
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
  assert.equal(JSON.stringify(report).includes("Synthetic cited evidence"), false);
  let codingCalls = 0;
  o.guidance.byCheck[contract.checkIds[0]] = "Synthetic guidance. ".repeat(5000);
  await assert.rejects(runFreshValidation({ ...o, stage: "code" }, { proof, pipeline: async () => { codingCalls++; } }), /no coding started/);
  assert.equal(codingCalls, 0);
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

test("gold locks its independent role, accounts honest no-gold and never starts another stage", async () => {
  const o = await fixture();
  const lines = [];
  let labelled = 0;
  const result = await runFreshValidation({ ...o, stage: "gold", log: line => lines.push(line), concurrency: 2 }, { proof, label: async options => {
    assert.deepEqual(options.role, { provider: "ollama", model: "glm-5.3-flash:cloud", reasoning: "low" });
    assert.equal(options.codebookVersion, "fixture");
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
