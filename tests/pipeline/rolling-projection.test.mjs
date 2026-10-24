import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCostUsd, measuredCostUsd } from "../../src/pipeline/coding/spend-guards.ts";
import { createRollingProjection } from "../../src/pipeline/validate/rolling-projection.ts";
import { APPROVED_CAPS } from "../../src/pipeline/validate/approved-budget.ts";

const model = "nemotron-3-ultra:cloud";
const usage = (prompt = 100, output = 100) => ({ prompt_tokens: prompt, completion_tokens: output, prompt_tokens_details: { cached_tokens: null } });
function baseline(count = 2) {
  return { stage: "full-confirm", provider: "ollama", model, thinking: true, total: count + 1, completed: 1, remaining: count, cap: APPROVED_CAPS["full-confirm"],
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

test("a projection above the approved cap stops only after retaining its completed decision", () => {
  const checkpoints = []; const tracker = createRollingProjection(baseline(), { onCheckpoint: report => checkpoints.push(report) });
  assert.throws(() => tracker.complete(complete(2, [usage(100, 2_000_000)])), { name: "ProjectedBudgetExceededError" });
  assert.equal(tracker.snapshot().completed, 2); assert.equal(tracker.snapshot().remaining, 1); assert.equal(tracker.snapshot().withinCap, false);
  assert.equal(checkpoints.length, 1); assert.ok(checkpoints[0].projectedTotalUsd > APPROVED_CAPS["full-confirm"]); assert.equal(checkpoints[0].checkpointReason, "projected-budget-exceeded");
});

test("missing usage fails closed after the completion is retained and financial uncertainty stays explicit", () => {
  const tracker = createRollingProjection(baseline());
  assert.throws(() => tracker.complete(complete(2, [undefined])), { name: "ProjectionUsageUnavailableError" });
  const out = tracker.checkpoint("final", .05);
  assert.equal(out.completed, 2); assert.equal(out.remaining, 1); assert.equal(out.completedUsage.requests, 1);
  assert.equal(out.unboundedUsageRequests, 1); assert.equal(out.totalUsageRequests, 2);
  assert.equal(out.projectedTotalUsd, null); assert.equal(out.projectionVerified, false); assert.equal(out.withinCap, false); assert.ok(out.unattributedSpentUsd > 0);
});

const bounded = (inputTokens = 12654, outputTokens = 8192) => ({ prompt_tokens: null, completion_tokens: null, reservation_bounds: { inputTokens, outputTokens, spentUsd: estimateCostUsd(model, inputTokens, outputTokens), source: "request-reservation-upper-bound" } });

test("reservation bounds stay separate from measured usage and survive restart without double charge", () => {
  const tracker = createRollingProjection(baseline()); tracker.complete(complete(2, [bounded()]));
  const first = tracker.snapshot();
  assert.equal(first.completedUsage.requests, 1); assert.equal(first.completedUsage.inputTokens, 100); assert.equal(first.completedUsage.outputTokens, 100);
  assert.equal(first.reservationUsage.requests, 1); assert.equal(first.reservationUsage.inputTokens, 12654); assert.equal(first.reservationUsage.outputTokens, 8192);
  assert.equal(first.reservationUsage.spentUsd, .0258414); assert.equal(first.reservationUsage.source, "request-reservation-upper-bound");
  assert.equal(first.boundedUsageRequests, 1); assert.equal(first.unboundedCompletedDecisions, 0); assert.equal(first.effectiveCompletedUsage.outputTokens, 8292);
  assert.ok(first.assumption.includes("not measured usage"));
  const saved = tracker.checkpoint("final", first.completedUsage.spentUsd + first.reservationUsage.spentUsd);
  assert.equal(saved.unattributedSpentUsd, 0); assert.equal(saved.effectiveSpentUsd, saved.completedUsage.spentUsd + .0258414);
  const restarted = createRollingProjection(saved).snapshot();
  assert.deepEqual(restarted.reservationUsage, saved.reservationUsage); assert.equal(restarted.effectiveSpentUsd, saved.effectiveSpentUsd); assert.equal(restarted.projectionVerified, true);
});

test("malformed bounds remain unavailable and unresolved uncertainty survives restart", () => {
  for (const patch of [{ inputTokens: 1.5 }, { inputTokens: -1 }, { outputTokens: 8191 }, { spentUsd: 0 }, { source: "guessed-mean" }]) {
    const tracker = createRollingProjection(baseline()); const attempt = bounded(); Object.assign(attempt.reservation_bounds, patch);
    assert.throws(() => tracker.complete(complete(2, [attempt])), { name: "ProjectionUsageUnavailableError" });
    const saved = tracker.checkpoint("final", .05); const restarted = createRollingProjection(saved);
    assert.equal(restarted.snapshot().projectionVerified, false); assert.equal(restarted.snapshot().unboundedCompletedDecisions, 1); assert.equal(restarted.snapshot().projectedTotalUsd, null);
    assert.equal(restarted.checkpoint("final", 0).unattributedSpentUsd, saved.unattributedSpentUsd);
  }
});

test("a full reservation dominates all admissible measured token costs", () => {
  const bound = bounded().reservation_bounds;
  for (const prompt of [0, 100, bound.inputTokens]) for (const output of [0, 100, bound.outputTokens]) for (const cached of [0, prompt]) assert.ok(measuredCostUsd(model, prompt, output, cached) <= bound.spentUsd + 1e-12);
});

test("checkpoint persistence occurs every twenty new decisions and on final demand", () => {
  const reports = []; const tracker = createRollingProjection(baseline(21), { onCheckpoint: report => reports.push(report) });
  for (let n = 2; n <= 21; n++) tracker.complete(complete(n));
  assert.equal(reports.length, 1); assert.equal(reports[0].checkpointReason, "twenty-completed"); assert.equal(reports[0].remainingPrompts.length, 1);
  tracker.checkpoint("final"); assert.equal(reports.length, 2);
});

test("snapshots refresh stale uncalibrated totals and baseline-specific assumptions", () => {
  const tracker = createRollingProjection({ ...baseline(), uncalibratedInputProjectedTotalUsd: 999, assumption: "stale all76 assumption" });
  tracker.complete(complete(2, [usage(50, 200)]));
  const out = tracker.snapshot();
  assert.equal(out.uncalibratedInputProjectedTotalUsd, out.completedUsage.spentUsd + 100 * 0.0000001 + out.projectedRemainingOutputUsd);
  assert.notEqual(out.uncalibratedInputProjectedTotalUsd, out.projectedTotalUsd);
  assert.ok(out.assumption.includes("per completed decision, including retry usage")); assert.ok(!out.assumption.includes("76"));
  const final = tracker.checkpoint("final", .002);
  assert.equal(final.uncalibratedInputProjectedTotalUsd, .002 + 100 * 0.0000001 + final.projectedRemainingOutputUsd);
  assert.equal(final.assumption, out.assumption);
});
