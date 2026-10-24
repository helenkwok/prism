const DEADLINE = Date.parse("2026-10-28T12:00:00+10:30");

/** Use active processing time, not the idle time between separately approved runs. */
export function assertFinishTime(plan: any, remaining: number, now = Date.now()) {
  const elapsed = Date.parse(plan?.recentActiveEnd) - Date.parse(plan?.recentActiveStart);
  if (!Number.isSafeInteger(remaining) || remaining < 0 || plan?.remaining !== remaining || plan?.concurrency !== 2 ||
      !Number.isSafeInteger(plan?.recentCompleted) || plan.recentCompleted <= 0 || !Number.isFinite(elapsed) || elapsed <= 0 ||
      !Number.isFinite(plan?.all93ServiceTimeEstimateHours) || plan.all93ServiceTimeEstimateHours <= 0 ||
      Date.parse(plan?.deadlineUtc) !== DEADLINE || !Number.isFinite(now)) throw new Error("current active-rate deadline preflight required");
  const rate = plan.recentCompleted * 60_000 / elapsed;
  const duration = remaining * 60_000 / rate;
  const conservative = Math.max(duration, plan.all93ServiceTimeEstimateHours * 3_600_000);
  if (now + conservative > DEADLINE) {
    const error = new Error("observed confirmation rate does not fit the approved deadline");
    error.name = "ConfirmationDeadlineExceededError"; throw error;
  }
  return { decisionsPerMinute: rate, expectedRemainingHours: duration / 3_600_000,
    expectedFinishUtc: new Date(now + duration).toISOString(), conservativeFinishUtc: new Date(now + conservative).toISOString(), deadlineUtc: new Date(DEADLINE).toISOString() };
}
