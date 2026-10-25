// A refused complete request is evidence of an unfinished confirmation, never a decision.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Kysely } from "kysely";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { DEFAULT_TOKEN_CAP, estimateMessagesTokens } from "../coding/spend-guards.ts";
import { buildConfirmationBody, confirmationMatches, confirmedStateFor, inputDigest, readPositives, type Positive } from "../confirm/confirm.ts";
import { APPROVED_CAPS, APPROVED_OLLAMA_CAP } from "./approved-budget.ts";
import { confirmationRequestDigest } from "./confirmation-cap.ts";

export type ConfirmationRequestRefusalOptions = { documentPath: string };
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const fail = (reason: string): never => { throw new Error(`confirmation refusal: ${reason}`); };
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const MODEL = "nemotron-3-ultra:cloud";

export function currentUltraDecision(rows: any[], positive: Positive, codebook: Codebook, cutoff: number, editActorId?: string | null): boolean {
  const actor = "agent:ollama:nemotron-3-ultra";
  if (editActorId === actor || editActorId?.startsWith(actor + ":")) return false;
  return rows.some(row => row.confirmer_kind === "agent" && row.confirmer_id === actor + ":thinking-on" && Date.parse(row.decided_at) >= cutoff &&
    row.confirmed_state === confirmedStateFor(row.decision, positive.state) && row.span_ids_json === JSON.stringify(positive.spans.map(s => s.id)) &&
    confirmationMatches(row, positive, codebook, { editActorId, allowedModelIds: ["nemotron-3-ultra"] }));
}

/** Validate the retained nine approvals without requiring their old inputs to remain current. */
function registeredScope(plan: any): any[] {
  if (!plan || plan.approved !== true || plan.approvalDate !== "2026-10-24" || plan.stage !== "full-confirm" || plan.model !== MODEL ||
      plan.currentCap !== DEFAULT_TOKEN_CAP || plan.proposedCap !== 50_000 || plan.otherRequestsKeepCap !== DEFAULT_TOKEN_CAP || plan.outputLimit !== 8192 ||
      plan.stageBudget !== APPROVED_CAPS["full-confirm"] || plan.sharedOllamaBudget !== APPROVED_OLLAMA_CAP || plan.preserveAllCitedText !== true ||
      plan.confirmationEnvelopeParser !== false || !Array.isArray(plan.scope) || plan.scope.length !== 9) fail("invalid retained exact-nine approval");
  const keys = new Set<string>();
  for (const row of plan.scope) {
    const key = `${row.projectN}:${row.checkId}`;
    if (!Number.isSafeInteger(row.projectN) || row.projectN <= 0 || typeof row.checkId !== "string" || keys.has(key) ||
        !Number.isSafeInteger(row.estimatedTokens) || row.estimatedTokens <= DEFAULT_TOKEN_CAP || row.estimatedTokens > 50_000 || !digest(row.inputDigest) || !digest(row.requestDigest)) fail("invalid retained exact-nine scope");
    keys.add(key);
  }
  if (plan.maxInputEstimate !== Math.max(...plan.scope.map((row: any) => row.estimatedTokens))) fail("invalid retained exact-nine maximum");
  return plan.scope;
}

