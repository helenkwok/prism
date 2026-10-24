import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { estimateMessagesTokens } from "../../src/pipeline/coding/spend-guards.ts";
import { buildConfirmationBody, inputDigest } from "../../src/pipeline/confirm/confirm.ts";
import { approvedConfirmationTokenCap, assertConfirmationProjectionInputs, confirmationRequestDigest } from "../../src/pipeline/validate/confirmation-cap.ts";
import { ollamaClient } from "../../src/pipeline/validate/providers.ts";
import { assertFullConfirmationProjection, runApproved } from "../../src/pipeline/validate/approved-run.ts";

const codebook = loadCodebook(); const model = "nemotron-3-ultra:cloud";
function fixture() {
  const positives = Array.from({ length: 9 }, (_, i) => ({ projectN: i + 1, checkId: Object.keys(codebook.checks)[0], state: "pass", spans: [{ id: "p1-s001", text: `Synthetic ${i}: ` + "x".repeat(100_000) }], flaggedSpanIds: [] }));
  const bodies = positives.map(p => buildConfirmationBody(codebook, p, model, true));
  const scope = positives.map((p, i) => ({ projectN: p.projectN, checkId: p.checkId, estimatedTokens: estimateMessagesTokens(bodies[i].messages), inputDigest: inputDigest(codebook, p), requestDigest: confirmationRequestDigest(bodies[i]) }));
  const plan = { approved: true, approvalDate: "2026-10-24", stage: "full-confirm", model, currentCap: 20_000, proposedCap: 50_000, outputLimit: 8192, stageBudget: 5, sharedOllamaBudget: 10.75, otherRequestsKeepCap: 20_000, preserveAllCitedText: true, confirmationEnvelopeParser: false, maxInputEstimate: Math.max(...scope.map(p => p.estimatedTokens)), scope };
  const options = { plan, positives, codebook, stage: "full-confirm", model, reasoning: true };
  return { ...options, bodies, cap: approvedConfirmationTokenCap(options) };
}
const fetchReply = () => new Response(JSON.stringify({ message: { content: '{"decision":"rejected","reason":"Synthetic fixture"}' }, done: true, prompt_eval_count: 100, eval_count: 10 }));

test("exactly nine approved complete request hashes receive the larger cap", async () => {
  const f = fixture(); let calls = 0;
  const client = ollamaClient({ stage: "full-confirm", budget: 5, tokenCapForRequest: f.cap, fetchImpl: async () => { calls++; return fetchReply(); } });
  for (const body of f.bodies) { assert.equal(f.cap(body), 50_000); assert.equal((await client.request("/chat/completions", { method: "POST", body })).ok, true); }
  assert.equal(calls, 9);
  const unrelated = structuredClone(f.bodies[0]); unrelated.messages[1].content = unrelated.messages[1].content.replace("Synthetic 0", "Synthetic Z");
  assert.equal(estimateMessagesTokens(unrelated.messages), estimateMessagesTokens(f.bodies[0].messages)); assert.equal(f.cap(unrelated), 20_000);
  await assert.rejects(client.request("/chat/completions", { method: "POST", body: unrelated }), { name: "TooLargeError" }); assert.equal(calls, 9);
  const metadata = { ...f.bodies[0], tokenCap: 50_000 };
  assert.equal(f.cap(metadata), 20_000);
});

test("stale evidence, counts, approval and duplicate identities refuse the approval", () => {
  const f = fixture();
  const changed = structuredClone(f.positives); changed[0].spans[0].text += "changed";
  assert.throws(() => approvedConfirmationTokenCap({ ...f, positives: changed }), /missing or stale/);
  for (const patch of [{ approved: false }, { stageBudget: 6 }, { sharedOllamaBudget: 11 }, { preserveAllCitedText: false }, { confirmationEnvelopeParser: true }, { maxInputEstimate: f.plan.maxInputEstimate + 1 }, { scope: f.plan.scope.slice(0, 8) }, { scope: [...f.plan.scope.slice(0, 8), f.plan.scope[0]] }]) assert.throws(() => approvedConfirmationTokenCap({ ...f, plan: { ...f.plan, ...patch } }), /missing or stale/);
  const stale = structuredClone(f.plan); stale.scope[0].estimatedTokens++;
  assert.throws(() => approvedConfirmationTokenCap({ ...f, plan: stale }), /missing or stale/);
});

test("other stages and models cannot use a larger cap even with a callback", async () => {
  const f = fixture(); let calls = 0;
  for (const stage of ["gold", "spike", "second-coder"]) {
    const client = ollamaClient({ stage, tokenCapForRequest: () => 50_000, fetchImpl: async () => { calls++; return fetchReply(); } });
    await assert.rejects(client.request("/chat/completions", { method: "POST", body: f.bodies[0] }), { name: "TooLargeError" });
  }
  for (const other of ["nemotron-3-super:cloud", "glm-5.3-flash:cloud"]) {
    const client = ollamaClient({ stage: "full-confirm", tokenCapForRequest: () => 50_000, fetchImpl: async () => { calls++; return fetchReply(); } });
    await assert.rejects(client.request("/chat/completions", { method: "POST", body: { ...f.bodies[0], model: other } }), { name: "TooLargeError" });
  }
  assert.equal(calls, 0);
});

