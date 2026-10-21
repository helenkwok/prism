// D-66 free own-site collector: homepage + sitemap + in-boundary links.
// No Tavily. Cap ~20 pages, ≤1 rps/host, robots before every page.
// Thin pages still go through render.ts in run.ts after this returns.

import {
  deriveBoundary,
  followRedirects,
  isAllowed,
  parseRobots,
  PreflightError,
  withinBoundary,
  type Boundary,
  type RobotsGroup,
} from "./boundary.ts";
import { isPageLike, type CollectCallResult, type CollectProjectPagesResult, type CollectedPage } from "./tavily.ts";

export type FetchImpl = typeof fetch;

const PAGE_CAP = 20;
const READ_BODY = 500_000;
const MIN_INTERVAL_MS = 1000;
const USER_AGENT = "PRISM-research/0.1 (+https://github.com/helenkwok/prism)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Block-level tags that should become line breaks (D-67; keep structure for segmenter). */
const BLOCK_CLOSE_RE =
  /<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|nav|main|aside|blockquote|pre|ul|ol|table|thead|tbody|tfoot)\s*>/gi;
const BR_RE = /<br\s*\/?>/gi;

/**
 * Visible text from HTML. Inserts newlines at block boundaries; collapses
 * horizontal whitespace within a line only (does not flatten the whole page).
 */
export function pageText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(BR_RE, "\n")
    .replace(BLOCK_CLOSE_RE, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Absolute http(s) hrefs from HTML, resolved against baseUrl. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("javascript:")) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      u.hash = "";
      out.push(u.toString());
    } catch {
      // skip
    }
  }
  return out;
}

/** `<loc>` URLs from a sitemap or sitemap-index body. */
export function parseSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    try {
      const u = new URL(m[1].trim());
      if (u.protocol === "https:" || u.protocol === "http:") locs.push(u.toString());
    } catch {
      // skip
    }
  }
  return locs;
}

type HostThrottle = { lastAt: number };

async function throttleHost(host: string, map: Map<string, HostThrottle>): Promise<void> {
  const prev = map.get(host);
  const now = Date.now();
  if (prev) {
    const wait = MIN_INTERVAL_MS - (now - prev.lastAt);
    if (wait > 0) await sleep(wait);
  }
  map.set(host, { lastAt: Date.now() });
}

async function robotsForUrl(
  pageUrl: string,
  cache: Map<string, RobotsGroup[] | "missing">,
  opts: {
    fetchImpl: FetchImpl;
    calls: CollectCallResult[];
    hostThrottle: Map<string, HostThrottle>;
    resolver?: Resolver;
  },
): Promise<{ allowed: boolean; status: number }> {
  let origin: string;
  let pathWithQuery: string;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
    pathWithQuery = u.pathname + u.search;
  } catch {
    return { allowed: false, status: 0 };
  }

  let groups = cache.get(origin);
  if (groups === undefined) {
    await throttleHost(new URL(origin).hostname, opts.hostThrottle);
    try {
      const r = await followRedirects(`${origin}/robots.txt`, {
        readBody: 200_000,
        maxHops: 5,
        fetchImpl: opts.fetchImpl,
        resolver: opts.resolver,
        userAgent: USER_AGENT,
      });
      if (r.status === 404 || r.status === 410) {
        cache.set(origin, "missing");
        groups = "missing";
      } else if (r.status >= 500) {
        opts.calls.push({ pages: [], failed: true, reason: `robots.txt status ${r.status}`, status: r.status });
        return { allowed: false, status: r.status };
      } else if (r.status >= 400) {
        cache.set(origin, "missing");
        groups = "missing";
      } else {
        groups = parseRobots(r.body);
        cache.set(origin, groups);
      }
    } catch (e) {
      opts.calls.push({
        pages: [],
        failed: true,
        reason: e instanceof PreflightError ? e.code : e instanceof Error ? e.message : String(e),
      });
      return { allowed: false, status: 0 };
    }
  }

  if (groups === "missing") return { allowed: true, status: 404 };
  return { allowed: isAllowed(groups, pathWithQuery, ["*", "PRISM-research"]), status: 200 };
}

/**
 * Collect a project's own pages without Tavily (D-66).
 * Shape matches CollectProjectPagesResult so run.ts can swap collectors.
 */
type Resolver = (hostname: string) => Promise<string[]>;

