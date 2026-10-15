// EVD-06: injection-pattern detector (D-39, D-40, D-41).
//
// This detector is illustrative, not exhaustive (D-40) — a short, auditable
// regex list, not a security boundary. Detection exists only so an injection
// attempt is visible in Phase 4's human confirmation queue (D-41, which also
// wants the triggering span ids, not a bare boolean); it never gates, filters
// or alters any coding result. The real defense against an embedded
// instruction is the existing output contract (contract.ts's
// {checkId, proposedState, spanIds}-only shape, no free-text verdict field)
// plus applyQuoteOrUnknownFilter's downgrade-only quote-or-unknown rule
// (filter.ts, D-39) — both unmodified by this file.

export interface InjectionFlagResult {
  detected: boolean;
  spanIds: string[];
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore (all |the )?previous instructions/i,
  /mark all checks/i,
  /you are an? (ai|assistant|language model)/i,
  /^(system|assistant):/im,
];

/**
 * For each span, test every pattern against its text. Returns the ids of
 * spans matching at least one pattern, and whether any matched at all.
 */
export function detectInjection(spans: { id: string; text: string }[]): InjectionFlagResult {
  const spanIds = spans.filter((span) => INSTRUCTION_PATTERNS.some((p) => p.test(span.text))).map((span) => span.id);
  return { detected: spanIds.length > 0, spanIds };
}
