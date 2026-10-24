// Tavily evidence collection, scoped to a project's own boundary (EVD-02).
// The pure credit-math functions are promoted from
// scripts/spikes/lib/tavily-math.mjs verbatim; the REST call and
// collectProjectPages() are new, modeled on scripts/spikes/tavily-probe.mjs's
// hand-rolled tavily() wrapper and map->extract flow (D-16, D-30).

import { scrubSecrets } from "./redact.ts";
import { withinBoundary, type Boundary } from "./boundary.ts";

// ---- pure credit math (scripts/spikes/lib/tavily-math.mjs, unchanged) ------

// Documented rates (docs.tavily.com api-credits):
//   map      1 credit per 10 successful pages, 2 with `instructions`
//   extract  1 credit per 5 successful URLs at basic depth, 2 at advanced
//   search   1 credit basic, 2 advanced
//   failed extract or map requests are not charged

export const CEILING_CREDITS = 40; // D-16: at most 40 credits per project

export function mapCredits(pages: number, { instructions = false }: { instructions?: boolean } = {}): number {
  return Math.ceil(pages / 10) * (instructions ? 2 : 1);
}

export function extractCredits(successes: number, depth: "basic" | "advanced" = "basic"): number {
  return Math.ceil(successes / 5) * (depth === "advanced" ? 2 : 1);
}

export function searchCredits(depth: "basic" | "advanced" = "basic"): number {
  return depth === "advanced" ? 2 : 1;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty numeric list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of an empty list");
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ci = (s: string) => [...s].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escapeRe(ch))).join("");

/**
 * Anchored regex selectors for a boundary (see boundary.deriveBoundary). The
 * patterns are regular expressions on the Tavily side, so every one is anchored
 * and every dot is escaped.
 */
export function selectorsFor(boundary: Boundary): { select_domains: string[]; select_paths?: string[] } {
  const host = boundary.host.toLowerCase();
  const domain = boundary.exact || boundary.pathPrefix ? `^${ci(host)}$` : `^(?:.+\\.)?${ci(host)}$`;
  const out: { select_domains: string[]; select_paths?: string[] } = { select_domains: [domain] };
  if (boundary.pathPrefix) out.select_paths = [`^${ci(boundary.pathPrefix)}(?:/.*)?$`];
  return out;
}

/** Tracks credits against the per-project ceiling. Conservative: the larger of per-call and formula. */
export class CreditBudget {
  ceiling: number;
  perCall = 0;
  formula = 0;
  constructor(ceiling = CEILING_CREDITS) {
    this.ceiling = ceiling;
  }
  get tally(): number {
    return Math.max(this.perCall, this.formula);
  }
  /** True when a call projected at `projected` credits still fits under the ceiling. */
  allows(projected: number): boolean {
    return this.tally + projected <= this.ceiling;
  }
  record({ perCall, formula }: { perCall?: number; formula?: number }): void {
    this.perCall += perCall ?? 0;
    this.formula += formula ?? 0;
  }
}

const ASSET_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|json|xml|zip|gz|tar|mp4|mp3|wav|woff2?|ttf|pdf|dmg|exe)$/i;
/** Bundler / framework static paths (often extensionless chunk URLs). */
const ASSET_PATH = /(?:^|\/)_next\/static(?:\/|$)|(?:^|\/)static\/(?:css|js|chunks)(?:\/|$)/i;

