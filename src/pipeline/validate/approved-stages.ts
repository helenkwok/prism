import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { readCached, stageCacheKey, withStageCache, writeCached } from "../cache/stage-cache.ts";
import { buildClaimsForProject } from "../claims/build-claims.ts";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { citationSchema, isSchemaValid, type GateFile } from "../coding/contract.ts";
export { citationSchema } from "../coding/contract.ts";
import { applyQuoteOrUnknownFilter } from "../coding/filter.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../coding/nebius-client.ts";
import { codeProjectWithRetry, type RetryContract } from "../coding/retry.ts";
import { uniqueProjectSpans } from "../coding/span-packing.ts";
import { readRepairIndex, recordRepairMetadata } from "../coding/repair-index.ts";
import { confirmMessages, confirmWithModel, inputDigest, projectSpans, readPositives, spansDigest, type Positive } from "../confirm/confirm.ts";
import { runGate } from "../gate/run-gate.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS, mergeChunkCodings } from "../run.ts";
import { assertA9Signed } from "../signoff/a9.ts";
import { ensurePipelineSchema, recordProjectResult, recordSecondCoding } from "../store/results.ts";
import { a7Signed, ensureGoldSchema, labelProject, writeExcludedA3 } from "./gold.ts";
import { ARTCRAFT_HN_ID } from "../select/draw-sample.ts";
import type { RoleSpec } from "./providers.ts";

type Client = { request: (p: string, init: { method: string; body: any }) => Promise<any>; dollarBudget?: { budgetLine: () => string } };
export type ApprovedStageOptions = {
  stage: "recode" | "gold" | "second-coder" | "spike";
  db: Kysely<any>; dataDir: string; cacheDir?: string; codebook: Codebook; contract: RetryContract;
  entries: { n: number; hn_id: string; title?: string }[]; client: Client; role: RoleSpec;
  gateFile?: GateFile; log?: (line: string) => void; repoRoot?: string;
  concurrency?: 1 | 2;
};
export type StageAccounting = { stage: string; total: number; accounted: number; success: number; failed: number; stopped: number; excludedA3: number; reason: string | null; ok: boolean; completedExperiment?: boolean; successfulDecisions?: number; failureCounts?: Record<string, number>; labelled?: number; noGold?: number; goldGate?: { projects: number; failed: number; rate: number; threshold: number; passed: boolean } };

/** Only these cited spans are admitted to either condition; sample is stable across resumes. */
export function spikeSample(positives: Positive[], count = 30): Positive[] {
  return [...positives].sort((a, b) => {
    const key = (p: Positive) => crypto.createHash("sha256").update(`confirmation-spike-v1:${p.projectN}:${p.checkId}`).digest("hex");
    return key(a).localeCompare(key(b));
  }).slice(0, count);
}

