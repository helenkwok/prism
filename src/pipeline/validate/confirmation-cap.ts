import crypto from "node:crypto";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { estimateMessagesTokens } from "../coding/spend-guards.ts";
import { buildConfirmationBody, inputDigest, type Positive } from "../confirm/confirm.ts";

export function confirmationRequestDigest(body: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function assertConfirmationProjectionInputs(report: any, positives: Positive[], codebook: Codebook, model: string, reasoning: boolean): void {
  const inputs = positives.map(p => ({ projectN: p.projectN, checkId: p.checkId, digest: inputDigest(codebook, p) }));
  const requests = positives.map(p => ({ projectN: p.projectN, checkId: p.checkId, requestDigest: confirmationRequestDigest(buildConfirmationBody(codebook, p, model, reasoning)) }));
  if (report.total !== positives.length || report.fullInputDigest !== confirmationRequestDigest(inputs) || report.fullRequestDigest !== confirmationRequestDigest(requests)) throw new Error("full confirmation projection inputs are stale");
}

/** Approval binds existing cited evidence and the complete request, never caller-provided cap fields. */
export function approvedConfirmationTokenCap({ plan, positives, codebook, stage, model, reasoning }: {
  plan: any; positives: Positive[]; codebook: Codebook; stage: string; model: string; reasoning: boolean;
}): (body: any) => number {
  const fail = () => { throw new Error("confirmation request-cap approval missing or stale"); };
  if (stage !== "full-confirm" || model !== "nemotron-3-ultra:cloud" || reasoning !== true ||
      !plan || plan.approved !== true || plan.approvalDate !== "2026-10-24" || plan.stage !== stage || plan.model !== model ||
      plan.currentCap !== 20_000 || plan.proposedCap !== 50_000 || plan.otherRequestsKeepCap !== 20_000 ||
      plan.outputLimit !== 8192 || plan.stageBudget !== 5 || plan.sharedOllamaBudget !== 10.75 ||
      plan.preserveAllCitedText !== true || plan.confirmationEnvelopeParser !== false || !Array.isArray(plan.scope) || plan.scope.length !== 9) fail();
  const allowed = new Set<string>(); const identities = new Set<string>(); let max = 0;
  for (const row of plan.scope) {
    if (!Number.isSafeInteger(row.projectN) || row.projectN <= 0 || typeof row.checkId !== "string" || !Number.isSafeInteger(row.estimatedTokens) || row.estimatedTokens <= 20_000 || row.estimatedTokens > 50_000 || !/^[a-f0-9]{64}$/.test(row.inputDigest) || !/^[a-f0-9]{64}$/.test(row.requestDigest)) fail();
    const key = `${row.projectN}:${row.checkId}`;
    const current = positives.filter(p => p.projectN === row.projectN && p.checkId === row.checkId);
    if (identities.has(key) || current.length !== 1) fail();
    identities.add(key);
    const body = buildConfirmationBody(codebook, current[0], model, reasoning);
    const count = estimateMessagesTokens(body.messages);
    const digest = confirmationRequestDigest(body);
    if (inputDigest(codebook, current[0]) !== row.inputDigest || count !== row.estimatedTokens || digest !== row.requestDigest || allowed.has(digest)) fail();
    allowed.add(digest); max = Math.max(max, count);
  }
  if (plan.maxInputEstimate !== max) fail();
  for (const positive of positives) {
    if (!identities.has(`${positive.projectN}:${positive.checkId}`) && allowed.has(confirmationRequestDigest(buildConfirmationBody(codebook, positive, model, reasoning)))) fail();
  }
  return body => body?.model === model && allowed.has(confirmationRequestDigest(body)) ? 50_000 : 20_000;
}
