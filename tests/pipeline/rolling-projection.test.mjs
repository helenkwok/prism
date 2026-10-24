import assert from "node:assert/strict";
import { test } from "node:test";
import { measuredCostUsd } from "../../src/pipeline/coding/spend-guards.ts";
import { createRollingProjection } from "../../src/pipeline/validate/rolling-projection.ts";

const model = "nemotron-3-ultra:cloud";
const usage = (prompt = 100, output = 100) => ({ prompt_tokens: prompt, completion_tokens: output, prompt_tokens_details: { cached_tokens: null } });
function baseline(count = 2) {
  return { stage: "full-confirm", provider: "ollama", model, thinking: true, total: count + 1, completed: 1, remaining: count, cap: 7,
    completedUsage: { requests: 1, inputTokens: 100, outputTokens: 100, estimatedInputTokens: 100, spentUsd: measuredCostUsd(model, 100, 100, null) },
    remainingPromptTokens: count * 100, remainingPrompts: Array.from({ length: count }, (_, i) => ({ projectN: i + 2, checkId: "fixture", estimatedInputTokens: 100 })),
  };
}
const complete = (projectN = 2, attempts = [usage()]) => ({ projectN, checkId: "fixture", estimatedInputTokens: 100, attempts });

test("rolling estimates use every retry token and cost once per completed decision", () => {
  const tracker = createRollingProjection(baseline());
  tracker.complete(complete(2, [usage(80, 20), usage(100, 30)]));
  const out = tracker.snapshot();
  assert.equal(out.completed, 2); assert.equal(out.remaining, 1); assert.equal(out.completedUsage.requests, 3);
  assert.equal(out.completedUsage.inputTokens, 280); assert.equal(out.completedUsage.outputTokens, 150); assert.equal(out.completedUsage.estimatedInputTokens, 200);
  assert.equal(out.inputCalibrationRatio, 1.4); assert.equal(out.projectedRemainingInputTokens, 140); assert.equal(out.projectedRemainingOutputTokens, 75); assert.equal(out.withinCap, true);
  assert.throws(() => tracker.complete(complete(2)), /missing or stale/); assert.equal(tracker.snapshot().completedUsage.requests, 3);
});

test("a projection above seven stops only after retaining its completed decision", () => {
  const checkpoints = []; const tracker = createRollingProjection(baseline(), { onCheckpoint: report => checkpoints.push(report) });
  assert.throws(() => tracker.complete(complete(2, [usage(100, 2_000_000)])), { name: "ProjectedBudgetExceededError" });
  assert.equal(tracker.snapshot().completed, 2); assert.equal(tracker.snapshot().remaining, 1); assert.equal(tracker.snapshot().withinCap, false);
  assert.equal(checkpoints.length, 1); assert.ok(checkpoints[0].projectedTotalUsd > 7); assert.equal(checkpoints[0].checkpointReason, "projected-budget-exceeded");
});

test("missing usage fails closed after the completion is retained and financial uncertainty stays explicit", () => {
  const tracker = createRollingProjection(baseline());
  assert.throws(() => tracker.complete(complete(2, [undefined])), { name: "ProjectionUsageUnavailableError" });
  const out = tracker.checkpoint("final", .05);
  assert.equal(out.completed, 2); assert.equal(out.remaining, 1); assert.equal(out.completedUsage.requests, 2);
  assert.equal(out.projectedTotalUsd, null); assert.equal(out.projectionVerified, false); assert.equal(out.withinCap, false); assert.ok(out.unattributedSpentUsd > 0);
});

test("checkpoint persistence occurs every twenty new decisions and on final demand", () => {
  const reports = []; const tracker = createRollingProjection(baseline(21), { onCheckpoint: report => reports.push(report) });
  for (let n = 2; n <= 21; n++) tracker.complete(complete(n));
  assert.equal(reports.length, 1); assert.equal(reports[0].checkpointReason, "twenty-completed"); assert.equal(reports[0].remainingPrompts.length, 1);
  tracker.checkpoint("final"); assert.equal(reports.length, 2);
});
