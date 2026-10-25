// DSC-03 + D-50: stratified 4×75 sample over window-aligned quarters (protocol R03),
// plus D-52 seeded subsets and D-55a extension past the first 300.
//   node src/pipeline/select/draw-sample.ts [--per-quarter 75] [--extend 19]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pLimit from "p-limit";

import { resolveDataDir } from "../../app/server/db.ts";
import { createClient, PINNED_BASE_URL, isQuotaResponse, QuotaStop, type FetchImpl } from "../coding/nebius-client.ts";
import { DollarBudget, DEFAULT_TOKEN_CAP, TooLargeError, priceOf, requireTfBudget, type BudgetState } from "../coding/spend-guards.ts";
import { deriveBoundary } from "../evidence/boundary.ts";
import { readKey } from "../run.ts";
import {
  drawScreened,
  MIN_STAGE2_CHARS,
  prismaCounts,
  type DrawEntry,
  type FramePost,
  type Outcome,
  type PreflightResult,
} from "./draw.ts";
import { makeScreeners } from "./draw-pilot.ts";
import { sortPilotCandidates } from "./pilot-draw.ts";
import { MODEL_REASON_CODES, SCREENER_MODEL, type ScreenDecision } from "./screen-model.ts";

export const SAMPLING_SEED = "ae0b3a26c3b17672";
export const SCREENING_AUDIT_SEED = "fa23e4fccbc39ce5";
export const GOLD_SEED = "d1481ad50ed309ea";
export const RECALL_SEED = "cc45c03dd0094b92";
export const SECOND_MODEL_SEED = "1a8a5e2c0f6afdcb";

/** A3 / D-53: ArtCraft never enters the gold order. */
export const ARTCRAFT_HN_ID = "46838772";

/** Window-aligned quarter starts (UTC), protocol §1. Last entry is exclusive end. */
export const QUARTER_STARTS = [
  "2025-09-01",
  "2025-12-01",
  "2026-03-01",
  "2026-06-01",
  "2026-09-01",
] as const;

export type SampleEntry = DrawEntry & { quarter: number };
export type SampleLogRecord = { id: string; rank: number; outcome: Outcome; quarter: number };

export type Screeners = {
  screen1: (post: FramePost) => Promise<ScreenDecision>;
  preflight: (post: FramePost) => Promise<PreflightResult | null>;
  screen2: (post: FramePost, finalUrl: string, text: string) => Promise<ScreenDecision>;
  render?: (finalUrl: string) => string | Promise<string>;
};

/** 1..4 inside the window; 0 outside (never sampled). */
export function quarterOf(iso: string): number {
  const i = QUARTER_STARTS.findIndex((s, j) => iso >= s && iso < QUARTER_STARTS[j + 1]);
  return i + 1;
}

function projectKey(url: string): string | null {
  try {
    const b = deriveBoundary(url);
    return `${b.host}${b.pathPrefix ?? ""}`;
  } catch {
    return null;
  }
}

function hostsFromEntries(entries: { entry_url: string }[]): Set<string> {
  const hosts = new Set<string>();
  for (const e of entries) {
    const k = projectKey(e.entry_url);
    if (k) hosts.add(k);
  }
  return hosts;
}

function splitByQuarter(posts: FramePost[]): Record<number, FramePost[]> {
  const by: Record<number, FramePost[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of posts) {
    const q = quarterOf(p.created_at);
    if (q >= 1 && q <= 4) by[q].push(p);
  }
  return by;
}

async function walkQuarters({
  byQuarter,
  perQuarter,
  screeners,
  seed,
  hosts,
  startN,
  filterIds,
}: {
  byQuarter: Record<number, FramePost[]>;
  perQuarter: number;
  screeners: Screeners;
  seed: string;
  hosts: Set<string>;
  startN: number;
  filterIds?: Set<string>;
}) {
  const entries: SampleEntry[] = [];
  const log: SampleLogRecord[] = [];
  let nBase = startN;

  for (const q of [1, 2, 3, 4] as const) {
    let posts = byQuarter[q];
    if (filterIds) posts = posts.filter((p) => !filterIds.has(p.id));
    const r = await drawScreened({
      posts,
      seed,
      targetN: perQuarter,
      hosts,
      ...screeners,
    });
    for (const e of r.entries) {
      entries.push({ ...e, quarter: q, n: nBase + e.n });
    }
    for (const rec of r.log) {
      log.push({ ...rec, quarter: q });
    }
    nBase += r.entries.length;
  }

  return { entries, log, counts: prismaCounts(log) };
}

