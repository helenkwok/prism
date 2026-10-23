import assert from "node:assert/strict";
import { test } from "node:test";
import { deduplicateSpanText, duplicateSpanStats, formatCostPlanLine, projectCodingCostInputs, projectConfirmationUpperInputs } from "../../src/pipeline/validate/cost-plan.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import { buildCodingMessages, CODING_MAX_TOKENS } from "../../src/pipeline/run.ts";
import { estimateMessagesTokens } from "../../src/pipeline/coding/spend-guards.ts";
const codebook = loadCodebook();
const { checkIds } = loadGateFile(resolveGatesPath());
const { jsonSchema } = buildContract(checkIds);

test("exact duplicate shares use project/page denominators without conflating categories", () => {
  const spans = [{ id: "p1-s001", text: "same" }, { id: "p1-s002", text: "same" }, { id: "p2-s001", text: "same" }, { id: "p2-s002", text: "Same" }];
  const stats = duplicateSpanStats([{ spans }, { spans: [{ id: "p1-s001", text: "same" }] }]);
  assert.deepEqual(stats.denominator, { spanOccurrences: 5, textCharacters: 20 });
  assert.equal(stats.withinPage.spans, 1);
  assert.equal(stats.acrossProjectPages.spans, 1);
  assert.equal(stats.oncePerProject.spans, 2);
  assert.equal(stats.oncePerProject.spanShare, 0.4);
  assert.deepEqual(deduplicateSpanText(spans).map((s) => s.id), ["p1-s001", "p2-s002"]);
  assert.equal(spans.length, 4);
});

test("coding projection uses the production messages estimate and output reservation", () => {
  const spans = [{ id: "p1-s001", text: "fixture evidence" }];
  const measured = projectCodingCostInputs([{ spans }], codebook, checkIds, jsonSchema, 40_000, false);
  assert.equal(measured.inputTokens, estimateMessagesTokens(buildCodingMessages(checkIds, codebook, jsonSchema, spans)));
  assert.equal(measured.outputTokens, CODING_MAX_TOKENS);
  assert.equal(measured.requests, 1);
  assert.equal(measured.refusedRequests, 0);
});

test("120k comparison retains refusal under the unchanged 20k input cap", () => {
  const spans = Array.from({ length: 80 }, (_, i) => ({ id: `p1-s${i}`, text: "x".repeat(1500) }));
  const small = projectCodingCostInputs([{ spans }], codebook, checkIds, jsonSchema, 40_000, false);
  const large = projectCodingCostInputs([{ spans }], codebook, checkIds, jsonSchema, 120_000, false);
  assert.ok(small.requests > large.requests);
  assert.equal(large.refusedRequests, 1);
  assert.equal(large.allowedInputTokens, 0);
  assert.ok(large.inputTokens > 20_000);
});

test("future confirmation envelope never assumes zero cost before new labels", () => {
  const spans = [{ id: "p1-s001", text: "fixture evidence" }];
  const p = projectConfirmationUpperInputs([{ n: 1, spans }], codebook, checkIds, false);
  assert.equal(p.requests, checkIds.length);
  assert.equal(p.outputTokens, 8192 * checkIds.length);
  assert.ok(p.inputTokens > 0);
});

test("historical counts provide only an explicitly separate workload envelope", () => {
  const projects = [{ n: 1, spans: [{ id: "p1-s001", text: "fixture evidence" }] }, { n: 2, spans: [] }];
  const p = projectConfirmationUpperInputs(projects, codebook, checkIds, false, new Map([[1, [checkIds[0]]]]));
  assert.equal(p.requests, 1);
  assert.equal(p.outputTokens, 8192);
});

test("COST_PLAN output has parseable aggregate JSON without snapshot text", () => {
  const line = formatCostPlanLine({ role: "recode", inputTokens: 100, outputTokens: 200, usd: 0.1 });
  assert.match(line, /^COST_PLAN: /);
  assert.equal(JSON.parse(line.slice("COST_PLAN: ".length)).inputTokens, 100);
  assert.equal(line.includes("fixture evidence"), false);
});
