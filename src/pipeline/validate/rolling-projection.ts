import { cachedTokenCount, estimateCostUsd, measuredCostUsd, priceOf, tokenCount } from "../coding/spend-guards.ts";
import { APPROVED_CAPS } from "./approved-budget.ts";

export type CompletedProjectionInput = { projectN: number; checkId: string; estimatedInputTokens: number; attempts: unknown[] };
export type ProjectionTracker = { complete(input: CompletedProjectionInput): void; checkpoint(reason?: string, actualSpentUsd?: number): Record<string, any>; snapshot(): Record<string, any> };

/** No I/O or model calls: the caller persists already-written decisions before updating this tracker. */
export function createRollingProjection(saved: any, { onCheckpoint }: { onCheckpoint?: (report: Record<string, any>) => void } = {}): ProjectionTracker {
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!saved || saved.stage !== "full-confirm" || saved.provider !== "ollama" || saved.model !== "nemotron-3-ultra:cloud" || saved.thinking !== true || saved.cap !== APPROVED_CAPS["full-confirm"] ||
      !Number.isSafeInteger(saved.completed) || saved.completed < 0 || !Number.isSafeInteger(saved.total) || saved.total <= 0 || !Array.isArray(saved.remainingPrompts) || saved.remaining !== saved.remainingPrompts.length || saved.completed + saved.remaining !== saved.total ||
      !["requests", "inputTokens", "outputTokens", "estimatedInputTokens", "spentUsd"].every(key => nonnegative(saved.completedUsage?.[key]))) throw new Error("invalid rolling projection baseline");
  const remaining = new Map<string, any>();
  for (const row of saved.remainingPrompts) {
    const key = `${row.projectN}:${row.checkId}`;
    if (remaining.has(key) || !Number.isSafeInteger(row.estimatedInputTokens) || row.estimatedInputTokens < 0) throw new Error("invalid rolling projection inputs");
    remaining.set(key, row);
  }
  let remainingEstimate = [...remaining.values()].reduce((sum, row) => sum + row.estimatedInputTokens, 0);
  if (saved.remainingPromptTokens !== remainingEstimate) throw new Error("rolling projection estimate mismatch");
  const boundsValid = (value: any, requests: number) => value?.source === "request-reservation-upper-bound" && Number.isSafeInteger(requests) && requests >= 0 &&
    Number.isSafeInteger(value.inputTokens) && value.inputTokens >= (requests ? 1 : 0) && Number.isSafeInteger(value.outputTokens) && value.outputTokens === requests * 8192 &&
    nonnegative(value.spentUsd) && Math.abs(value.spentUsd - estimateCostUsd(saved.model, value.inputTokens, value.outputTokens)) <= 1e-12;
  const reservation = { ...(saved.reservationUsage ?? { requests: 0, inputTokens: 0, outputTokens: 0, spentUsd: 0, source: "request-reservation-upper-bound" }) };
  if (!boundsValid(reservation, reservation.requests) || (reservation.requests === 0 && reservation.inputTokens !== 0)) throw new Error("invalid reservation usage baseline");
  const oldUnavailable = saved.unboundedCompletedDecisions ?? saved.unmeasuredCompletedDecisions ?? 0;
  if (!Number.isSafeInteger(oldUnavailable) || oldUnavailable < 0 || !nonnegative(saved.unattributedSpentUsd ?? 0)) throw new Error("invalid rolling uncertainty baseline");
  let completed = saved.completed; let newCompleted = 0; let unavailable = oldUnavailable; let unattributed = saved.unattributedSpentUsd ?? 0;
  let unboundedRequests: number | null = saved.unboundedUsageRequests === undefined ? (unavailable ? null : 0) : saved.unboundedUsageRequests;
  if (unboundedRequests !== null && (!Number.isSafeInteger(unboundedRequests) || unboundedRequests < 0)) throw new Error("invalid unbounded request count");
  const usage = { ...saved.completedUsage };
  const price = priceOf(saved.model);
  const aggregate = () => {
    const effectiveCompletedUsage = { requests: usage.requests + reservation.requests, inputTokens: usage.inputTokens + reservation.inputTokens, outputTokens: usage.outputTokens + reservation.outputTokens, estimatedInputTokens: usage.estimatedInputTokens, spentUsd: usage.spentUsd + reservation.spentUsd };
    const effectiveSpentUsd = effectiveCompletedUsage.spentUsd + unattributed;
    const verified = unavailable === 0 && unboundedRequests === 0 && usage.estimatedInputTokens > 0 && completed > 0;
    const inputCalibrationRatio = verified ? effectiveCompletedUsage.inputTokens / usage.estimatedInputTokens : null;
    const meanOutputTokensPerCompletedRequest = verified ? effectiveCompletedUsage.outputTokens / completed : null;
    const projectedRemainingInputTokens = verified ? Math.ceil(remainingEstimate * inputCalibrationRatio!) : null;
    const projectedRemainingOutputTokens = verified ? Math.ceil(meanOutputTokensPerCompletedRequest! * remaining.size) : null;
    const projectedRemainingInputUsd = verified ? projectedRemainingInputTokens! * price.prompt : null;
    const projectedRemainingOutputUsd = verified ? projectedRemainingOutputTokens! * price.completion : null;
    const projectedTotalUsd = verified ? effectiveSpentUsd + projectedRemainingInputUsd! + projectedRemainingOutputUsd! : null;
    const uncalibratedInputProjectedTotalUsd = verified ? effectiveSpentUsd + remainingEstimate * price.prompt + projectedRemainingOutputUsd! : null;
    const assumption = reservation.requests ? "Remaining output uses measured output plus request-reservation upper bounds per completed decision, including retry usage; remaining input estimates use the combined measured/bounded input ratio. Bounds are conservative and are not measured usage. Point projection, not an invoice." : "Remaining output uses observed total output per completed decision, including retry usage; remaining input estimates are calibrated by observed actual/estimated input ratio. Point projection, not an invoice.";
    return { completed, remaining: remaining.size, completedUsage: { ...usage }, reservationUsage: { ...reservation }, effectiveCompletedUsage, effectiveSpentUsd, boundedUsageRequests: reservation.requests, unboundedUsageRequests: unboundedRequests, totalUsageRequests: unboundedRequests === null ? null : effectiveCompletedUsage.requests + unboundedRequests, remainingPromptTokens: remainingEstimate, inputCalibrationRatio, meanOutputTokensPerCompletedRequest, projectedRemainingInputTokens, projectedRemainingOutputTokens, projectedRemainingInputUsd, projectedRemainingOutputUsd, projectedTotalUsd, uncalibratedInputProjectedTotalUsd, assumption, withinCap: verified && projectedTotalUsd! <= saved.cap, projectionVerified: verified, unboundedCompletedDecisions: unavailable, unmeasuredCompletedDecisions: unavailable, unattributedSpentUsd: unattributed };
  };
  const snapshot = () => ({ ...saved, ...aggregate(), remainingPrompts: [...remaining.values()] });
  const checkpoint = (reason = "checkpoint", actualSpentUsd?: number) => {
    if (actualSpentUsd !== undefined) {
      if (!nonnegative(actualSpentUsd)) throw new Error("invalid projection ledger spend");
      unattributed = Math.max(unattributed, actualSpentUsd - usage.spentUsd - reservation.spentUsd, 0);
    }
    const report = { ...snapshot(), checkpointReason: reason };
    onCheckpoint?.(report); return report;
  };
  return {
    snapshot,
    checkpoint,
    complete(input) {
      const key = `${input.projectN}:${input.checkId}`; const row = remaining.get(key);
      if (!row || input.estimatedInputTokens !== row.estimatedInputTokens) throw new Error("completed projection input missing or stale");
      remaining.delete(key); remainingEstimate -= row.estimatedInputTokens; completed++; newCompleted++;
      usage.estimatedInputTokens += input.estimatedInputTokens;
      let missing = !input.attempts.length;
      for (const attempt of input.attempts) {
        const value = attempt as any;
        const prompt = tokenCount(value?.prompt_tokens); const output = tokenCount(value?.completion_tokens);
        if (prompt === null || output === null) {
          const bound = value?.reservation_bounds;
          if (!boundsValid(bound, 1)) { missing = true; if (unboundedRequests !== null) unboundedRequests++; continue; }
          reservation.requests++; reservation.inputTokens += bound.inputTokens; reservation.outputTokens += bound.outputTokens; reservation.spentUsd += bound.spentUsd;
          continue;
        }
        usage.requests++;
        usage.inputTokens += prompt; usage.outputTokens += output;
        usage.spentUsd += measuredCostUsd(saved.model, prompt, output, cachedTokenCount(value?.prompt_tokens_details?.cached_tokens, prompt));
      }
      if (missing) unavailable++;
      const current = aggregate();
      if (!current.projectionVerified || !current.withinCap) {
        checkpoint(current.projectionVerified ? "projected-budget-exceeded" : "usage-unavailable");
        const error = new Error(current.projectionVerified ? "rolling projected confirmation cost exceeds the approved cap" : "completed confirmation usage is unavailable");
        error.name = current.projectionVerified ? "ProjectedBudgetExceededError" : "ProjectionUsageUnavailableError"; throw error;
      }
      if (newCompleted % 20 === 0) checkpoint("twenty-completed");
    },
  };
}