/** Stratified 4×perQuarter draw with one shared duplicate set across quarters. */
export async function drawSample({
  posts,
  perQuarter,
  screeners,
  seed = SAMPLING_SEED,
}: {
  posts: FramePost[];
  perQuarter: number;
  screeners: Screeners;
  seed?: string;
}) {
  const byQuarter = splitByQuarter(posts);
  const hosts = new Set<string>();
  const { entries, log, counts } = await walkQuarters({
    byQuarter,
    perQuarter,
    screeners,
    seed,
    hosts,
    startN: 0,
  });
  const perQuarterCounts: Record<number, ReturnType<typeof prismaCounts>> = {};
  for (const q of [1, 2, 3, 4]) {
    perQuarterCounts[q] = prismaCounts(log.filter((r) => r.quarter === q));
  }
  return { entries, log, counts, perQuarterCounts, hosts };
}

/** D-55a: continue each quarter past its first perQuarter without disturbing them. */
export async function extendSample({
  posts,
  previousLog,
  previousEntries,
  perQuarter,
  screeners,
  seed = SAMPLING_SEED,
}: {
  posts: FramePost[];
  previousLog: { id: string }[];
  previousEntries: SampleEntry[];
  perQuarter: number;
  screeners: Screeners;
  seed?: string;
}) {
  const walked = new Set(previousLog.map((r) => r.id));
  const hosts = hostsFromEntries(previousEntries);
  const byQuarter = splitByQuarter(posts);
  return walkQuarters({
    byQuarter,
    perQuarter,
    screeners,
    seed,
    hosts,
    startN: previousEntries.length,
    filterIds: walked,
  });
}

export function buildSubsets(
  entries: SampleEntry[],
  log: SampleLogRecord[],
  {
    secondModelN = 100,
    recallN = 10,
    auditN = 50,
  }: { secondModelN?: number; recallN?: number; auditN?: number } = {},
) {
  const sampleIds = entries.map((e) => ({ id: e.hn_id }));
  const ordered = sortPilotCandidates(sampleIds, GOLD_SEED).map((x) => x.id);
  const a3Excluded = ordered.filter((id) => id === ARTCRAFT_HN_ID);
  const goldOrder = ordered.filter((id) => id !== ARTCRAFT_HN_ID);

  const secondModel = sortPilotCandidates(sampleIds, SECOND_MODEL_SEED)
    .slice(0, secondModelN)
    .map((x) => x.id);
  const recall = sortPilotCandidates(sampleIds, RECALL_SEED)
    .slice(0, recallN)
    .map((x) => x.id);

  const contentCodes = new Set<string>(MODEL_REASON_CODES);
  const auditPool = log
    .filter(
      (r) =>
        r.outcome.kind === "excluded" &&
        "reasonCode" in r.outcome &&
        contentCodes.has(r.outcome.reasonCode as string),
    )
    .map((r) => ({ id: r.id }));
  const auditSorted = sortPilotCandidates(auditPool, SCREENING_AUDIT_SEED).map((x) => x.id);
  // Unique ids keep one slot per candidate if the same id somehow appeared twice.
  const auditSeen = new Set<string>();
  const audit: string[] = [];
  for (const id of auditSorted) {
    if (auditSeen.has(id)) continue;
    auditSeen.add(id);
    audit.push(id);
    if (audit.length >= auditN) break;
  }

  return {
    seeds: {
      sampling: SAMPLING_SEED,
      screeningAudit: SCREENING_AUDIT_SEED,
      gold: GOLD_SEED,
      recall: RECALL_SEED,
      secondModel: SECOND_MODEL_SEED,
    },
    goldOrder,
    a3Excluded,
    secondModel,
    recall,
    auditPool: auditSorted,
    audit,
  };
}

