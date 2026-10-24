import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRevalidationCostPlan } from "../../src/pipeline/validate/revalidation-cost-plan.ts";
import { loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import { PINNED_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
const ids = loadGateFile(resolveGatesPath()).checkIds;
function input() {
  return {
    gate: { sampleNs: Array.from({ length: 300 }, (_, i) => i + 1), checks: ids.map((checkId, i) => ({ checkId, status: i < 17 ? "missed" : "released" })) },
    costPlan: { rows: [{ host: "token-factory", role: "recode", chunkChars: 40000, deduplicate: true, projects: 300, requests: 1252, inputTokens: 20000000, outputTokens: 20000000 }] },
    ledger: { stages: { recode: { cap: 3.8, spent: 2.46, reserved: 0, estimated: 10 }, gold: { cap: 4.5, spent: 2.69, reserved: 0, estimated: 23 }, "full-confirm": { cap: 7.5, spent: 6.76, reserved: 0, estimated: 43 }, "second-coder": { cap: .75, spent: .36, reserved: 0, estimated: 2 }, spike: { cap: .5, spent: .13, reserved: 0, estimated: 1 } } },
    usage: [
      ...Array.from({ length: 1250 }, () => ({ stage: "recode", provider: "token-factory", model: PINNED_MODEL, measured: true, inputTokens: 16000, outputTokens: 720, chargedUsd: 2.46 / 1250 })),
      ...Array.from({ length: 1250 }, () => ({ stage: "gold", provider: "ollama", model: "glm-5.3-flash:cloud", measured: true, inputTokens: 16000, outputTokens: 1040, chargedUsd: 2.65 / 1250 })),
      ...Array.from({ length: 1700 }, () => ({ stage: "full-confirm", provider: "ollama", model: "nemotron-3-ultra:cloud", measured: true, inputTokens: 2353, outputTokens: 1177, chargedUsd: 6.4 / 1700 })),
      { stage: "full-confirm", provider: "ollama", model: "nemotron-3-ultra:cloud", measured: false, inputTokens: null, outputTokens: null, chargedUsd: .02 },
    ],
    stateCounts: ids.slice(0, 17).flatMap((check_id, i) => [{ check_id, filtered_state: "pass", n: i < 9 ? 61 : 60 }, { check_id, filtered_state: "unknown", n: i < 9 ? 239 : 240 }]),
    includedCreditUsd: 2.5,
  };
}

test("projection retains all missed checks and distinguishes current positives from the maximum", () => {
  const p = buildRevalidationCostPlan(input());
  assert.equal(p.missedChecks.length, 17); assert.equal(p.byCheck.length, 17); assert.equal(p.currentPositiveCount, 1029); assert.equal(p.potentialMaximumChangedPositives, 5100);
  assert.equal(p.freshProjects, 76); assert.equal(p.freshPerQuarter, 19); assert.equal(p.newSpendAuthorized, false); assert.equal(p.paidCalls, 0);
});

test("fresh validation needs primary coding and gold without fresh confirmation", () => {
  const p = buildRevalidationCostPlan(input()); const s = p.scenarios.find(s => s.id === "fresh-validation-only");
  assert.deepEqual(s.componentIds, ["fresh-primary", "fresh-gold"]);
  assert.equal(p.components.find(c => c.id === "fresh-primary").units, 76);
  assert.equal(p.components.find(c => c.id === "fresh-gold").units, 76);
  assert.equal(p.components.some(c => c.id === "fresh-confirm"), false);
});

test("measured-token pricing, recorded spend and maximum-output reservations are separate", () => {
  const p = buildRevalidationCostPlan(input()); const c = p.components.find(c => c.id === "fresh-primary");
  assert.equal(c.measuredTokenExtrapolation.inputTokens, Math.ceil(20000000 * 76 / 300));
  assert.equal(c.measuredTokenExtrapolation.outputTokens, 228000);
  assert.ok(c.measuredTokenExtrapolation.uncachedUsd > c.measuredTokenExtrapolation.conservativeRecordedSpendExtrapolationUsd);
  assert.ok(c.reservationEnvelope.usd > c.maximumOutputAtMeasuredInput.usd);
  assert.match(c.reservationEnvelope.scope, /not a guaranteed/);
});

test("conditional confirmation workloads are alternatives rather than additive costs", () => {
  const p = buildRevalidationCostPlan(input());
  for (const s of p.scenarios) assert.ok(s.componentIds.filter(id => id.startsWith("changed-confirm")).length <= 1);
  const current = p.scenarios.find(s => s.id.includes("current-positive")); const max = p.scenarios.find(s => s.id.includes("maximum-positive"));
  assert.ok(max.ollamaUncachedUsd > current.ollamaUncachedUsd); assert.ok(current.likelyIncludedCreditShortfallUsd > 0);
});

test("existing stage headroom and shared included credit never become new branch approval", () => {
  const i = input(); i.ledger.stages["new-evaluation-review"] = { cap: .5, spent: .2, reserved: 0, estimated: .2 };
  const p = buildRevalidationCostPlan(i);
  assert.ok(Math.abs(p.existing.primaryStageHeadroomUsd - 1.34) < 1e-10); assert.ok(Math.abs(p.existing.combinedOllamaHeadroomUsd - .81) < 1e-10);
  assert.equal(p.newSpendAuthorized, false); assert.match(p.assumptions.funding, /not a reusable/);
  assert.equal(p.usage["full-confirm"].unmeasuredRequests, 1);
});

test("different model histories and partial sample inputs are refused", () => {
  const i = input(); i.usage[0].model = "unapproved-fixture"; assert.throws(() => buildRevalidationCostPlan(i), /mixed-model/);
  const j = input(); j.gate.sampleNs.pop(); assert.throws(() => buildRevalidationCostPlan(j), /full sample/);
});
