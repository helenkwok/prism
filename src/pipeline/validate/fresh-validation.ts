import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { DollarBudget, DEFAULT_TOKEN_CAP, estimateMessagesTokens } from "../coding/spend-guards.ts";
import type { Codebook } from "../coding/codebook-prompt.ts";
import type { RetryContract } from "../coding/retry.ts";
import { projectSpans, spansDigest } from "../confirm/confirm.ts";
import { recordMissingData } from "../store/results.ts";
import { extendSample, SAMPLING_SEED, GOLD_SEED, ARTCRAFT_HN_ID, quarterOf, type SampleEntry, type Screeners } from "../select/draw-sample.ts";
import type { FramePost } from "../select/draw.ts";
import { sortPilotCandidates } from "../select/pilot-draw.ts";
import { runPipeline, guidedCodingChunks, guidedCodingRequestBodies, CODING_MAX_TOKENS, type CodingGuidance } from "../run.ts";
import { labelProject, writeExcludedA3, goldCodingChunks, goldRequestBodies } from "./gold.ts";
import { loadReleaseProof } from "./release-proof.ts";

export const FRESH_CAPS = { screening: .50, coding: 1, gold: 1.10 } as const;
const sha = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const privateJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.next`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(`${file}.next`, file);
};
function checkBudget(budget: DollarBudget, cap: number) {
  // The standing balance reserve supersedes earlier per-stage planning ceilings.
  const limit = budget instanceof DollarBudget ? budget.parent?.cap ?? cap : cap;
  if (!(budget instanceof DollarBudget) || !Number.isFinite(budget.cap) || budget.cap <= 0 || budget.cap > limit) throw new Error("fresh stage requires a bounded budget");
}

/** The full registered extension is required; incomplete screening never becomes a final sample. */
export function validateFreshSample(entries: SampleEntry[], previousEntries: SampleEntry[], previousLog: { id: string }[]): void {
  const excluded = new Set([...previousEntries.map(e => String(e.hn_id)), ...previousLog.map(e => String(e.id))]);
  if (previousEntries.length !== 300 || entries.length !== 76 || new Set(entries.map(e => String(e.hn_id))).size !== 76 || new Set(entries.map(e => e.n)).size !== 76 ||
      entries.some((e, i) => e.n !== previousEntries.length + i + 1 || excluded.has(String(e.hn_id)) || quarterOf(e.created_at) !== e.quarter || !e.final_url) ||
      [1, 2, 3, 4].some(q => entries.filter(e => e.quarter === q).length !== 19)) throw new Error("fresh sample must be the complete disjoint 19-per-quarter continuation");
}

export async function prepareFreshSample(o: {
  dataDir: string; posts: FramePost[]; previousEntries: SampleEntry[]; previousLog: { id: string }[];
  screeners: Screeners; budget: DollarBudget; log?: (line: string) => void;
}) {
  checkBudget(o.budget, FRESH_CAPS.screening);
  const log = o.log ?? console.log;
  const dir = path.join(o.dataDir, "pipeline");
  const sourceDigest = sha({ seed: SAMPLING_SEED, perQuarter: 19, posts: o.posts, previousEntries: o.previousEntries, previousLog: o.previousLog });
  const markerPath = path.join(dir, "fresh-validation-sample.json");
  if (fs.existsSync(markerPath)) {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const entries = JSON.parse(fs.readFileSync(path.join(dir, "fresh-projects.json"), "utf8")) as SampleEntry[];
    if (marker.sourceDigest !== sourceDigest || marker.entriesDigest !== sha(entries) || marker.seed !== SAMPLING_SEED) throw new Error("fresh sample provenance changed");
    validateFreshSample(entries, o.previousEntries, o.previousLog);
    log(`ACCOUNTING: ${JSON.stringify({ stage: "fresh-screening", total: 76, accounted: 76, success: 76, failed: 0, complete: true, fromCache: true })}`);
    log(o.budget.budgetLine());
    return entries;
  }
  if (fs.existsSync(path.join(dir, "fresh-projects.json"))) throw new Error("existing fresh sample requires its matching continuation provenance");
  try {
    const result = await extendSample({ ...o, perQuarter: 19, seed: SAMPLING_SEED });
    validateFreshSample(result.entries, o.previousEntries, o.previousLog);
    privateJson(path.join(dir, "fresh-projects.json"), result.entries);
    privateJson(path.join(dir, "fresh-screening-log.json"), { seed: SAMPLING_SEED, perQuarter: 19, counts: result.counts, log: result.log });
    privateJson(markerPath, { version: 1, seed: SAMPLING_SEED, perQuarter: 19, sourceDigest, entriesDigest: sha(result.entries) });
    log(`ACCOUNTING: ${JSON.stringify({ stage: "fresh-screening", total: 76, accounted: 76, success: 76, failed: 0, complete: true, fromCache: false })}`);
    return result.entries;
  } catch (error) {
    log(`ACCOUNTING: ${JSON.stringify({ stage: "fresh-screening", total: 76, accounted: 0, success: 0, failed: 0, stopped: true, complete: false, reason: error instanceof Error ? error.name : "Error" })}`);
    throw error;
  } finally { log(o.budget.budgetLine()); }
}

/** Inventory complete actual prompts without sending, truncating, or changing chunk boundaries. */
export function inventoryFreshCoding(o: { dataDir: string; entries: SampleEntry[]; guidance: CodingGuidance; codebook: Codebook; contract: RetryContract }) {
  const requests = o.entries.flatMap(e => guidedCodingChunks(projectSpans(o.dataDir, e.n), o.codebook, o.contract, o.guidance).map((chunk, i) => {
    const [body, retryBody] = guidedCodingRequestBodies(o.codebook, o.contract, chunk, o.guidance);
    const inputTokens = estimateMessagesTokens(body.messages), retryInputTokens = estimateMessagesTokens(retryBody.messages);
    return { projectN: e.n, chunk: i + 1, inputTokens, retryInputTokens, maximumInputTokens: Math.max(inputTokens, retryInputTokens), outputLimit: CODING_MAX_TOKENS, requestDigest: sha(body), retryRequestDigest: sha(retryBody) };
  }));
  const report = { version: 1, stage: "fresh-coding", guidanceVersion: o.guidance.version, projects: o.entries.length, chunks: requests.length, cap: DEFAULT_TOKEN_CAP, overCap: requests.filter(r => r.maximumInputTokens > DEFAULT_TOKEN_CAP).length, maxInputTokens: Math.max(0, ...requests.map(r => r.maximumInputTokens)), requests };
  privateJson(path.join(o.dataDir, "validation", "fresh-coding-inventory.json"), report);
  return report;
}

export function inventoryFreshGold(o: { dataDir: string; entries: SampleEntry[]; codebook: Codebook; contract: RetryContract }) {
  const role = { provider: "ollama", model: "glm-5.3-flash:cloud", reasoning: "low" } as const;
  const requests = o.entries.flatMap(e => goldCodingChunks(projectSpans(o.dataDir, e.n), o.codebook, o.contract, role).map((chunk, i) => {
    const bodies = goldRequestBodies(o.codebook, o.contract, chunk, role);
    const tokenCounts = bodies.map(body => estimateMessagesTokens(body.messages));
    return { projectN: e.n, chunk: i + 1, inputTokens: tokenCounts[1], maximumInputTokens: Math.max(...tokenCounts), outputLimit: CODING_MAX_TOKENS, requestDigests: bodies.map(sha) };
  }));
  const report = { version: 1, stage: "fresh-gold", projects: o.entries.length, chunks: requests.length, cap: DEFAULT_TOKEN_CAP, overCap: requests.filter(r => r.maximumInputTokens > DEFAULT_TOKEN_CAP).length, maxInputTokens: Math.max(0, ...requests.map(r => r.maximumInputTokens)), requests };
  privateJson(path.join(o.dataDir, "validation", "fresh-gold-inventory.json"), report);
  return report;
}

type PipelineOptions = Parameters<typeof runPipeline>[0];
type GoldClient = Parameters<typeof labelProject>[0]["client"] & { dollarBudget?: DollarBudget };
export type FreshValidationOptions = {
  stage: "collect" | "inventory" | "code" | "gold"; dataDir: string; cacheDir: string; db: Kysely<any>;
  entries: SampleEntry[]; previousEntries: SampleEntry[]; previousLog: { id: string }[];
  codebook: Codebook; codebookVersion: string; contract: RetryContract; guidance: CodingGuidance;
  priorApprovalProofPath: string; assertGuidanceApproved: (guidance: CodingGuidance) => Promise<void> | void;
  concurrency?: 1 | 2; coding: { apiKeys: PipelineOptions["apiKeys"]; budget: DollarBudget; overrides?: PipelineOptions["overrides"] };
  gold: { client: GoldClient; budget: DollarBudget }; log?: (line: string) => void;
};

/** Explicit single-stage entry point: calling one stage never starts the next paid role. */
export async function runFreshValidation(o: FreshValidationOptions, dependencies: { pipeline?: typeof runPipeline; label?: typeof labelProject; proof?: typeof loadReleaseProof } = {}) {
  const log = o.log ?? console.log;
  if (!["collect", "inventory", "code", "gold"].includes(o.stage)) throw new Error("unknown fresh validation stage");
  const concurrency = o.concurrency ?? 1;
  if (concurrency !== 1 && concurrency !== 2) throw new Error("fresh concurrency must be 1 or 2");
  validateFreshSample(o.entries, o.previousEntries, o.previousLog);
  if (!o.priorApprovalProofPath || typeof o.assertGuidanceApproved !== "function") throw new Error("fresh validation requires retained approval proof and signed guidance");
  await o.assertGuidanceApproved(o.guidance);
  (dependencies.proof ?? loadReleaseProof)(o.priorApprovalProofPath, path.join(process.cwd(), "protocol", "PROTOCOL.md"));
  if (o.stage === "inventory") {
    const report = inventoryFreshCoding(o);
    log(`COST_PLAN: ${JSON.stringify({ ...report, requests: undefined })}`);
    return { ok: report.overCap === 0, stage: o.stage, total: report.projects, chunks: report.chunks, overCap: report.overCap };
  }
  if (o.stage === "collect" || o.stage === "code") {
    checkBudget(o.coding.budget, FRESH_CAPS.coding);
    if (o.stage === "code") {
      const report = inventoryFreshCoding(o);
      log(`COST_PLAN: ${JSON.stringify({ ...report, requests: undefined })}`);
      if (report.overCap) throw new Error("fresh coding prompt exceeds unchanged request cap; no coding started");
    }
    const sliceProjectsPath = path.join(o.dataDir, "pipeline", "fresh-projects.json");
    const retained = JSON.parse(fs.readFileSync(sliceProjectsPath, "utf8"));
    if (sha(retained) !== sha(o.entries)) throw new Error("fresh sample file differs from registered entries");
    const result = await (dependencies.pipeline ?? runPipeline)({ sliceProjectsPath, apiKeys: o.coding.apiKeys, concurrency, cacheDir: o.cacheDir, dataDir: o.dataDir, db: o.db,
      guidance: o.guidance, priorApprovalProofPath: o.priorApprovalProofPath, secondCoderIds: new Set(), collectOnly: o.stage === "collect", overrides: { ...o.coding.overrides, useTavily: false, tfBudget: o.coding.budget } });
    const noEvidenceProjects: number[] = [];
    if (o.stage === "code" && result.ok) {
      const rows = await o.db.selectFrom("pipeline_project_results").select(["project_n", "coding_all_unknown", "missing_data"]).where("project_n", "in", o.entries.map(e => e.n)).execute();
      const invalid = new Set<number>();
      for (const e of o.entries) {
        const row = rows.find(r => r.project_n === e.n);
        if (!row || ![0, 1].includes(row.coding_all_unknown)) { invalid.add(e.n); continue; }
        let spanCount: number;
        try { spanCount = projectSpans(o.dataDir, e.n).length; } catch { invalid.add(e.n); continue; }
        if (spanCount === 0) {
          noEvidenceProjects.push(e.n);
          if (row.missing_data !== 1) await recordMissingData(o.db, e.n, true);
        } else if (row.coding_all_unknown !== 0) invalid.add(e.n);
      }
      for (const outcome of result.outcomes ?? []) if ((outcome.codingFailedChunks ?? 0) > 0) invalid.add(outcome.n);
      if (invalid.size) {
        result.ok = false;
        result.status = "failed";
        result.failed = invalid.size;
        result.succeeded = 76 - invalid.size;
        for (const outcome of result.outcomes ?? []) if (invalid.has(outcome.n)) { outcome.status = "failed"; outcome.error = "fresh coding was not fully valid"; }
        result.stopReason = "fresh coding requires all 76 durable results; empty evidence is unknown, not retry failure";
      }
    }
    const accounted = { ...result, ...(o.stage === "code" ? { noEvidence: noEvidenceProjects.length, noEvidenceProjects, missingDataProjects: noEvidenceProjects } : {}) };
    log(`ACCOUNTING: ${JSON.stringify({ stage: `fresh-${o.stage}`, ...accounted, outcomes: undefined, ...(o.stage === "collect" ? { modelCalls: 0 } : {}) })}`);
    log(o.coding.budget.budgetLine());
    return accounted;
  }
  checkBudget(o.gold.budget, FRESH_CAPS.gold);
  if (o.gold.client.dollarBudget !== o.gold.budget) throw new Error("gold client must use the supplied stage budget");
  const goldInventory = inventoryFreshGold(o);
  log(`COST_PLAN: ${JSON.stringify({ ...goldInventory, requests: undefined })}`);
  if (goldInventory.overCap) throw new Error("fresh gold prompt exceeds unchanged request cap; no labelling started");
  const summary = { stage: "fresh-gold", total: 76, accounted: 0, labelled: 0, noGold: 0, excludedA3: 0, failed: 0, remaining: 76, complete: false, ok: false, reason: null as string | null, goldGate: null as { projects: number; failed: number; rate: number; threshold: number; passed: boolean } | null };
  const seeded = sortPilotCandidates(o.entries.map(e => ({ ...e, id: String(e.hn_id) })), GOLD_SEED);
  const ordered = seeded.filter(e => String(e.hn_id) !== ARTCRAFT_HN_ID);
  let next = 0, stopped = false;
  const persist = () => {
    summary.remaining = summary.total - summary.accounted;
    privateJson(path.join(o.dataDir, "validation", "fresh-gold-accounting.json"), summary);
  };
  for (const entry of seeded.filter(e => String(e.hn_id) === ARTCRAFT_HN_ID)) {
    try {
      await writeExcludedA3({ db: o.db, projectN: entry.n, codebookVersion: o.codebookVersion, role: { provider: "ollama", model: "glm-5.3-flash:cloud", reasoning: "low" }, digest: spansDigest([]) });
      summary.excludedA3++; summary.accounted++; persist();
    } catch (error) { stopped = true; summary.failed++; summary.reason ??= error instanceof Error ? error.name : "Error"; }
  }
  const guardedClient: GoldClient = { request: async (...args) => {
    if (stopped) { const error = new Error("fresh gold stopped"); error.name = "FreshStageStopped"; throw error; }
    return o.gold.client.request(...args);
  } };
  const runWorkers = async (limit: number) => Promise.all(Array.from({ length: concurrency }, async () => {
    while (!stopped && next < limit) {
      const entry = ordered[next++];
      try {
        const outcome = await (dependencies.label ?? labelProject)({ db: o.db, dataDir: o.dataDir, cacheDir: o.cacheDir, projectN: entry.n, hnId: String(entry.hn_id), codebook: o.codebook, codebookVersion: o.codebookVersion, contract: o.contract, role: { provider: "ollama", model: "glm-5.3-flash:cloud", reasoning: "low" }, client: guardedClient, boundedChunks: true });
        if (outcome.outcome === "labelled") summary.labelled++;
        else if (outcome.outcome === "no-gold") summary.noGold++;
        else throw new Error("unexpected fresh gold outcome");
        summary.accounted++; persist();
      } catch (error) { stopped = true; summary.failed++; summary.reason ??= error instanceof Error ? error.name : "Error"; }
    }
  }));
  await runWorkers(Math.min(20, ordered.length));
  const prefixProjects = summary.labelled + summary.noGold;
  summary.goldGate = { projects: prefixProjects, failed: summary.noGold, rate: prefixProjects ? summary.noGold / prefixProjects : 0, threshold: .1, passed: !stopped && prefixProjects === 20 && summary.noGold <= 2 };
  log(`GOLD_GATE: ${JSON.stringify(summary.goldGate)}`);
  persist();
  if (!summary.goldGate.passed) { stopped = true; summary.reason ??= "gold-first-20-failure-rate-or-incomplete"; }
  if (!stopped) await runWorkers(ordered.length);
  summary.remaining = summary.total - summary.accounted;
  summary.complete = summary.accounted === summary.total;
  summary.ok = summary.complete && summary.labelled > 0 && summary.failed === 0;
  log(`ACCOUNTING: ${JSON.stringify(summary)}`);
  log(o.gold.budget.budgetLine());
  privateJson(path.join(o.dataDir, "validation", "fresh-gold-accounting.json"), summary);
  return summary;
}
