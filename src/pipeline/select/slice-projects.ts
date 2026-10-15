// D-26/D-27: the 10-project vertical slice — the 5 real projects already
// measured in the Phase 1 Tavily spike, plus 5 new projects drawn
// deterministically from the DSC-01 frame (protocol/PROTOCOL.md section 1's
// "seeded draw" method: sort ascending by sha256(`${seed}:${hn_id}`)).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { AI_TITLE, preflightCandidate } from "../../../scripts/spikes/pick-projects.mjs";
import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "../../../scripts/check-data-dir.mjs";

// Generated 2026-10-15 via:
//   node -e "console.log(require('node:crypto').randomBytes(8).toString('hex'))"
// Scoped to this phase's 10-project slice only — distinct from, and never
// substituted for, any of protocol/PROTOCOL.md section 1's five official
// seeds (Sampling, Screening audit, Gold labels, Collection recall,
// Second-model subsample), because this draw is not part of the official
// ~300-project sample.
export const SLICE_DRAW_SEED = "58ccec070ccb8d4e";

export interface FramePostLike {
  id: string;
  title: string;
  url: string;
  created_at: string;
}

export interface FrameLike {
  posts: FramePostLike[];
}

export interface ReusedProjectRecord {
  hn_id: string;
  title: string;
  entry_url: string;
  final_url: string;
  boundary: unknown;
  type_class: string;
  created_at: string;
}

export interface SliceEntry {
  n: number;
  source: "phase1-spike" | "phase2-drawn";
  hn_id: string;
  title: string;
  entry_url: string;
  final_url: string;
  boundary: unknown;
  type_class: string;
  created_at: string;
}

export type PreflightFn = (candidate: {
  id: string;
  title: string;
  url: string;
  created_at: string;
}) => Promise<{
  entry_url: string;
  final_url: string;
  boundary: unknown;
  type_class: string;
  preflight: { robots_blocked: boolean; boundary_ok: boolean };
} | null>;

function resolveDataDir(): string {
  const root = resolveRepoRoot(process.cwd());
  const dir = resolvePrivateDir(process.env, root);
  return assertOutsideRepo(dir, root);
}

function sortKey(seed: string, id: string): string {
  return crypto.createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

export async function selectSliceProjects({
  frame,
  reusedProjectsPath = path.join(resolveDataDir(), "spikes", "projects.json"),
  preflight = preflightCandidate as unknown as PreflightFn,
  seed = SLICE_DRAW_SEED,
  targetNew = 5,
}: {
  frame: FrameLike;
  reusedProjectsPath?: string;
  preflight?: PreflightFn;
  seed?: string;
  targetNew?: number;
}): Promise<SliceEntry[]> {
  const reused: ReusedProjectRecord[] = JSON.parse(fs.readFileSync(reusedProjectsPath, "utf8"));
  const reusedEntries: SliceEntry[] = reused.map((p, i) => ({
    n: i + 1,
    source: "phase1-spike",
    hn_id: p.hn_id,
    title: p.title,
    entry_url: p.entry_url,
    final_url: p.final_url,
    boundary: p.boundary,
    type_class: p.type_class,
    created_at: p.created_at,
  }));
  const reusedIds = new Set(reusedEntries.map((p) => p.hn_id));

  const pool = frame.posts
    .filter((post) => AI_TITLE.test(post.title ?? "") && !reusedIds.has(post.id))
    .sort((a, b) => (sortKey(seed, a.id) < sortKey(seed, b.id) ? -1 : 1));

  const drawn: SliceEntry[] = [];
  for (const post of pool) {
    if (drawn.length >= targetNew) break;
    const p = await preflight({ id: post.id, title: post.title, url: post.url, created_at: post.created_at });
    if (!p || p.preflight.robots_blocked || !p.preflight.boundary_ok) continue;
    drawn.push({
      n: reusedEntries.length + drawn.length + 1,
      source: "phase2-drawn",
      hn_id: post.id,
      title: post.title,
      entry_url: p.entry_url,
      final_url: p.final_url,
      boundary: p.boundary,
      type_class: p.type_class,
      created_at: post.created_at,
    });
  }

  if (drawn.length < targetNew) {
    throw new Error(`exhausted the draw pool with only ${drawn.length} of ${targetNew} new projects found`);
  }

  const combined = [...reusedEntries, ...drawn];

  const pipelineDir = path.join(resolveDataDir(), "pipeline");
  fs.mkdirSync(pipelineDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pipelineDir, "slice-projects.json"), JSON.stringify(combined, null, 2), {
    mode: 0o600,
  });

  return combined;
}
