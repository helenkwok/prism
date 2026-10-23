import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { withStageCache } from "../cache/stage-cache.ts";
import { buildClaimsForProject } from "../claims/build-claims.ts";
import type { Codebook } from "../coding/codebook-prompt.ts";
import { isSchemaValid, type GateFile } from "../coding/contract.ts";
import { applyQuoteOrUnknownFilter } from "../coding/filter.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../coding/nebius-client.ts";
import { codeProjectWithRetry, type RetryContract } from "../coding/retry.ts";
import { uniqueProjectSpans } from "../coding/span-packing.ts";
import { confirmMessages, confirmWithModel, inputDigest, projectSpans, readPositives, spansDigest, type Positive } from "../confirm/confirm.ts";
import { runGate } from "../gate/run-gate.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS, mergeChunkCodings } from "../run.ts";
import { assertA9Signed } from "../signoff/a9.ts";
import { ensurePipelineSchema, recordProjectResult, recordSecondCoding } from "../store/results.ts";
import { a7Signed, labelProject, writeExcludedA3 } from "./gold.ts";
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
export type StageAccounting = { stage: string; total: number; accounted: number; success: number; failed: number; stopped: number; reason: string | null; ok: boolean };

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
  for (const chunk of chunkSpans(spans)) {
    const result = await codeProjectWithRetry({ client: o.client, cfg: {}, contract: o.contract, spanIds: chunk.map(s => s.id), callOnce: async (_c, _cfg, schema, ids) => {
      const body = buildChatBody({ model: o.role.model, messages: buildCodingMessages(ids, o.codebook, schema, chunk), mode: "json_schema", schema: { name: "gate_checks", schema, strict: true }, thinking: o.role.reasoning === true, ...(typeof o.role.reasoning === "string" ? { reasoningEffort: o.role.reasoning } : {}), maxTokens: CODING_MAX_TOKENS });
      const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const { value } = await withStageCache(cacheDir, String(e.hn_id), `approved-${o.stage}-chunk`, { digest, provider: o.role.provider }, async () => {
        const res = await o.client.request("/chat/completions", { method: "POST", body });
        if (isQuotaResponse(res)) throw new QuotaStop(res.status, "quota stop");
        if (!res.ok) throw new Error(`coding response status ${res.status}`);
        const content = res.json?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("coding response missing content");
        const validation = isSchemaValid(content, chunk.map(s => s.id), o.contract.zodSchema);
        if (!validation.valid) {
          const dir = path.join(o.dataDir, "validation"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.appendFileSync(path.join(dir, "coding-invalid-replies.jsonl"), JSON.stringify({ stage: o.stage, projectN: e.n, requestDigest: digest, validationStage: validation.stage, finishReason: res.json?.choices?.[0]?.finish_reason ?? null, content, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
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
  const out: StageAccounting = { stage: o.stage, total: o.entries.length, accounted: 0, success: 0, failed: 0, stopped: 0, reason: null, ok: false };
  await ensurePipelineSchema(o.db);
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
      const report: any = { model: o.role.model, excludedA3: o.entries.length - eligible.length, selected: selected.map(p => ({ projectN: p.projectN, checkId: p.checkId, digest: inputDigest(o.codebook, p) })), decisions: [] };
      for (const p of selected) for (const setting of [true, false] as const) {
        const promptDigest = crypto.createHash("sha256").update(JSON.stringify(confirmMessages(o.codebook, p))).digest("hex");
        const cache = await withStageCache(o.cacheDir ?? path.join(o.dataDir, "pipeline", "cache"), String(p.projectN), "confirmation-spike", { digest: inputDigest(o.codebook, p), promptDigest, provider: o.role.provider, model: o.role.model, setting }, () => confirmWithModel(o.client, o.codebook, p, o.role.model, 3, setting));
        report.decisions.push({ projectN: p.projectN, checkId: p.checkId, state: p.state, spans: p.spans, flaggedSpanIds: p.flaggedSpanIds ?? [], setting, ...cache.value });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
        out.success++; out.accounted++;
        log(`CONFIRMATION: ${JSON.stringify({ stage: "spike", projectN: p.projectN, checkId: p.checkId, setting, decision: cache.value.decision, fromCache: cache.fromCache })}`);
      }
    } else {
      let next = 0;
      let stop = false;
      // An in-flight project may finish its reserved request, but cannot start another after a stop.
      const client: Client = { ...o.client, request: (p, init) => {
        if (stop) { const error = new Error("stage scheduling stopped"); error.name = "StageStoppedError"; throw error; }
        return o.client.request(p, init);
      } };
      const execute = async () => {
        while (!stop && next < o.entries.length) {
          const e = o.entries[next++];
          try {
            if (o.stage === "gold") {
              if (String(e.hn_id) === ARTCRAFT_HN_ID) {
                await writeExcludedA3({ db: o.db, projectN: e.n, codebookVersion: o.codebook.codebookVersion, role: o.role, digest: spansDigest([]) });
              } else {
                const outcome = await labelProject({ db: o.db, dataDir: o.dataDir, cacheDir: o.cacheDir ?? path.join(o.dataDir, "pipeline", "cache"), projectN: e.n, hnId: String(e.hn_id), codebook: o.codebook, codebookVersion: o.codebook.codebookVersion, contract: o.contract, role: o.role, client });
                if (outcome.outcome !== "labelled") throw new Error(`project ${e.n}: ${outcome.outcome}`);
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
      out.stopped = out.total - out.accounted;
    }
  } catch (error) {
    out.reason = (error as Error).message;
    if (["BudgetExceededError", "QuotaStop", "TooLargeError"].includes((error as Error).name)) out.stopped = out.total - out.accounted;
    else { out.failed = 1; out.accounted++; out.stopped = Math.max(0, out.total - out.accounted); }
  }
  out.ok = out.success === out.total && out.failed === 0 && out.stopped === 0;
  if (o.client.dollarBudget) log(o.client.dollarBudget.budgetLine());
  log(`ACCOUNTING: ${JSON.stringify({ ...out, complete: out.success === out.total })}`);
  if (o.stage === "spike") log(`CONFIRMATION: ${JSON.stringify({ stage: "spike", completed: out.success, total: out.total, stopBeforeFull: true })}`);
  return out;
}
