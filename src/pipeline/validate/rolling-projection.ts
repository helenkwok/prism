import { cachedTokenCount, measuredCostUsd, priceOf, tokenCount } from "../coding/spend-guards.ts";
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
  let completed = saved.completed; let newCompleted = 0; let unavailable = 0; let unattributed = 0;
  const usage = { ...saved.completedUsage };
  const price = priceOf(saved.model);
  const aggregate = () => {
    const verified = unavailable === 0 && usage.estimatedInputTokens > 0 && completed > 0;
    const inputCalibrationRatio = verified ? usage.inputTokens / usage.estimatedInputTokens : null;
    const meanOutputTokensPerCompletedRequest = verified ? usage.outputTokens / completed : null;
    const projectedRemainingInputTokens = verified ? Math.ceil(remainingEstimate * inputCalibrationRatio!) : null;
    const projectedRemainingOutputTokens = verified ? Math.ceil(meanOutputTokensPerCompletedRequest! * remaining.size) : null;
    const projectedRemainingInputUsd = verified ? projectedRemainingInputTokens! * price.prompt : null;
    const projectedRemainingOutputUsd = verified ? projectedRemainingOutputTokens! * price.completion : null;
    const projectedTotalUsd = verified ? usage.spentUsd + unattributed + projectedRemainingInputUsd! + projectedRemainingOutputUsd! : null;
    return { completed, remaining: remaining.size, completedUsage: { ...usage }, remainingPromptTokens: remainingEstimate, inputCalibrationRatio, meanOutputTokensPerCompletedRequest, projectedRemainingInputTokens, projectedRemainingOutputTokens, projectedRemainingInputUsd, projectedRemainingOutputUsd, projectedTotalUsd, withinCap: verified && projectedTotalUsd! <= saved.cap, projectionVerified: verified, unmeasuredCompletedDecisions: unavailable, unattributedSpentUsd: unattributed };
  };
  const snapshot = () => ({ ...saved, ...aggregate(), remainingPrompts: [...remaining.values()] });
  const checkpoint = (reason = "checkpoint", actualSpentUsd?: number) => {
    if (actualSpentUsd !== undefined) {
      if (!nonnegative(actualSpentUsd)) throw new Error("invalid projection ledger spend");
      unattributed = Math.max(0, actualSpentUsd - usage.spentUsd);
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
        usage.requests++;
        const value = attempt as any;
        const prompt = tokenCount(value?.prompt_tokens); const output = tokenCount(value?.completion_tokens);
        if (prompt === null || output === null) { missing = true; continue; }
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