/** Reconstruct current requests privately; expose only numeric evidence and request hashes. */
export async function loadConfirmationRequestRefusals(o: {
  options: ConfirmationRequestRefusalOptions; dataDir: string; db: Kysely<any>; codebook: Codebook; sampleNs: number[]; cutoff: number;
}) {
  const root = fs.realpathSync(path.join(o.dataDir, "validation"));
  const read = (file: unknown) => {
    if (typeof file !== "string") return fail("explicit retained JSON path required");
    const absolute = path.resolve(file), real = fs.realpathSync(absolute);
    if (path.dirname(real) !== root || path.extname(real) !== ".json" || fs.lstatSync(absolute).isSymbolicLink()) fail("retained document escapes validation");
    const text = fs.readFileSync(real, "utf8"); return { text, value: JSON.parse(text), real };
  };
  const document = read(o.options.documentPath), proof = document.value;
  if (!proof || proof.version !== 1 || Object.keys(proof).sort().join(",") !== "checkIds,exceptionsDigest,exceptionsPath,requests,version" ||
      !Array.isArray(proof.checkIds) || !proof.checkIds.length || new Set(proof.checkIds).size !== proof.checkIds.length ||
      proof.checkIds.some((id: unknown) => typeof id !== "string" || !Object.hasOwn(o.codebook.checks, id)) || !Array.isArray(proof.requests) || !proof.requests.length) fail("invalid refusal proof shape or check scope");
  const exceptions = read(proof.exceptionsPath);
  if (path.basename(exceptions.real) !== "confirmation-request-cap-plan.json" || !digest(proof.exceptionsDigest) || sha(exceptions.text) !== proof.exceptionsDigest) fail("retained exact-nine digest differs");
  const nine = registeredScope(exceptions.value);
  // The permissive legacy reader is not an acceptance coverage proof by itself.
  await o.db.selectFrom("pipeline_injection_flags").select("project_n").limit(1).execute();
  const primary = await o.db.selectFrom("pipeline_check_states").select(["project_n", "check_id", "filtered_state"]).where("project_n", "in", o.sampleNs).execute();
  if (o.sampleNs.some(n => Object.keys(o.codebook.checks).some(id => !primary.some(row => row.project_n === n && row.check_id === id && ["pass", "fail", "unknown", "claimed"].includes(row.filtered_state))))) fail("current primary check coverage is incomplete");
  const current = await readPositives(o.db, o.dataDir, { sampleNs: o.sampleNs, codebookVersion: o.codebook.codebookVersion });
  if (current.awaitingGold.length) fail("current positive inventory is incomplete");
  const decisions = await o.db.selectFrom("pipeline_confirmations").selectAll().where("project_n", "in", o.sampleNs).execute();
  const edits = await o.db.selectFrom("pipeline_edits").selectAll().where("project_n", "in", o.sampleNs).execute();
  const editActor = (p: Positive) => edits.filter(row => row.project_n === p.projectN && row.check_id === p.checkId)
    .sort((a, b) => String(b.edited_at).localeCompare(String(a.edited_at)))[0]?.actor_id;
  const pending = current.positives.filter(p => !currentUltraDecision(decisions, p, o.codebook, o.cutoff, editActor(p)));
  const requests = pending.flatMap(p => {
    const body = buildConfirmationBody(o.codebook, p, MODEL, true), inputTokens = estimateMessagesTokens(body.messages);
    const row = { projectN: p.projectN, checkId: p.checkId, inputDigest: inputDigest(o.codebook, p), requestDigest: confirmationRequestDigest(body), inputTokens, tokenCap: DEFAULT_TOKEN_CAP, model: MODEL, thinking: true };
    const exception = nine.some((approved: any) => approved.projectN === p.projectN && approved.checkId === p.checkId && approved.inputDigest === row.inputDigest && approved.requestDigest === row.requestDigest && approved.estimatedTokens === inputTokens);
    return inputTokens > DEFAULT_TOKEN_CAP && (!exception || inputTokens > 50_000) ? [row] : [];
  });
  const sort = (rows: any[]) => [...rows].sort((a, b) => a.projectN - b.projectN || a.checkId.localeCompare(b.checkId));
  if (!isDeepStrictEqual(sort(proof.requests), sort(requests)) || !isDeepStrictEqual([...proof.checkIds].sort(), [...new Set(requests.map(r => r.checkId))].sort())) fail("refusals differ from complete current non-exempt oversized inventory");
  return { evidence: { proofDigest: sha(document.text), exceptionsDigest: proof.exceptionsDigest, checkIds: proof.checkIds as string[], requests, refused: requests.length, pending: pending.length },
    positives: current.positives, pending, validCached: current.positives.length - pending.length };
}

/** Signed withholding may explain unfinished work, never turn it into cached success. */
export async function verifySignedConfirmationRefusalCoverage(o: {
  gatePath: string; signoffPath: string; options: ConfirmationRequestRefusalOptions; dataDir: string; db: Kysely<any>; codebook: Codebook; sampleNs: number[];
}) {
  const { loadSignedGate } = await import("./gate.ts");
  const gate = loadSignedGate(o.gatePath, o.signoffPath), cutoff = Date.parse(gate?.approvalEvidence?.recoveryCutoffUpperBound);
  if (!gate || !Number.isFinite(cutoff) || !isDeepStrictEqual(gate.sampleNs, [...o.sampleNs].sort((a, b) => a - b))) fail("signed final gate with matching inherited approval is required");
  const current = await loadConfirmationRequestRefusals({ ...o, cutoff });
  if (!isDeepStrictEqual(gate.confirmationRequestRefusals, current.evidence) || current.evidence.checkIds.some(id => {
    const check = gate.checks.find((c: any) => c.checkId === id);
    return check?.status !== "withheld" || check.confirmationRefusalProofDigest !== current.evidence.proofDigest;
  })) fail("signed withholding does not bind current refusal evidence");
  if (current.pending.some(p => !current.evidence.checkIds.includes(p.checkId))) fail("an unconfirmed positive lies outside the signed refusal scope");
  const withheldPositives = current.positives.filter(p => current.evidence.checkIds.includes(p.checkId)).length;
  return {
    accounting: { stage: "full-confirm", total: current.positives.length, valid: current.validCached, cached: current.validCached, accounted: current.validCached,
      attempted: 0, failed: 0, remaining: current.pending.length, withheld: current.pending.length, complete: false, ok: false, reason: "required-requests-refused-by-unchanged-token-guard" },
    scope: { total: current.positives.length, validCached: current.validCached, withheldPositives, withheldUnconfirmed: current.pending.length,
      requiredOutsideWithheld: current.positives.length - withheldPositives, unconfirmedOutsideWithheld: 0, modelCalls: 0, completeForPublishedScope: true, fullConfirmationComplete: false,
      refusalProofDigest: current.evidence.proofDigest, checkIds: current.evidence.checkIds },
  };
}
