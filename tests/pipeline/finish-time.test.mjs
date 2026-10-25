import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFinishTime } from "../../src/pipeline/validate/finish-time.ts";

const plan = { remaining: 1607, concurrency: 2, recentCompleted: 17, recentActiveStart: "2026-10-24T10:52:35.057Z", recentActiveEnd: "2026-10-24T10:56:30.973Z", all93ServiceTimeEstimateHours: 10.909614847670252, deadlineUtc: "2026-10-28T01:30:00.000Z" };
test("active processing rate excludes idle approval gaps and fits the ACDT deadline", () => {
  const result = assertFinishTime(plan, 1607, Date.parse("2026-10-24T11:36:41.168Z"));
  assert.ok(Math.abs(result.decisionsPerMinute - 4.323572797) < 1e-8);
  assert.ok(Math.abs(result.expectedRemainingHours - 6.1947224183) < 1e-8);
  assert.equal(result.expectedFinishUtc, "2026-10-24T17:48:22.168Z");
  assert.equal(result.deadlineUtc, "2026-10-28T01:30:00.000Z");
});
test("missed deadlines and stale or malformed workloads refuse admission", () => {
  assert.throws(() => assertFinishTime(plan, 1607, Date.parse("2026-10-28T00:00:00Z")), { name: "ConfirmationDeadlineExceededError" });
  assert.throws(() => assertFinishTime(plan, 1606), /current active-rate/);
  for (const change of [{ concurrency: 3 }, { recentCompleted: 0 }, { recentActiveEnd: plan.recentActiveStart }, { deadlineUtc: "2026-10-29T01:30:00Z" }]) assert.throws(() => assertFinishTime({ ...plan, ...change }, 1607), /current active-rate/);
});
