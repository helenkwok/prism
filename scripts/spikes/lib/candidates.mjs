// Pick the three candidate models (Ultra, Super, Lightning) from the
// catalogue already recorded in spikes/nebius.md (plan 01-07). Shared by
// nebius-matrix.mjs, nebius-escape-probe.mjs and nebius-pin.mjs so the same
// name-pattern match is not duplicated three times (mirrors the pattern
// already used once in nebius-batch.mjs's local pickCandidates).

export const CANDIDATE_PATTERNS = [
  ["ultra", /ultra/i],
  ["super", /super/i],
  ["lightning", /lightning/i],
];

/** One model id per label, deduped across hosts, in ultra/super/lightning order. */
export function pickCandidateModels(catalogue) {
  const out = [];
  for (const [label, re] of CANDIDATE_PATTERNS) {
    const entry = (catalogue ?? []).find((e) => typeof e?.id === "string" && re.test(e.id));
    if (!entry) throw new Error(`no ${label} model found in the catalogue`);
    if (!out.some((o) => o.id === entry.id)) out.push({ label, id: entry.id, pricing: entry.pricing ?? {} });
  }
  return out;
}
