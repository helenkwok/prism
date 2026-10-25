// One retained own-source citation, judged without changing the labelled sample.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../../app/server/db.ts";
import { loadCodebook, type Codebook } from "../coding/codebook-prompt.ts";
import { buildConfirmationBody, confirmWithModel, projectSpans, type Positive } from "../confirm/confirm.ts";
import { withinBoundary } from "../evidence/boundary.ts";
import { assertA9Signed } from "../signoff/a9.ts";
import { estimateCostUsd, estimateMessagesTokens, reservationInputTokens, DEFAULT_TOKEN_CAP } from "../coding/spend-guards.ts";
import { openApprovedBudget } from "./approved-budget.ts";
import { ollamaClient, ollamaRequestBody, formatOllamaSummary } from "./providers.ts";

const MODEL = "nemotron-3-ultra:cloud";
const ATTEMPTS = 3;
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const irrelevantFooter = (text: string) => text.length >= 20 && text.length <= 240 && /copyright|all rights reserved|©/i.test(text) && !/\b(?:test\w*|eval\w*|fail\w*|benchmark\w*|accuracy|risk\w*|safety|audit\w*|experiment\w*|reliab\w*|ignore|instructions?|system|assistant|prompt|json|confirm|reject)\b/i.test(text);

export function loadProbeInput(dataDir: string, file: string): Positive {
  const input = JSON.parse(fs.readFileSync(file, "utf8"));
  if (input.synthetic !== false || !Number.isSafeInteger(input.projectN) || input.projectN <= 0 || input.checkId !== "failure-modes-tested" || input.state !== "pass" || input.spans?.length !== 1 || !/^[a-f0-9]{64}$/.test(input.snapshotHash)) throw new Error("genuine probe input required");
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "manifests", `${input.projectN}.json`), "utf8"));
  const index = manifest.snapshotHashesInCollectionOrder.indexOf(input.snapshotHash);
  if (index < 0 || !input.spans[0].id.startsWith(`p${index + 1}-`)) throw new Error("probe source is outside its manifest");
  const text = fs.readFileSync(path.join(dataDir, "pipeline", "snapshots", `${input.snapshotHash}.json`), "utf8");
  const snapshot = JSON.parse(text);
  const boundaries = [manifest.homepageBoundary ?? manifest.boundary, ...(manifest.repoBoundaries ?? [])].filter(Boolean);
  if (hash(text) !== input.snapshotFileDigest || snapshot.snapshotHash !== input.snapshotHash || !boundaries.some(b => withinBoundary(snapshot.url, b)) ||
      !irrelevantFooter(input.spans[0].text) || !projectSpans(dataDir, input.projectN).some(s => s.id === input.spans[0].id && s.text === input.spans[0].text)) throw new Error("probe source is stale or not a genuine own-source footer");
  return { projectN: input.projectN, checkId: input.checkId, state: "pass", spans: input.spans, flaggedSpanIds: [] };
}

export function projectProbe(codebook: Codebook, positive: Positive) {
  const body = buildConfirmationBody(codebook, positive, MODEL, true);
  const inputTokens = estimateMessagesTokens(body.messages);
  const inputReservation = reservationInputTokens(ollamaRequestBody(body));
  const reservedUpperBoundUsd = ATTEMPTS * estimateCostUsd(MODEL, inputReservation, body.max_tokens);
  if (inputTokens > DEFAULT_TOKEN_CAP || reservedUpperBoundUsd > 1) throw new Error("probe projection exceeds its approved limit");
  return { stage: "irrelevant-probe", provider: "ollama", model: MODEL, thinking: true, attempts: ATTEMPTS, inputTokensPerAttempt: inputTokens,
    outputTokensPerAttempt: body.max_tokens, inputReservationPerAttempt: inputReservation,
    projectedUsd: ATTEMPTS * estimateCostUsd(MODEL, inputTokens, body.max_tokens), reservedUpperBoundUsd, cap: 1,
    requestDigest: hash(JSON.stringify(body)) };
}