export async function collectOwnSitePages({
  boundary,
  startUrl,
  fetchImpl = fetch,
  pageCap = PAGE_CAP,
  resolver,
}: {
  boundary: Boundary;
  startUrl: string;
  fetchImpl?: FetchImpl;
  pageCap?: number;
  /** Injected DNS resolver for tests (production uses the default in followRedirects). */
  resolver?: Resolver;
}): Promise<CollectProjectPagesResult> {
  const calls: CollectCallResult[] = [];
  const pages: CollectedPage[] = [];
  const seen = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const missingUrls: string[] = [];
  const robotsCache = new Map<string, RobotsGroup[] | "missing">();
  const hostThrottle = new Map<string, HostThrottle>();
  const robotsOpts = { fetchImpl, calls, hostThrottle, resolver };
  let mapUrlCount = 0;
  let offBoundaryCount = 0;

  const enqueue = (url: string) => {
    let normalized: string;
    try {
      const u = new URL(url);
      u.hash = "";
      normalized = u.toString();
    } catch {
      return;
    }
    if (!withinBoundary(normalized, boundary)) {
      offBoundaryCount += 1;
      return;
    }
    if (!isPageLike(normalized)) return;
    if (seen.has(normalized) || queued.has(normalized)) return;
    queued.add(normalized);
    queue.push(normalized);
    mapUrlCount += 1;
  };

  enqueue(startUrl);

  // Sitemap seeds (same origin as start when possible).
  try {
    const start = new URL(startUrl);
    for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
      const smUrl = `${start.origin}${path}`;
      if (!withinBoundary(smUrl, boundary) && path === "/sitemap.xml") {
        // still try origin sitemap for own-domain starts
      }
      const robots = await robotsForUrl(smUrl, robotsCache, robotsOpts);
      if (!robots.allowed) continue;
      try {
        await throttleHost(start.hostname, hostThrottle);
        const r = await followRedirects(smUrl, {
          readBody: READ_BODY,
          maxHops: 5,
          fetchImpl,
          resolver,
          boundary,
          userAgent: USER_AGENT,
        });
        if (r.status >= 200 && r.status < 300 && r.body) {
          for (const loc of parseSitemapLocs(r.body)) enqueue(loc);
          // One level of sitemap index.
          if (/<sitemapindex/i.test(r.body)) {
            for (const child of parseSitemapLocs(r.body).slice(0, 5)) {
              if (!withinBoundary(child, boundary)) continue;
              const childRobots = await robotsForUrl(child, robotsCache, robotsOpts);
              if (!childRobots.allowed) continue;
              try {
                await throttleHost(new URL(child).hostname, hostThrottle);
                const cr = await followRedirects(child, {
                  readBody: READ_BODY,
                  maxHops: 5,
                  fetchImpl,
                  resolver,
                  boundary,
                  userAgent: USER_AGENT,
                });
                if (cr.status >= 200 && cr.status < 300) {
                  for (const loc of parseSitemapLocs(cr.body)) enqueue(loc);
                }
              } catch {
                // skip child sitemap
              }
            }
          }
        }
      } catch {
        // sitemap optional
      }
    }
  } catch {
    // bad startUrl — enqueue already no-op'd
  }

  while (queue.length > 0 && pages.length < pageCap) {
    const url = queue.shift()!;
    queued.delete(url);
    if (seen.has(url)) continue;
    seen.add(url);

    const robots = await robotsForUrl(url, robotsCache, robotsOpts);
    if (!robots.allowed) {
      calls.push({ pages: [], refused: true, reason: "robots.txt disallows", status: robots.status });
      missingUrls.push(url);
      continue;
    }

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      missingUrls.push(url);
      continue;
    }

    try {
      await throttleHost(host, hostThrottle);
      const r = await followRedirects(url, {
        readBody: READ_BODY,
        maxHops: 5,
        fetchImpl,
        resolver,
        boundary,
        userAgent: USER_AGENT,
        timeoutMs: 20000,
      });
      if (r.status < 200 || r.status >= 300 || !r.boundaryOk) {
        calls.push({ pages: [], failed: true, reason: `fetch status ${r.status} boundaryOk=${r.boundaryOk}`, status: r.status });
        missingUrls.push(url);
        continue;
      }
      const finalUrl = r.finalUrl;
      if (!withinBoundary(finalUrl, boundary)) {
        offBoundaryCount += 1;
        missingUrls.push(url);
        continue;
      }
      // Cross-origin within boundary: re-check final origin robots.
      if (new URL(finalUrl).origin !== new URL(url).origin) {
        const fr = await robotsForUrl(finalUrl, robotsCache, robotsOpts);
        if (!fr.allowed) {
          calls.push({ pages: [], refused: true, reason: "robots.txt disallows final", status: fr.status });
          missingUrls.push(url);
          continue;
        }
      }
      const text = pageText(r.body);
      const page: CollectedPage = { url: finalUrl, rawText: text };
      pages.push(page);
      calls.push({ pages: [page] });
      if (pages.length >= pageCap) break;
      for (const link of extractLinks(r.body, finalUrl)) enqueue(link);
    } catch (e) {
      calls.push({
        pages: [],
        failed: true,
        reason: e instanceof PreflightError ? e.code : e instanceof Error ? e.message : String(e),
      });
      missingUrls.push(url);
    }
  }

  return {
    pages,
    creditsSpent: 0,
    mapUrlCount,
    offBoundaryCount,
    calls,
    missingUrls: [...new Set(missingUrls)],
  };
}

// Re-export for callers that need boundary helpers next to the collector.
export { deriveBoundary, withinBoundary };