test("the provider refuses requests above 50k before HTTP and never trusts a supplied cap", async () => {
  const f = fixture(); let calls = 0;
  const client = ollamaClient({ stage: "full-confirm", tokenCapForRequest: () => 50_000, fetchImpl: async () => { calls++; return fetchReply(); } });
  const tooBig = structuredClone(f.bodies[0]); tooBig.messages[1].content = "x".repeat(204_000); tooBig.tokenCap = 100_000;
  assert.ok(estimateMessagesTokens(tooBig.messages) > 51_000);
  await assert.rejects(client.request("/chat/completions", { method: "POST", body: tooBig }), { name: "TooLargeError" });
  const defaultClient = ollamaClient({ stage: "full-confirm", tokenCap: 50_000, fetchImpl: async () => { calls++; return fetchReply(); } });
  await assert.rejects(defaultClient.request("/chat/completions", { method: "POST", body: { ...f.bodies[0], tokenCap: 50_000 } }), { name: "TooLargeError" });
  assert.equal(calls, 0);
});

test("forecast checks amounts and ledger baseline independently of the within-cap flag", () => {
  const report = { version: 1, stage: "full-confirm", provider: "ollama", model, thinking: true, total: 10, completed: 1, remaining: 9, completedUsage: { spentUsd: 0.3 }, remainingPrompts: Array.from({ length: 9 }, () => ({})), fullInputDigest: "a".repeat(64), fullRequestDigest: "b".repeat(64), projectedRemainingInputUsd: 0.4, projectedRemainingOutputUsd: 6, projectedTotalUsd: 6.7, cap: 5, withinCap: false };
  for (const withinCap of [false, true]) assert.throws(() => assertFullConfirmationProjection({ ...report, withinCap }, 0.3), { name: "ProjectedBudgetExceededError" });
  assert.throws(() => assertFullConfirmationProjection(report, 0.4), /current consistent/);
  assert.throws(() => assertFullConfirmationProjection({ ...report, withinCap: true, projectedTotalUsd: 4 }, 0.3), /current consistent/);
  const feasible = { ...report, projectedRemainingOutputUsd: 3, projectedTotalUsd: 3.7, withinCap: true };
  assert.doesNotThrow(() => assertFullConfirmationProjection(feasible, 0.3));
  for (const patch of [{ projectedTotalUsd: Infinity }, { remaining: 8 }, { thinking: false }, { cap: 6 }]) assert.throws(() => assertFullConfirmationProjection({ ...feasible, ...patch }, 0.3));
});

test("an over-cap forecast refuses the wrapper before HTTP, budget mutation or source preflight", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-cap-projection-")); const validation = path.join(dataDir, "validation"); fs.mkdirSync(validation);
  const report = { version: 1, stage: "full-confirm", provider: "ollama", model, thinking: true, total: 10, completed: 1, remaining: 9, completedUsage: { spentUsd: 0.3 }, remainingPrompts: Array.from({ length: 9 }, () => ({})), fullInputDigest: "a".repeat(64), fullRequestDigest: "b".repeat(64), projectedRemainingInputUsd: 0.4, projectedRemainingOutputUsd: 6, projectedTotalUsd: 6.7, cap: 5, withinCap: true };
  fs.writeFileSync(path.join(validation, "full-confirm-cost-projection.json"), JSON.stringify(report));
  for (const file of ["confirmation-spike.json", "confirmation-spike-review.json"]) fs.writeFileSync(path.join(validation, file), "{}");
  const ledgerPath = path.join(validation, "approved-budget-2026-10-23.json"); const ledger = JSON.stringify({ stages: { "full-confirm": { spent: 0.3 } } }); fs.writeFileSync(ledgerPath, ledger);
  const original = globalThis.fetch; const previous = process.env.PRISM_DATA_DIR; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected HTTP"); }; process.env.PRISM_DATA_DIR = dataDir;
  try {
    await assert.rejects(runApproved("full-confirm"), { name: "ProjectedBudgetExceededError" });
    assert.equal(calls, 0); assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledger);
    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false); assert.equal(fs.existsSync(path.join(dataDir, "prism.sqlite")), false);
  } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.PRISM_DATA_DIR; else process.env.PRISM_DATA_DIR = previous; }
});

test("a feasible projection remains bound to all current inputs, request settings and flags", () => {
  const f = fixture();
  const report = { total: f.positives.length,
    fullInputDigest: confirmationRequestDigest(f.positives.map(p => ({ projectN: p.projectN, checkId: p.checkId, digest: inputDigest(codebook, p) }))),
    fullRequestDigest: confirmationRequestDigest(f.positives.map(p => ({ projectN: p.projectN, checkId: p.checkId, requestDigest: confirmationRequestDigest(buildConfirmationBody(codebook, p, model, true)) }))),
  };
  assert.doesNotThrow(() => assertConfirmationProjectionInputs(report, f.positives, codebook, model, true));
  const flagged = structuredClone(f.positives); flagged[0].flaggedSpanIds = ["p1-s001"];
  assert.equal(inputDigest(codebook, flagged[0]), inputDigest(codebook, f.positives[0]));
  assert.throws(() => assertConfirmationProjectionInputs(report, flagged, codebook, model, true), /stale/);
  assert.throws(() => assertConfirmationProjectionInputs(report, f.positives, codebook, model, false), /stale/);
  assert.throws(() => assertConfirmationProjectionInputs(report, [...f.positives].reverse(), codebook, model, true), /stale/);
});