const PREWARM_PER_QUARTER = 500;
const PREWARM_CONCURRENCY = 2;
const fatalScreeningError = (error: unknown) => ["BudgetExceededError", "ReservationExceededError", "QuotaStop", "TooLargeError", "NebiusError", "ScreeningHttpError", "ScreeningDecisionError"].includes((error as Error)?.name);

/** Cache screen1/preflight/screen2 for the first N candidates per quarter (no render). */
export async function prewarmSample({
  posts,
  screeners,
  seed = SAMPLING_SEED,
  perQuarter = PREWARM_PER_QUARTER,
  concurrency = PREWARM_CONCURRENCY,
}: {
  posts: FramePost[];
  screeners: Screeners;
  seed?: string;
  perQuarter?: number;
  concurrency?: number;
}) {
  const byQuarter = splitByQuarter(posts);
  if (concurrency !== 1 && concurrency !== 2) throw new Error("screening concurrency must be one or two");
  const limit = pLimit(concurrency);
  const jobs: Promise<void>[] = [];
  let stopped: unknown;
  for (const q of [1, 2, 3, 4] as const) {
    const ordered = sortPilotCandidates(byQuarter[q], seed).slice(0, perQuarter);
    for (const p of ordered) {
      jobs.push(
        limit(async () => {
          if (stopped) return;
          try {
            const s1 = await screeners.screen1(p);
            if (!s1.include) return;
            const pref = await screeners.preflight(p);
            if (!pref || pref.preflight.robots_blocked || !pref.preflight.boundary_ok) return;
            const text = pref.page_text ?? "";
            if (text.length < MIN_STAGE2_CHARS) return;
            await screeners.screen2(p, pref.final_url, text);
          } catch (error) {
            if (fatalScreeningError(error)) stopped ??= error;
            // ponytail: skip a flaky pre-warm call; the walk retries via the same cache
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (stopped) throw stopped;
}

/** Budget reservations are durable before HTTP and charged conservatively after an interrupted run. */
export function openScreeningBudget({ dataDir, scope, cap }: { dataDir: string; scope: string; cap: number }) {
  if (!/^[a-f0-9]{64}$/.test(scope) || !Number.isFinite(cap) || cap <= 0) throw new Error("invalid screening budget scope or cap");
  const dir = path.join(dataDir, "validation", "screening-budgets"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${scope}.json`); const lockFile = `${file}.lock`;
  let lock: number;
  try { lock = fs.openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const before = fs.statSync(lockFile); const owner = Number(fs.readFileSync(lockFile, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("invalid screening budget lease");
    let alive = true; try { process.kill(owner, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; alive = false; }
    if (alive) throw new Error("screening budget lease is active");
    const after = fs.statSync(lockFile);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error("screening budget lease changed");
    fs.unlinkSync(lockFile); lock = fs.openSync(lockFile, "wx", 0o600);
  }
  fs.writeFileSync(lock, String(process.pid));
  try {
    const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (prior && (prior.version !== 1 || prior.scope !== scope || prior.cap !== cap)) throw new Error("screening budget differs from retained cap, scope or version");
    if (prior && ![prior.spent, prior.reserved, prior.estimated].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("invalid retained screening budget");
    const persist = (state: BudgetState) => {
      const next = `${file}.next`; const fd = fs.openSync(next, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, scope, ...state }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(next, file);
    };
    const budget = new DollarBudget(cap, { initialSpent: prior ? prior.spent + prior.reserved : 0, onChange: persist });
    budget.estimated = prior?.estimated ?? 0;
    persist({ ...budget.snapshot(), reserved: 0 });
    let released = false;
    return { budget, file, release() { if (!released) { try { persist({ ...budget.snapshot(), reserved: budget.reserved }); } finally { released = true; fs.closeSync(lock); fs.unlinkSync(lockFile); } } } };
  } catch (error) { fs.closeSync(lock); fs.unlinkSync(lockFile); throw error; }
}

export function createScreeningClient({ budget, apiKey, fetchImpl, concurrency = 1 }: { budget: DollarBudget; apiKey: string; fetchImpl?: FetchImpl; concurrency?: number }) {
  if (concurrency !== 1 && concurrency !== 2) throw new Error("screening concurrency must be one or two");
  priceOf(SCREENER_MODEL);
  const client = createClient({ baseUrl: PINNED_BASE_URL, apiKey, budget, fetchImpl, tokenCap: DEFAULT_TOKEN_CAP, maxRetries: 0, concurrency, stage: "screening" });
  return { ...client, async request(requestPath: string, init: { method: string; body: unknown }) {
    const body = init.body as { model?: string; messages?: unknown[] };
    if (requestPath !== "/chat/completions" || init.method !== "POST" || body?.model !== SCREENER_MODEL || !Array.isArray(body.messages) || !body.messages.length) throw new Error("screening requires the pinned priced model and chat messages");
    const result = await client.request(requestPath, init);
    if (result.outcome === "too-large") { const details = result.json as { estimate: number; cap: number }; throw new TooLargeError(details.estimate, details.cap); }
    if (isQuotaResponse(result)) throw new QuotaStop(result.status, "screening quota stop");
    if (!result.ok) { const error = new Error("screening HTTP failed"); error.name = "ScreeningHttpError"; throw error; }
    return result;
  } };
}

function writePrivateJson(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

type SampleCliDependencies = {
  dataDir?: string; apiKey?: string; fetchImpl?: FetchImpl; log?: (line: string) => void;
  screenersFactory?: (client: ReturnType<typeof createScreeningClient>, cacheDir: string) => Screeners;
};

export async function runSampleCli(argv: string[] = process.argv, dependencies: SampleCliDependencies = {}) {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const perQuarter = argv.includes("--per-quarter") ? Number(arg("--per-quarter")) : 75;
  const extendN = argv.includes("--extend") ? Number(arg("--extend")) : undefined;
  const requested = extendN ?? perQuarter;
  const log = dependencies.log ?? console.log;
  const accounting = { stage: extendN === undefined ? "screening-draw" : "screening-extend", total: Number.isInteger(requested) ? requested * 4 : 0, included: 0, httpCalls: 0, failed: 0, stopped: false, ok: false, complete: false, reason: null as string | null, countsBasis: "completed walk result; interrupted progress is reconstructed from the retained stage cache" };
  let opened: ReturnType<typeof openScreeningBudget> | undefined;
  try {
  const flags = new Set(["--screening-budget", "--budget", "--token-factory-budget"]);
  const budgets = argv.flatMap((flag, i) => flags.has(flag) ? [Number(argv[i + 1])] : []);
  if (!budgets.length) { const error = new Error("explicit screening budget required"); error.name = "ScreeningBudgetRequired"; throw error; }
  if (new Set(budgets).size !== 1) throw new Error("conflicting screening budgets");
  const cap = requireTfBudget({ argv: argv.map(flag => flag === "--screening-budget" ? "--budget" : flag), env: {} });
  const concurrency = argv.includes("--screening-concurrency") ? Number(arg("--screening-concurrency")) : 1;
  if (!Number.isInteger(requested) || requested <= 0 || (concurrency !== 1 && concurrency !== 2)) throw new Error("invalid screening draw limits");
  const dataDir = dependencies.dataDir ?? resolveDataDir();
  const dir = path.join(dataDir, "pipeline");
  const frameText = fs.readFileSync(path.join(dir, "frame.json"), "utf8");
  const posts: FramePost[] = JSON.parse(frameText).posts;
  let previousEntries: SampleEntry[] = []; let previousLog: SampleLogRecord[] = [];
  if (extendN !== undefined) {
    previousEntries = JSON.parse(fs.readFileSync(path.join(dir, "sample-projects.json"), "utf8"));
    previousLog = JSON.parse(fs.readFileSync(path.join(dir, "sample-screening-log.json"), "utf8")).log;
    if (!Array.isArray(previousEntries) || !Array.isArray(previousLog)) throw new Error("previous draw is incomplete");
  }
  const scope = crypto.createHash("sha256").update(JSON.stringify({ mode: accounting.stage, perQuarter: requested, seed: SAMPLING_SEED, model: SCREENER_MODEL, frameDigest: crypto.createHash("sha256").update(frameText).digest("hex"), previousEntries, previousLog })).digest("hex");
  opened = openScreeningBudget({ dataDir, scope, cap }); log(opened.budget.budgetLine());
  const apiKey = dependencies.apiKey ?? readKey("NEBIUS_API_KEY", "nebius.key");
  if (!apiKey) throw new Error("screening credential unavailable");
  const transport = dependencies.fetchImpl ?? fetch;
  const client = createScreeningClient({ budget: opened.budget, apiKey, concurrency, fetchImpl: async (...args) => { accounting.httpCalls++; return transport(...args); } });
  const factory = dependencies.screenersFactory ?? ((client, cacheDir) => makeScreeners({ client, cacheDir, preflightVersion: 2 }));
  const base = factory(client, path.join(dataDir, "pipeline", "cache"));
  const decide = async <T>(work: () => Promise<T>) => {
    try { return await work(); } catch (error) {
      if (fatalScreeningError(error)) throw error;
      const failure = new Error("screening decision failed"); failure.name = "ScreeningDecisionError"; throw failure;
    }
  };
  const screeners: Screeners = { ...base, screen1: p => decide(() => base.screen1(p)), screen2: (p, url, text) => decide(() => base.screen2(p, url, text)) };

  if (extendN !== undefined) {
    const ext = await extendSample({
      posts,
      previousLog,
      previousEntries,
      perQuarter: extendN,
      screeners,
      seed: SAMPLING_SEED,
    });
    accounting.included = ext.entries.length;
    if ([1, 2, 3, 4].some(q => ext.entries.filter(e => e.quarter === q).length !== extendN)) throw new Error("screening frame exhausted");
    writePrivateJson(dir, "fresh-projects.json", ext.entries);
    writePrivateJson(dir, "fresh-screening-log.json", {
      seed: SAMPLING_SEED,
      perQuarter: extendN,
      model: SCREENER_MODEL,
      counts: ext.counts,
      log: ext.log,
    });
    log(`PRISMA: ${JSON.stringify(ext.counts)}`);
    accounting.complete = accounting.included === accounting.total; accounting.ok = accounting.complete;
    return accounting;
  }

  await prewarmSample({ posts, screeners, seed: SAMPLING_SEED, concurrency });
  const result = await drawSample({ posts, perQuarter, screeners, seed: SAMPLING_SEED });
  accounting.included = result.entries.length;
  if ([1, 2, 3, 4].some(q => result.entries.filter(e => e.quarter === q).length !== perQuarter)) throw new Error("screening frame exhausted");
  const subsets = buildSubsets(result.entries, result.log);

  writePrivateJson(dir, "sample-projects.json", result.entries);
  writePrivateJson(dir, "sample-screening-log.json", {
    seed: SAMPLING_SEED,
    perQuarter,
    model: SCREENER_MODEL,
    counts: result.counts,
    perQuarterCounts: result.perQuarterCounts,
    log: result.log,
  });
  writePrivateJson(dir, "sample-subsets.json", subsets);

  log(`PRISMA: ${JSON.stringify(result.counts)}`);
  log(`SUBSETS: ${JSON.stringify({
      gold: subsets.goldOrder.length,
      a3Excluded: subsets.a3Excluded.length,
      secondModel: subsets.secondModel.length,
      recall: subsets.recall.length,
      auditPool: subsets.auditPool.length,
      audit: subsets.audit.length,
    })}`);
  accounting.complete = accounting.included === accounting.total; accounting.ok = accounting.complete;
  } catch (error) {
    accounting.reason = (error as Error).name ?? "Error"; accounting.failed = 1; accounting.stopped = fatalScreeningError(error);
  } finally {
    if (opened) log(opened.budget.budgetLine());
    try { opened?.release(); } catch { accounting.ok = false; accounting.complete = false; accounting.failed = 1; accounting.reason = "ScreeningBudgetPersistenceError"; }
    log(`ACCOUNTING: ${JSON.stringify(accounting)}`);
  }
  return accounting;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSampleCli().then(result => { if (!result.ok) process.exitCode = 1; }).catch((err) => {
    console.error(`screening stopped: ${err?.name ?? "Error"}`);
    process.exitCode = 1;
  });
}

