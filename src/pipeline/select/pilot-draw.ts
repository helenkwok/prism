// D-42: the 20-project pilot draw — a seeded, deterministic sample over
// whatever has passed screening (DSC-02) at draw time. Follows the project's
// established sortKey(seed, id) ascending-sort method
// (src/pipeline/select/slice-projects.ts), duplicated here as a small pure
// function rather than imported, so this module has no dependency on
// slice-projects.ts's 10-project-slice-specific file I/O.

import crypto from "node:crypto";

// Generated 2026-10-15 via:
//   node -e "console.log(require('node:crypto').randomBytes(8).toString('hex'))"
// Scoped to this phase's 20-project pilot draw only — distinct from
// protocol/PROTOCOL.md section 1's five official seeds (Sampling, Screening
// audit, Gold labels, Collection recall, Second-model subsample) and from
// Phase 2's SLICE_DRAW_SEED (D-42).
export const PILOT_DRAW_SEED = "1abb039e005ec5ca";

function sortKey(seed: string, id: string): string {
  return crypto.createHash("sha256").update(`${seed}:${id}`).digest("hex");
}

// The full pool in deterministic draw order — same seed, same pool, same
// order, every call. Exported (rather than only the capped top-N below) so a
// caller that needs to skip candidates that fail some out-of-band check
// (e.g. preflight reachability, which this module deliberately has no I/O
// to perform itself) can walk further down the same order instead of
// re-seeding or accepting a short draw.
export function sortPilotCandidates<T extends { id: string }>(candidates: T[], seed: string = PILOT_DRAW_SEED): T[] {
  return [...candidates].sort((a, b) => (sortKey(seed, a.id) < sortKey(seed, b.id) ? -1 : 1));
}

export function selectPilotProjects({
  candidates,
  seed = PILOT_DRAW_SEED,
  targetN = 20,
}: {
  candidates: { id: string }[];
  seed?: string;
  targetN?: number;
}): { id: string }[] {
  const sorted = sortPilotCandidates(candidates, seed);

  if (sorted.length < targetN) {
    throw new Error(`exhausted the pilot draw pool with only ${candidates.length} of ${targetN} candidates`);
  }

  return sorted.slice(0, targetN);
}
