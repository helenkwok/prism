// DSC-03 + D-50: stratified 4×75 sample over window-aligned quarters (protocol R03),
// plus D-52 seeded subsets and D-55a extension past the first 300.
//   node src/pipeline/select/draw-sample.ts [--per-quarter 75] [--extend 19]

import { deriveBoundary } from "../evidence/boundary.ts";
import {
  drawScreened,
  prismaCounts,
  type DrawEntry,
  type FramePost,
  type Outcome,
  type PreflightResult,
} from "./draw.ts";
import { sortPilotCandidates } from "./pilot-draw.ts";
import { MODEL_REASON_CODES, type ScreenDecision } from "./screen-model.ts";

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
