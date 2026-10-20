// DSC-03 + D-50: stratified 4×75 sample over window-aligned quarters (protocol R03),
// plus D-52 seeded subsets and D-55a extension past the first 300.
//   node src/pipeline/select/draw-sample.ts [--per-quarter 75] [--extend 19]

import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";

import { resolveDataDir } from "../../app/server/db.ts";
import { defaultCacheDir } from "../cache/stage-cache.ts";
import { createClient, PINNED_BASE_URL } from "../coding/nebius-client.ts";
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
const PREWARM_CONCURRENCY = 8;

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
  const limit = pLimit(concurrency);
  const jobs: Promise<void>[] = [];
  for (const q of [1, 2, 3, 4] as const) {
    const ordered = sortPilotCandidates(byQuarter[q], seed).slice(0, perQuarter);
    for (const p of ordered) {
      jobs.push(
        limit(async () => {
          try {
            const s1 = await screeners.screen1(p);
            if (!s1.include) return;
            const pref = await screeners.preflight(p);
            if (!pref || pref.preflight.robots_blocked || !pref.preflight.boundary_ok) return;
            const text = pref.page_text ?? "";
            if (text.length < MIN_STAGE2_CHARS) return;
            await screeners.screen2(p, pref.final_url, text);
          } catch {
            // ponytail: skip a flaky pre-warm call; the walk retries via the same cache
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
}

function writePrivateJson(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function runSampleCli(argv: string[] = process.argv) {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const perQuarter = Number(arg("--per-quarter") ?? 75);
  const extendN = arg("--extend") !== undefined ? Number(arg("--extend")) : undefined;

  const dataDir = resolveDataDir();
  const dir = path.join(dataDir, "pipeline");
  const posts: FramePost[] = JSON.parse(fs.readFileSync(path.join(dir, "frame.json"), "utf8")).posts;
  const apiKey = readKey("NEBIUS_API_KEY", "nebius.key");
  if (!apiKey) throw new Error("NEBIUS_API_KEY / nebius.key missing");
  const client = createClient({ baseUrl: PINNED_BASE_URL, apiKey });
  const screeners = makeScreeners({ client, cacheDir: defaultCacheDir(), preflightVersion: 2 });

  if (extendN !== undefined) {
    const previousEntries: SampleEntry[] = JSON.parse(fs.readFileSync(path.join(dir, "sample-projects.json"), "utf8"));
    const previousLogFile = JSON.parse(fs.readFileSync(path.join(dir, "sample-screening-log.json"), "utf8"));
    const previousLog = previousLogFile.log as SampleLogRecord[];
    const ext = await extendSample({
      posts,
      previousLog,
      previousEntries,
      perQuarter: extendN,
      screeners,
      seed: SAMPLING_SEED,
    });
    writePrivateJson(dir, "fresh-projects.json", ext.entries);
    writePrivateJson(dir, "fresh-screening-log.json", {
      seed: SAMPLING_SEED,
      perQuarter: extendN,
      model: SCREENER_MODEL,
      counts: ext.counts,
      log: ext.log,
    });
    console.log("PRISMA:", JSON.stringify(ext.counts));
    return;
  }

  await prewarmSample({ posts, screeners, seed: SAMPLING_SEED });
  const result = await drawSample({ posts, perQuarter, screeners, seed: SAMPLING_SEED });
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

  console.log("PRISMA:", JSON.stringify(result.counts));
  console.log(
    "SUBSETS:",
    JSON.stringify({
      gold: subsets.goldOrder.length,
      a3Excluded: subsets.a3Excluded.length,
      secondModel: subsets.secondModel.length,
      recall: subsets.recall.length,
      auditPool: subsets.auditPool.length,
      audit: subsets.audit.length,
    }),
  );

  for (const q of [1, 2, 3, 4]) {
    const n = result.entries.filter((e) => e.quarter === q).length;
    if (n < perQuarter) {
      console.error(`quarter ${q}: ${n} included (wanted ${perQuarter})`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSampleCli().catch((err) => {
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  });
}