async function codingProject(o: ApprovedStageOptions, e: ApprovedStageOptions["entries"][number]) {
  const manifestPath = path.join(o.dataDir, "pipeline", "manifests", `${e.n}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const original = projectSpans(o.dataDir, e.n);
  const spans = uniqueProjectSpans(original);
  const cacheDir = o.cacheDir ?? path.join(o.dataDir, "pipeline", "cache");
  const perChunk = [];
  let attempts = 0;
  const failures = new Map(Object.values(readRepairIndex(o.dataDir)).map(row => [row.baseDigest, row.lastValidationStage]));
  const cloudSecondCoder = o.stage === "second-coder" && o.role.provider === "ollama";
  for (const chunk of chunkSpans(spans)) {
    const result = await codeProjectWithRetry({ client: o.client, cfg: {}, contract: o.contract, spanIds: chunk.map(s => s.id), callOnce: async (_c, _cfg, schema, ids) => {
      const makeBody = (requestSchema: unknown, feedback?: string) => buildChatBody({ model: o.role.model, messages: buildCodingMessages(ids, o.codebook, requestSchema, chunk).map((message, i) => i === 0 && feedback ? { ...message, content: `${message.content}\n\nFormat correction: ${feedback}` } : message), mode: "json_schema", schema: { name: "gate_checks", schema: requestSchema, strict: true }, thinking: o.role.reasoning === true, ...(typeof o.role.reasoning === "string" ? { reasoningEffort: o.role.reasoning } : {}), maxTokens: CODING_MAX_TOKENS });
      let body = makeBody(schema);
      const baseDigest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const baseCache = readCached<string>(cacheDir, stageCacheKey(String(e.hn_id), `approved-${o.stage}-chunk`, { digest: baseDigest, provider: o.role.provider }));
      if (baseCache.hit && isSchemaValid(baseCache.value, chunk.map(s => s.id), o.contract.zodSchema).valid) return baseCache.value;
      const failure = failures.get(baseDigest);
      if (failure === "span_resolve") {
        body = makeBody(citationSchema(schema, chunk.map(s => s.id)));
        const legacyDigest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
        const legacyCache = readCached<string>(cacheDir, stageCacheKey(String(e.hn_id), `approved-${o.stage}-chunk`, { digest: legacyDigest, provider: o.role.provider }));
        if (legacyCache.hit && isSchemaValid(legacyCache.value, chunk.map(s => s.id), o.contract.zodSchema).valid) return legacyCache.value;
      }
      // Cloud schemas are advisory. Trusted format instructions complement strict local validation.
      if (cloudSecondCoder) {
        if (failure === "zod") body = makeBody(schema, `Return exactly the required checks object keyed by all ${ids.length} ids: ${ids.join(", ")}. Each check contains only proposedState (pass, fail, unknown or claimed) and spanIds (an array of strings, empty when unsupported). Do not add, rename or omit keys. Match the supplied schema exactly; no prose or fences.`);
        else if (failure === "span_resolve") body = makeBody(citationSchema(schema, chunk.map(s => s.id)), `Your previous citations did not resolve. Cite only these exact span ids: ${JSON.stringify(chunk.map(s => s.id))}. Never invent, alias or shorten an id. Use an empty spanIds array when no listed span supports the state. Return every required check.`);
        else if (failure === "json_parse") body = makeBody(schema, "Return exactly one valid JSON object, with no prose, markdown fences or text outside the object. Do not omit any required check. The previous response was not parseable JSON; begin with { and end with }, use quoted property names and valid JSON string escaping.");
        else body = makeBody(schema, "Return exactly one valid JSON object, with no prose, markdown fences or text outside the object. Do not omit any required check.");
      }
      const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const { value } = await withStageCache(cacheDir, String(e.hn_id), `approved-${o.stage}-chunk`, { digest, provider: o.role.provider }, async () => {
        const res = await o.client.request("/chat/completions", { method: "POST", body });
        if (isQuotaResponse(res)) throw new QuotaStop(res.status, "quota stop");
        if (!res.ok) throw new Error(`coding response status ${res.status}`);
        const content = res.json?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("coding response missing content");
        const validation = isSchemaValid(content, chunk.map(s => s.id), o.contract.zodSchema);
        if (!validation.valid) {
          if (validation.stage === "ok") throw new Error("invalid coding validation stage");
          failures.set(baseDigest, validation.stage);
          const dir = path.join(o.dataDir, "validation"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.appendFileSync(path.join(dir, "coding-invalid-replies.jsonl"), JSON.stringify({ stage: o.stage, projectN: e.n, requestDigest: digest, validationStage: validation.stage, finishReason: res.json?.choices?.[0]?.finish_reason ?? null, content, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
          recordRepairMetadata(o.dataDir, { baseDigest, lastValidationStage: validation.stage, stage: o.stage, model: o.role.model });
        }
        return content;
      }, content => isSchemaValid(content, chunk.map(s => s.id), o.contract.zodSchema).valid);
      return value;
    } });
    attempts += result.attempts;
    if (!result.valid) throw new Error(`project ${e.n}: retry-exhausted chunk`);
    perChunk.push(result.data!.checks);
  }
  const raw = mergeChunkCodings(o.contract.checkIds, perChunk);
  const filtered = applyQuoteOrUnknownFilter(raw, original.map(s => s.id));
  const checkStates = filtered.map(f => ({ checkId: f.checkId, proposedState: raw.find(r => r.checkId === f.checkId)!.proposedState, filteredState: f.proposedState, spanIds: f.spanIds }));
  if (o.stage === "second-coder") {
    await recordSecondCoding(o.db, e.n, { modelId: o.role.model, allUnknown: false, checkStates });
    const dir = path.join(o.dataDir, "decisions"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "second-coder.jsonl"), JSON.stringify({ projectN: e.n, provider: o.role.provider, model: o.role.model, reasoning: o.role.reasoning, substitutionReason: "cost", decidedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    return;
  }
  if (!o.gateFile) throw new Error("recode requires gateFile");
  const spanUrls: Record<string, string> = {};
  for (const s of original) {
    const page = Number(/^p(\d+)-/.exec(s.id)?.[1]) - 1;
    const hash = manifest.snapshotHashesInCollectionOrder[page];
    const snapshot = hash ? JSON.parse(fs.readFileSync(path.join(o.dataDir, "pipeline", "snapshots", `${hash}.json`), "utf8")) : null;
    spanUrls[s.id] = manifest.snapshots?.[page]?.url ?? snapshot?.url ?? "";
  }
  const claims = await buildClaimsForProject({ project: e.title ?? String(e.n), filteredStates: filtered, spanUrls, runGate: record => runGate(record, { repoRoot: o.repoRoot }), gatesPath: o.gateFile.path });
  const previous = await o.db.selectFrom("pipeline_project_results").select("missing_data").where("project_n", "=", e.n).executeTakeFirst();
  await recordProjectResult(o.db, { projectN: e.n, hnId: String(e.hn_id), modelId: o.role.model, promptHash: crypto.createHash("sha256").update(JSON.stringify(o.contract.jsonSchema)).digest("hex"), codebookVersion: o.codebook.codebookVersion, gateSha: Object.values(claims)[0].gateResult.gateSha, snapshotHashesInCollectionOrder: manifest.snapshotHashesInCollectionOrder, codingAttempts: attempts, codingAllUnknown: false, missingData: previous?.missing_data ?? null, checkStates, claims: Object.entries(claims).map(([decisionId, v]) => ({ decisionId, claimJson: v.record, gateStatus: v.gateResult.status })) });
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, recodedAt: new Date().toISOString(), codingModel: o.role.model }, null, 2), { mode: 0o600 });
}

/** Explicit client injection keeps approval, credentials and the shared budget in the caller. */
export async function runApprovedStage(o: ApprovedStageOptions): Promise<StageAccounting> {
  const concurrency = o.concurrency ?? 1;
  if (concurrency !== 1 && concurrency !== 2) throw new Error("Stage concurrency must be 1–2");
  assertA9Signed({ protocolPath: path.join(o.repoRoot ?? process.cwd(), "protocol", "PROTOCOL.md"), signoffPath: path.join(o.dataDir, "decisions", "signoff.jsonl") });
  if (o.stage === "gold" && !await a7Signed({ protocolPath: path.join(o.repoRoot ?? process.cwd(), "protocol", "PROTOCOL.md"), signoffPath: path.join(o.dataDir, "decisions", "signoff.jsonl") })) throw new Error("A7 not signed");
  const log = o.log ?? console.log;
  const out: StageAccounting = { stage: o.stage, total: o.entries.length, accounted: 0, success: 0, failed: 0, stopped: 0, excludedA3: 0, reason: null, ok: false };
  await ensurePipelineSchema(o.db);
  if (o.stage === "gold") await ensureGoldSchema(o.db);
  try {
    if (o.stage === "spike") {
      const eligible = o.entries.filter(e => String(e.hn_id) !== ARTCRAFT_HN_ID);
      const { positives, awaitingGold } = await readPositives(o.db, o.dataDir, { sampleNs: eligible.map(e => e.n), codebookVersion: o.codebook.codebookVersion });
      if (awaitingGold.length) throw new Error(`gold lock: ${awaitingGold.length} projects awaiting labels`);
      const selected = spikeSample(positives);
      if (selected.length !== 30) throw new Error(`spike needs 30 positives; available ${selected.length}`);
      out.total = 60;
      const reportPath = path.join(o.dataDir, "validation", "confirmation-spike.json");
      fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
      const report: any = { model: o.role.model, excludedA3: o.entries.length - eligible.length, selected: selected.map(p => ({ projectN: p.projectN, checkId: p.checkId, digest: inputDigest(o.codebook, p) })), decisions: [], completedExperiment: false, successfulDecisions: 0, failureCounts: {}, stopped: null };
      const persist = () => {
        report.completedExperiment = out.accounted === 60;
        report.successfulDecisions = out.success;
        report.accounted = out.accounted;
        report.failed = out.failed;
        report.allDecisionsValid = out.success === 60 && out.failed === 0;
        report.reason = report.stopped?.reason ?? (report.completedExperiment && out.success === 0 ? "no-valid-decisions" : null);
        report.failureCounts = out.failureCounts ?? {};
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      };
      out.failureCounts = {};
      persist();
      for (const p of selected) for (const setting of [true, false] as const) {
        const promptDigest = crypto.createHash("sha256").update(JSON.stringify(confirmMessages(o.codebook, p))).digest("hex");
        const cacheDir = o.cacheDir ?? path.join(o.dataDir, "pipeline", "cache");
        const input = { digest: inputDigest(o.codebook, p), promptDigest, provider: o.role.provider, model: o.role.model, setting };
        const failureKey = stageCacheKey(String(p.projectN), "confirmation-spike-failure", input);
        let result: { decision: string | null; reason: string; failed: boolean };
        let fromCache = false;
        try {
          const previousFailure = readCached<{ decision: null; reason: string; failed: true }>(cacheDir, failureKey);
          if (previousFailure.hit) { result = previousFailure.value; fromCache = true; }
          else {
            const cache = await withStageCache(cacheDir, String(p.projectN), "confirmation-spike", input, () => confirmWithModel(o.client, o.codebook, p, o.role.model, 3, setting, { onResponse: response => fs.appendFileSync(path.join(o.dataDir, "validation", "confirmation-spike-responses.jsonl"), JSON.stringify({ stage: "spike", ...response, at: new Date().toISOString() }) + "\n", { mode: 0o600 }) }));
            result = { ...cache.value, failed: false }; fromCache = cache.fromCache;
          }
        } catch (error) {
          const name = (error as Error).name;
          if (name !== "InvalidConfirmationError" && name !== "FlaggedRuleError") {
            report.stopped = { projectN: p.projectN, checkId: p.checkId, setting, reason: (error as Error).message, kind: name };
            persist();
            throw error;
          }
          result = { decision: null, reason: name === "FlaggedRuleError" ? "flagged-span-rule" : (error as { reason?: string }).reason ?? "off-contract", failed: true };
          writeCached(cacheDir, failureKey, result);
        }
        report.decisions.push({ projectN: p.projectN, checkId: p.checkId, state: p.state, spans: p.spans, flaggedSpanIds: (p.flaggedSpanIds ?? []).filter(id => p.spans.some(s => s.id === id)), setting, ...result });
        if (result.failed) { out.failed++; const key = `${setting ? "on" : "off"}:${result.reason}`; out.failureCounts![key] = (out.failureCounts![key] ?? 0) + 1; }
        else out.success++;
        out.accounted++;
        persist();
        log(`CONFIRMATION: ${JSON.stringify({ stage: "spike", projectN: p.projectN, checkId: p.checkId, setting, decision: result.decision, failed: result.failed, failureCode: result.failed ? result.reason : null, fromCache })}`);
      }
    } else {
      let next = 0;
      let stop = false;
      let batchEnd = o.entries.length;
      if (o.stage === "gold") {
        out.labelled = 0; out.noGold = 0;
        let eligible = 0;
        for (let i = 0; i < o.entries.length; i++) {
          if (String(o.entries[i].hn_id) !== ARTCRAFT_HN_ID) eligible++;
          if (eligible === 20) { batchEnd = i + 1; break; }
        }
      }
      // An in-flight project may finish its reserved request, but cannot start another after a stop.
      const client: Client = { ...o.client, request: (p, init) => {
        if (stop) { const error = new Error("stage scheduling stopped"); error.name = "StageStoppedError"; throw error; }
        return o.client.request(p, init);
      } };
      const execute = async () => {
        while (!stop && next < batchEnd) {
          const e = o.entries[next++];
          try {
            if (o.stage === "gold") {
              if (String(e.hn_id) === ARTCRAFT_HN_ID) {
                await writeExcludedA3({ db: o.db, projectN: e.n, codebookVersion: o.codebook.codebookVersion, role: o.role, digest: spansDigest([]) });
                out.excludedA3++;
              } else {
                const outcome = await labelProject({ db: o.db, dataDir: o.dataDir, cacheDir: o.cacheDir ?? path.join(o.dataDir, "pipeline", "cache"), projectN: e.n, hnId: String(e.hn_id), codebook: o.codebook, codebookVersion: o.codebook.codebookVersion, contract: o.contract, role: o.role, client });
                if (outcome.outcome === "no-gold") { out.noGold!++; out.failed++; out.accounted++; log(`ACCOUNTING: ${JSON.stringify({ ...out, projectN: e.n, outcome: "no-gold", complete: false })}`); continue; }
                if (outcome.outcome !== "labelled") throw new Error(`project ${e.n}: ${outcome.outcome}`);
                out.labelled!++;
              }
            } else await codingProject({ ...o, client }, e);
            out.success++; out.accounted++;
          } catch (error) {
            stop = true;
            out.reason ??= (error as Error).message;
            if (!["BudgetExceededError", "QuotaStop", "TooLargeError", "StageStoppedError"].includes((error as Error).name)) { out.failed++; out.accounted++; }
          }
          log(`ACCOUNTING: ${JSON.stringify({ ...out, remaining: o.entries.length - out.accounted, complete: false })}`);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, execute));
      if (o.stage === "gold" && !stop && (out.labelled ?? 0) + (out.noGold ?? 0) === 20) {
        out.goldGate = { projects: 20, failed: out.noGold ?? 0, rate: (out.noGold ?? 0) / 20, threshold: 0.1, passed: (out.noGold ?? 0) <= 2 };
        log(`GOLD_GATE: ${JSON.stringify(out.goldGate)}`);
        if (!out.goldGate.passed) { stop = true; out.reason = "gold-first-20-failure-rate"; }
      }
      if (!stop && next < o.entries.length) {
        batchEnd = o.entries.length;
        await Promise.all(Array.from({ length: concurrency }, execute));
      }
      out.stopped = out.total - out.accounted;
    }
  } catch (error) {
    out.reason = (error as Error).message;
    if (o.stage === "spike" || ["BudgetExceededError", "QuotaStop", "TooLargeError"].includes((error as Error).name)) out.stopped = out.total - out.accounted;
    else { out.failed = 1; out.accounted++; out.stopped = Math.max(0, out.total - out.accounted); }
  }
  if (o.stage === "spike") {
    out.completedExperiment = out.accounted === 60 && out.stopped === 0;
    out.successfulDecisions = out.success;
    out.ok = out.completedExperiment && out.success > 0;
    if (out.completedExperiment && out.success === 0) out.reason = "no-valid-decisions";
  } else if (o.stage === "gold") {
    out.ok = out.accounted === out.total && out.stopped === 0 && (out.labelled ?? 0) > 0 && out.goldGate?.passed !== false;
    if (out.accounted === out.total && !out.labelled) out.reason = "no-gold-labels";
  } else out.ok = out.success === out.total && out.failed === 0 && out.stopped === 0;
  if (o.client.dollarBudget) log(o.client.dollarBudget.budgetLine());
  log(`ACCOUNTING: ${JSON.stringify({ ...out, complete: o.stage === "spike" ? out.completedExperiment : o.stage === "gold" ? out.accounted === out.total : out.success === out.total, ...(o.stage === "spike" ? { allDecisionsValid: out.failed === 0 && out.success === 60 } : o.stage === "gold" ? { allDecisionsValid: out.failed === 0 && (out.labelled ?? 0) > 0 } : {}) })}`);
  if (o.stage === "spike") log(`CONFIRMATION: ${JSON.stringify({ stage: "spike", completed: out.success, valid: out.success, failed: out.failed, total: out.total, completedExperiment: out.completedExperiment, failureCounts: out.failureCounts, stopBeforeFull: true })}`);
  return out;
}
