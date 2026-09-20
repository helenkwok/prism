// Pure helpers for the Tavily spike: documented credit formulas, selector
// regexes, the per-project ceiling and summary statistics. No network, no I/O.
//
// Documented rates (docs.tavily.com api-credits, read 2026-09-20):
//   map      1 credit per 10 successful pages, 2 with `instructions`
//   extract  1 credit per 5 successful URLs at basic depth, 2 at advanced
//   search   1 credit basic, 2 advanced
//   failed extract or map requests are not charged

export const CEILING_CREDITS = 40; // D-16: at most 40 credits per project

export function mapCredits(pages, { instructions = false } = {}) {
  return Math.ceil(pages / 10) * (instructions ? 2 : 1);
}

export function extractCredits(successes, depth = "basic") {
  return Math.ceil(successes / 5) * (depth === "advanced" ? 2 : 1);
}

export function searchCredits(depth = "basic") {
  return depth === "advanced" ? 2 : 1;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty numeric list. */
export function percentile(values, p) {
  if (values.length === 0) throw new Error("percentile of an empty list");
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ci = (s) => [...s].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escapeRe(ch))).join("");

/**
 * Anchored regex selectors for a boundary (see preflight.deriveBoundary). The
 * patterns are regular expressions on the Tavily side, so every one is anchored
 * and every dot is escaped.
 */
export function selectorsFor(boundary) {
  const host = boundary.host.toLowerCase();
  const domain = boundary.exact || boundary.pathPrefix ? `^${ci(host)}$` : `^(?:.+\\.)?${ci(host)}$`;
  const out = { select_domains: [domain] };
  if (boundary.pathPrefix) out.select_paths = [`^${ci(boundary.pathPrefix)}(?:/.*)?$`];
  return out;
}

/** Tracks credits against the per-project ceiling. Conservative: the larger of per-call and formula. */
export class CreditBudget {
  constructor(ceiling = CEILING_CREDITS) {
    this.ceiling = ceiling;
    this.perCall = 0;
    this.formula = 0;
  }
  get tally() {
    return Math.max(this.perCall, this.formula);
  }
  /** True when a call projected at `projected` credits still fits under the ceiling. */
  allows(projected) {
    return this.tally + projected <= this.ceiling;
  }
  record({ perCall, formula }) {
    this.perCall += perCall ?? 0;
    this.formula += formula ?? 0;
  }
}

const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|json|xml|zip|gz|tar|mp4|mp3|wav|woff2?|ttf|pdf|dmg|exe)$/i;

/** True for URLs that are page-like rather than assets. */
export function isPageLike(url) {
  try {
    return !ASSET_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
