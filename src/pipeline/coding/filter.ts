// COD-02: the quote-or-unknown filter. Downgrade-only and idempotent — it
// never reads or creates an upgrade path (unknown/fail -> pass/claimed is
// Phase 4's human-confirmation flow, COD-08, not this function's job).

import type { CheckEntry, ProposedState } from "./contract.ts";

const QUOTE_REQUIRED: ProposedState[] = ["pass", "claimed", "fail"];

/**
 * For each check: if proposedState is pass/claimed/fail and spanIds is empty,
 * or any spanIds entry is not in knownSpanIds, rewrite proposedState to
 * "unknown" and spanIds to []. An already-"unknown" check passes through
 * with spanIds cleared to [] too (so a second pass over the function's own
 * output is a no-op). Nothing is ever upgraded.
 */
export function applyQuoteOrUnknownFilter(checks: CheckEntry[], knownSpanIds: string[]): CheckEntry[] {
  const known = new Set(knownSpanIds);
  return checks.map((check) => {
    if (check.proposedState === "unknown") {
      return { ...check, spanIds: [] };
    }
    const hasUnresolvedSpan = check.spanIds.some((id) => !known.has(id));
    if (QUOTE_REQUIRED.includes(check.proposedState) && (check.spanIds.length === 0 || hasUnresolvedSpan)) {
      return { ...check, proposedState: "unknown", spanIds: [] };
    }
    return { ...check };
  });
}
