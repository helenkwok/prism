// DSC-01: the 12-month Show HN sampling frame, built from two-sided weekly
// Algolia windows with a hard exhaustiveness gate. See protocol/PROTOCOL.md
// section 1 for the frozen window and the exhaustiveness rule.
//
// Unlike scripts/spikes/pick-projects.mjs's fetchCandidates() (spike-only,
// since-epoch filter, no exhaustiveness check), this is the real frame
// builder: every window's response must assert exhaustive.nbHits === true,
// and the author field is never stored.

import fs from "node:fs";
import path from "node:path";

import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "../../../scripts/check-data-dir.mjs";

const ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";

/** 2025-09-01T00:00:00Z to 2026-09-01T00:00:00Z exclusive (protocol/PROTOCOL.md section 1). */
export const REVIEW_WINDOW = {
  startEpoch: 1756684800,
  endEpochExclusive: 1788220800,
} as const;

export interface FramePost {
  id: string;
  title: string;
  url: string;
  points: number;
  num_comments: number;
  created_at: string;
  story_id: string;
  tags: string[];
}

export interface FrameResult {
  builtAt: string;
  window: { startEpoch: number; endEpochExclusive: number };
  windowCount: number;
  posts: FramePost[];
}

interface AlgoliaHit {
  objectID: string;
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  created_at_i: number;
  story_id?: string;
  _tags?: string[];
}

interface AlgoliaResponse {
  exhaustive?: { nbHits?: boolean };
  hits?: AlgoliaHit[];
}

export type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<AlgoliaResponse>;
}>;

function resolveDataDir(): string {
  const root = resolveRepoRoot(process.cwd());
  const dir = resolvePrivateDir(process.env, root);
  return assertOutsideRepo(dir, root);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function buildFrame({
  fetchImpl = fetch as unknown as FetchImpl,
  startEpoch = REVIEW_WINDOW.startEpoch,
  endEpochExclusive = REVIEW_WINDOW.endEpochExclusive,
  windowSeconds = 7 * 24 * 3600,
  sleepMs = 1100,
}: {
  fetchImpl?: FetchImpl;
  startEpoch?: number;
  endEpochExclusive?: number;
  windowSeconds?: number;
  sleepMs?: number;
} = {}): Promise<FrameResult> {
  const byId = new Map<string, FramePost>();
  let windowCount = 0;

  for (let t0 = startEpoch; t0 < endEpochExclusive; t0 += windowSeconds) {
    const t1 = Math.min(t0 + windowSeconds, endEpochExclusive);
    const u = new URL(ALGOLIA);
    u.searchParams.set("tags", "story,show_hn");
    u.searchParams.set("numericFilters", `created_at_i>=${t0},created_at_i<${t1}`);
    u.searchParams.set("hitsPerPage", "1000");

    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      throw new Error(`algolia request failed with status ${res.status} for window [${t0},${t1})`);
    }
    const json = await res.json();
    const hits = json.hits ?? [];
    if (json.exhaustive?.nbHits !== true) {
      throw new Error(
        `window [${t0},${t1}) is not exhaustive (exhaustive.nbHits=${String(json.exhaustive?.nbHits)}, hits=${hits.length}); refusing to write a possibly-truncated frame`,
      );
    }

    for (const h of hits) {
      if (!h.objectID) continue;
      // Explicit allow-list only: never destructure-and-spread the raw hit,
      // and never read h.author (no founder personal data, T-02-01).
      const post: FramePost = {
        id: h.objectID,
        title: h.title ?? "",
        url: h.url ?? "",
        points: h.points ?? 0,
        num_comments: h.num_comments ?? 0,
        created_at: new Date(h.created_at_i * 1000).toISOString(),
        story_id: h.story_id ?? h.objectID,
        tags: h._tags ?? [],
      };
      byId.set(post.id, post);
    }

    windowCount += 1;
    await sleep(sleepMs);
  }

  const result: FrameResult = {
    builtAt: new Date().toISOString(),
    window: { startEpoch, endEpochExclusive },
    windowCount,
    posts: [...byId.values()],
  };

  const pipelineDir = path.join(resolveDataDir(), "pipeline");
  fs.mkdirSync(pipelineDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pipelineDir, "frame.json"), JSON.stringify(result, null, 2), { mode: 0o600 });

  return result;
}