/** True for URLs that are page-like rather than assets. */
export function isPageLike(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    if (ASSET_EXT.test(pathname)) return false;
    if (ASSET_PATH.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---- REST call (new) ---------------------------------------------------------

export class TavilyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const API = "https://api.tavily.com";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FetchImpl = typeof fetch;

/**
 * POST (or GET) a Tavily endpoint. Retries on 429/5xx with a fixed backoff, up
 * to `attempts` total. Never echoes the response body on a thrown error (it
 * can carry the requested URL); the API key is scrubbed from any error text.
 */
export async function tavily(
  endpoint: string,
  body: unknown,
  { apiKey, fetchImpl = fetch, method = "POST", attempts = 2 }: { apiKey: string; fetchImpl?: FetchImpl; method?: "GET" | "POST"; attempts?: number },
): Promise<{ status: number; ok: boolean; json: unknown; ms: number }> {
  if (!apiKey) throw new TavilyError(0, "apiKey is required");
  for (let attempt = 1; ; attempt += 1) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(`${API}${endpoint}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000),
      });
    } catch (e: any) {
      if (attempt < attempts) {
        await sleep(2000);
        continue;
      }
      const msg = scrubSecrets(`network failure on ${endpoint}: ${e?.cause?.code ?? e?.name ?? "error"}`, [apiKey]);
      throw new TavilyError(0, msg);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return { status: res.status, ok: true, json, ms: Date.now() - t0 };
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const retryAfter = Number(res.headers.get("retry-after")) || 5;
      await sleep(Math.min(20000, retryAfter * 1000));
      continue;
    }
    // Never echo the response body: it can carry the requested URL.
    const msg = scrubSecrets(`tavily ${endpoint} returned status ${res.status}`, [apiKey]);
    throw new TavilyError(res.status, msg);
  }
}

export interface CollectedPage {
  url: string;
  rawText: string;
}

export interface CollectCallResult {
  pages: CollectedPage[];
  failed?: boolean;
  reason?: string;
  refused?: boolean;
  /** HTTP status when the call failed (e.g. 432/433 usage limit). */
  status?: number;
}

export interface CollectProjectPagesResult {
  pages: CollectedPage[];
  creditsSpent: number;
  mapUrlCount: number;
  offBoundaryCount: number;
  calls: CollectCallResult[];
  /** EVD-05: URLs still empty/failed after the one advanced retry. */
  missingUrls: string[];
}

/** Live runs only (Helen, 2026-10-24): map at most 20 URLs, extract the 10 most relevant. Never the bulk pipeline. */
export const LEAN = { mapLimit: 20, extractCap: 10 } as const;

// The collector had no page priority (start URL, then map order), so lean mode adds one: the home
// page, then docs, pricing, security and about pages (the pages that carry most decision evidence),
// then the rest in map order. Matched on the path, case-insensitive.
const LEAN_PRIORITY = [/^\/?$/, /(^|\/)(docs?|documentation|guide|guides|api)(\/|$)/i, /(^|\/)pricing(\/|$)/i, /(^|\/)(security|trust|privacy)(\/|$)/i, /(^|\/)(about|company|team)(\/|$)/i];
function leanRank(url: string): number {
  let p: string;
  try {
    p = new URL(url).pathname;
  } catch {
    return LEAN_PRIORITY.length;
  }
  const i = LEAN_PRIORITY.findIndex((re) => re.test(p));
  return i === -1 ? LEAN_PRIORITY.length : i;
}
/** The start URL first, then by lean rank; stable, so ties keep map order. */
export function leanOrder(startUrl: string, urls: string[]): string[] {
  const rest = urls.filter((u) => u !== startUrl).map((u, i) => ({ u, i, r: leanRank(u) }));
  rest.sort((a, b) => a.r - b.r || a.i - b.i);
  return [startUrl, ...rest.map((x) => x.u)];
}

const EMPTY_BELOW_CHARS = 100;
const isEmptyContent = (r: { raw_content?: unknown }) => typeof r.raw_content !== "string" || r.raw_content.trim().length < EMPTY_BELOW_CHARS;

/**
 * Collect a project's own pages: map (allow_external: false, anchored to the
 * boundary), filter to within-boundary, extract at most extractCap pages at
 * basic depth (the entry URL first), one advanced retry for failed/empty
 * results. A non-2xx or network-failure response from a single map/extract
 * call is caught and recorded for that call — it never aborts the whole
 * project. Only a budget-ceiling violation is a hard stop within this
 * function, and even that returns a structured result rather than throwing.
 */
export async function collectProjectPages({
  boundary,
  startUrl,
  apiKey,
  fetchImpl = fetch,
  mapLimit = 50,
  mapDepth = 2,
  extractCap = 20,
  allowUrl,
  budget = new CreditBudget(CEILING_CREDITS),
  prioritise = false,
}: {
  boundary: Boundary;
  startUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** robots.txt first: checked for the start URL before map, and for every URL before extract. */
  allowUrl?: (url: string) => Promise<boolean>;
  mapLimit?: number;
  mapDepth?: number;
  extractCap?: number;
  /** Shared across a run's calls (a live run's per-run credit cap); default a fresh 40-credit ceiling. */
  budget?: CreditBudget;
  /** Lean mode: order candidates by leanOrder before taking extractCap of them. */
  prioritise?: boolean;
}): Promise<CollectProjectPagesResult> {
  const startTally = budget.tally;
  const calls: CollectCallResult[] = [];
  const sel = selectorsFor(boundary);

  if (allowUrl && !(await allowUrl(startUrl))) {
    calls.push({ pages: [], refused: true, reason: "robots.txt disallows" });
    return { pages: [], creditsSpent: 0, mapUrlCount: 0, offBoundaryCount: 0, calls, missingUrls: [] };
  }

  // 1. map
  const mapUrls: string[] = [];
  const projectedMap = mapCredits(mapLimit);
  if (!budget.allows(projectedMap)) {
    calls.push({ pages: [], refused: true, reason: "map call would exceed the credit ceiling" });
    return { pages: [], creditsSpent: budget.tally - startTally, mapUrlCount: 0, offBoundaryCount: 0, calls, missingUrls: [] };
  }
  try {
    const mapBody = { url: startUrl, max_depth: mapDepth, limit: mapLimit, allow_external: false, include_usage: true, ...sel };
    const map = await tavily("/map", mapBody, { apiKey, fetchImpl });
    const json = map.json as { results?: string[]; usage?: { credits?: number } } | null;
    const results = Array.isArray(json?.results) ? json!.results! : [];
    mapUrls.push(...results);
    const mapFormula = mapCredits(results.length);
    const mapPerCall = json?.usage?.credits ?? 0;
    budget.record({ perCall: mapPerCall, formula: mapFormula });
    calls.push({ pages: [] });
  } catch (e) {
    calls.push({
      pages: [],
      failed: true,
      reason: e instanceof Error ? e.message : String(e),
      status: e instanceof TavilyError ? e.status : undefined,
    });
  }

  // 2. code-side boundary filter
  const offBoundary = mapUrls.filter((u) => !withinBoundary(u, boundary));
  const inBoundary = [...new Set(mapUrls.filter((u) => withinBoundary(u, boundary)))];
  const pageLike = inBoundary.filter((u) => isPageLike(u));
  const ordered = prioritise ? leanOrder(startUrl, pageLike) : [startUrl, ...pageLike.filter((u) => u !== startUrl)];
  const candidates = [...new Set(ordered)].filter((u) => withinBoundary(u, boundary));
  const toExtract: string[] = [];
  for (const u of candidates) {
    if (toExtract.length >= extractCap) break;
    if (!allowUrl || (await allowUrl(u))) toExtract.push(u);
  }

  const byUrl = new Map<string, string>();
  const failedUrls: string[] = [];

  const doExtract = async (urls: string[], depth: "basic" | "advanced"): Promise<void> => {
    if (urls.length === 0) return;
    const projected = extractCredits(urls.length, depth);
    if (!budget.allows(projected)) {
      calls.push({ pages: [], refused: true, reason: `${depth} extract of ${urls.length} urls would exceed the credit ceiling` });
      return;
    }
    try {
      const body = { urls, extract_depth: depth, format: "markdown", include_usage: true };
      const r = await tavily("/extract", body, { apiKey, fetchImpl });
      const json = r.json as { results?: { url: string; raw_content?: string }[]; failed_results?: { url: string }[]; usage?: { credits?: number } } | null;
      const results = Array.isArray(json?.results) ? json!.results! : [];
      const successes = results.length;
      const formula = extractCredits(successes, depth);
      const perCall = json?.usage?.credits ?? 0;
      budget.record({ perCall, formula });
      for (const res of results) {
        if (!isEmptyContent(res)) byUrl.set(res.url, res.raw_content ?? "");
        else failedUrls.push(res.url);
      }
      for (const f of json?.failed_results ?? []) failedUrls.push(f.url);
      calls.push({ pages: results.map((res) => ({ url: res.url, rawText: res.raw_content ?? "" })) });
    } catch (e) {
      calls.push({
        pages: [],
        failed: true,
        reason: e instanceof Error ? e.message : String(e),
        status: e instanceof TavilyError ? e.status : undefined,
      });
      failedUrls.push(...urls);
    }
  };

  await doExtract(toExtract, "basic");

  // 3. one advanced retry for failed/empty results only (EVD-05 groundwork)
  const retryUrls = [...new Set(failedUrls)].filter((u) => !byUrl.has(u));
  if (retryUrls.length > 0) {
    failedUrls.length = 0;
    await doExtract(retryUrls, "advanced");
  }

  const pages: CollectedPage[] = toExtract.filter((u) => byUrl.has(u)).map((u) => ({ url: u, rawText: byUrl.get(u)! }));
  // EVD-05: failedUrls at this point holds exactly what the advanced retry's own
  // doExtract call populated (it was reset to length 0 immediately before that
  // call ran) — or is still empty when the basic attempt never needed a retry.
  const missingUrls = [...new Set(failedUrls)];

  return {
    pages,
    creditsSpent: budget.tally - startTally,
    mapUrlCount: mapUrls.length,
    offBoundaryCount: offBoundary.length,
    calls,
    missingUrls,
  };
}