export function assertProbeApproval(plan: ReturnType<typeof projectProbe>, approval: any) {
  if (approval?.requestDigest !== plan.requestDigest || approval.approvedProjectionCeilingUsd !== 1 ||
      !Number.isFinite(approval.includedBalanceAtApprovalUsd) || approval.includedBalanceAtApprovalUsd < plan.reservedUpperBoundUsd) throw new Error("current probe cost approval required");
}

export async function runLiveProbe(dataDir = resolveDataDir(), log = console.log) {
  assertA9Signed();
  const validation = path.join(dataDir, "validation");
  const input = loadProbeInput(dataDir, path.join(validation, "irrelevant-citation-probe-input.json"));
  const codebook = loadCodebook();
  const plan = projectProbe(codebook, input);
  log(`COST_PLAN: ${JSON.stringify(plan)}`);
  const resultFile = path.join(validation, "irrelevant-citation-probe.json");
  if (fs.existsSync(resultFile)) {
    const saved = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (saved.requestDigest === plan.requestDigest && saved.complete === true && saved.decision === "rejected") {
      log(`PROBE: ${JSON.stringify({ decision: saved.decision, genuine: true, ownSource: true, cached: true, complete: true })}`); return saved;
    }
    throw new Error("prior probe outcome requires review before another call");
  }
  const costPlanFile = path.join(validation, "irrelevant-citation-cost-plan.json");
  const approval = JSON.parse(fs.readFileSync(costPlanFile, "utf8"));
  assertProbeApproval(plan, approval);
  const opened = openApprovedBudget(dataDir, "irrelevant-probe");
  const counters = { calls: 0, retries: 0, limit_hits: 0 };
  let result: any;
  try {
    if (opened.parent.spent + plan.reservedUpperBoundUsd > opened.parent.cap || plan.reservedUpperBoundUsd > 2.5) throw new Error("probe projection exceeds remaining shared allowance");
    fs.writeFileSync(costPlanFile, JSON.stringify({ ...approval, ...plan }, null, 2) + "\n", { mode: 0o600 });
    const client = ollamaClient({ stage: "irrelevant-probe", budget: opened.budget, concurrency: 1, maxRetries: 0, counters,
      onUsage: row => fs.appendFileSync(path.join(validation, "approved-usage.jsonl"), JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n", { mode: 0o600 }) });
    const audited = { ...client, request: async (...args: any[]) => {
      const response = await (client.request as any)(...args);
      fs.appendFileSync(path.join(validation, "irrelevant-citation-probe-raw.jsonl"), JSON.stringify({ requestDigest: plan.requestDigest, rawResponse: response.text, status: response.status, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
      return response;
    } };
    const decision = await confirmWithModel(audited, codebook, input, MODEL, ATTEMPTS, true);
    result = { ...plan, decision: decision.decision, reason: decision.reason, genuine: true, ownSource: true, complete: decision.decision === "rejected", spentUsd: opened.budget.spent, completedAt: new Date().toISOString() };
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    log(`PROBE: ${JSON.stringify({ decision: result.decision, genuine: true, ownSource: true, cached: false, complete: result.complete })}`);
    log(`ACCOUNTING: ${JSON.stringify({ stage: "irrelevant-probe", total: 1, valid: result.complete ? 1 : 0, failed: result.complete ? 0 : 1, complete: result.complete })}`);
    if (!result.complete) throw new Error("live irrelevant citation was not rejected");
    return result;
  } catch (error) {
    if (!result) {
      fs.writeFileSync(resultFile, JSON.stringify({ ...plan, complete: false, errorName: (error as Error).name, spentUsd: opened.budget.spent }, null, 2) + "\n", { mode: 0o600 });
      log(`ACCOUNTING: ${JSON.stringify({ stage: "irrelevant-probe", total: 1, valid: 0, failed: 1, complete: false, reason: (error as Error).name })}`);
    }
    throw error;
  } finally {
    log(opened.budget.budgetLine());
    log(`HOST_BUDGET: ${JSON.stringify({ host: opened.host, ...opened.parent.snapshot() })}`);
    log(formatOllamaSummary(counters)); opened.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLiveProbe();
