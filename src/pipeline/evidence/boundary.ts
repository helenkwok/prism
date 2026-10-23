// Production boundary + SSRF-guarded fetch (EVD-01). Promoted from
// scripts/spikes/lib/preflight.mjs verbatim, except the own-domain branch of
// deriveBoundary: it now uses tldts.getDomain() (the registrable domain via
// the Public Suffix List) instead of the spike's www-stripped-hostname
// heuristic, so a non-www subdomain resolves to the same boundary as its
// parent domain. The shared-path-host and shared-suffix-host branches, and
// every SSRF/robots function, are unchanged.
//
// The DNS answer checked by resolveSafe is not pinned to the socket fetch()
// opens (a rebinding gap). pinned-fetch.ts closes it: pass pinnedFetch as
// fetchImpl and every connect re-checks the addresses it actually uses.

import dns from "node:dns/promises";
import net from "node:net";
import { getDomain } from "tldts";

export class PreflightError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

// ---- address classes --------------------------------------------------------

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, includes the cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local, includes fd00:ec2::254
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 32], // Teredo: the client address is obfuscated, and Teredo is never a project's own site
  ["100::", 64], // discard-only
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a trailing dotted IPv4 folded in). */
function ipv6Groups(address: string): number[] {
  let s = address.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const parts = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return parts.map((p) => parseInt(p, 16));
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when the address is loopback, private, link-local, unique-local, multicast or metadata. */
export function isBlockedAddress(address: string): boolean {
  const a = String(address).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (net.isIPv4(a)) return BLOCKED.check(a, "ipv4");
  if (net.isIPv6(a)) {
    const g = ipv6Groups(a);
    const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
    // Encodings that carry an IPv4 address: judge the embedded IPv4.
    if (firstFiveZero && g[5] === 0xffff) return BLOCKED.check(v4Of(g[6], g[7]), "ipv4"); // IPv4-mapped ::ffff:0:0/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return BLOCKED.check(v4Of(g[6], g[7]), "ipv4"); // NAT64 64:ff9b::/96
    if (firstFiveZero && g[5] === 0 && !(g[6] === 0 && g[7] <= 1)) return BLOCKED.check(v4Of(g[6], g[7]), "ipv4"); // IPv4-compatible ::/96 (:: and ::1 fall through, blocked below)
    if (g[0] === 0x2002) return BLOCKED.check(v4Of(g[1], g[2]), "ipv4"); // 6to4 2002::/16
    return BLOCKED.check(a, "ipv6");
  }
  return true; // not an address at all: refuse
}

type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/**
 * https only, DNS-resolve with all addresses, reject if ANY address is in a
 * blocked range. The resolver is injectable. Returns the address list.
 */
export async function resolveSafe(hostname: string, resolver: Resolver = defaultResolver): Promise<string[]> {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PreflightError("private-address", "hostname is a local or internal name");
  }
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await resolver(host);
    } catch {
      throw new PreflightError("dns-fail", "hostname did not resolve");
    }
  }
  if (!Array.isArray(addrs) || addrs.length === 0) throw new PreflightError("dns-fail", "hostname did not resolve");
  for (const addr of addrs) {
    if (isBlockedAddress(addr)) {
      throw new PreflightError("private-address", "hostname resolves to a private, loopback, link-local or metadata address");
    }
  }
  return addrs;
}

export function parseHttpsUrl(url: string, base?: string): URL {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    throw new PreflightError("bad-url", "not a valid URL");
  }
  if (u.protocol !== "https:") throw new PreflightError("not-https", "only https URLs are followed");
  if (u.port !== "" && u.port !== "443") throw new PreflightError("bad-port", "only the default https port is allowed");
  if (u.username !== "" || u.password !== "") throw new PreflightError("bad-url", "credentials in URL");
  return u;
}

// ---- boundary ---------------------------------------------------------------

// Hosts where many unrelated projects share one hostname, so the boundary is a
// path prefix rather than the host.
export const SHARED_PATH_HOSTS = ["github.com", "huggingface.co"];
// Hosts where each project gets its own subdomain of a shared suffix, so the
// boundary is that exact subdomain and never the suffix.
export const SHARED_SUFFIXES = ["github.io", "vercel.app", "netlify.app", "pages.dev", "hf.space", "onrender.com", "fly.dev", "streamlit.app", "gitlab.io"];

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "");

export type HostClass = "shared-path-host" | "shared-suffix-host" | "own-domain";

export function hostClass(hostname: string): HostClass {
  const h = stripWww(hostname);
  if (SHARED_PATH_HOSTS.includes(h)) return "shared-path-host";
  if (SHARED_SUFFIXES.some((s) => h === s || h.endsWith("." + s))) return "shared-suffix-host";
  return "own-domain";
}

export interface Boundary {
  host: string;
  pathPrefix?: string;
  exact?: boolean;
}

/**
 * Derive the boundary of a project from its entry URL. A boundary is
 * { host } (the registrable domain and its subdomains, leading www ignored)
 * or, for shared-path hosts, { host, pathPrefix } (exact host, path under the
 * prefix). A shared-suffix host is { host, exact: true }: never expanded to
 * subdomains.
 *
 * The EVD-01 fix: the own-domain case's host is tldts.getDomain(url) (the
 * Public Suffix List registrable domain), not the prior www-stripped-hostname
 * heuristic — so a non-www subdomain (blog.example.com) resolves to the same
 * boundary (example.com) as its parent. Falls back to the old heuristic only
 * when tldts cannot parse the host (e.g. a bare IP).
 */
export function deriveBoundary(url: string): Boundary {
  const u = new URL(url);
  const host = stripWww(u.hostname);
  const segs = u.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (host === "github.com" && segs.length >= 2) return { host, pathPrefix: `/${segs[0]}/${segs[1]}` };
  if (host === "huggingface.co" && segs.length >= 2) {
    const n = ["spaces", "datasets"].includes(segs[0]) ? 3 : 2;
    if (segs.length >= n) return { host, pathPrefix: "/" + segs.slice(0, n).join("/") };
  }
  if (hostClass(host) === "shared-suffix-host") return { host, exact: true };
  const registrable = getDomain(url);
  return { host: registrable ?? host };
}

/** True when `url` lies inside `boundary` (see deriveBoundary). */
export function withinBoundary(url: string, boundary: Boundary): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = stripWww(u.hostname);
  const bhost = stripWww(boundary.host);
  if (boundary.pathPrefix) {
    if (host !== bhost) return false;
    const p = u.pathname.toLowerCase();
    const prefix = boundary.pathPrefix.toLowerCase().replace(/\/+$/, "");
    return p === prefix || p.startsWith(prefix + "/");
  }
  if (boundary.exact) return host === bhost;
  return host === bhost || host.endsWith("." + bhost);
}

// ---- redirect follower --------------------------------------------------------

export interface FollowRedirectsResult {
  hops: { url: string; status: number }[];
  finalUrl: string;
  status: number;
  boundaryOk: boolean;
  body: string;
}

type FetchImpl = typeof fetch;

/**
 * Follow redirects by hand: redirect "manual", no cookies, https only, DNS
 * checked before every connection. Returns
 *   { hops: [{ url, status }], finalUrl, status, boundaryOk, body }
 * where boundaryOk is true only when EVERY URL in the chain (the requested URL,
 * each intermediate hop, the final URL) is inside `boundary` (when supplied).
 * A redirect that leaves the boundary is not followed: the result is the
 * last in-boundary hop with boundaryOk false and an empty body. Throws PreflightError on a bad scheme, a blocked address, or more than
 * maxHops redirects. `fetchImpl` and `resolver` are injectable.
 */
export async function followRedirects(
  url: string,
  opts: {
    maxHops?: number;
    resolver?: Resolver;
    fetchImpl?: FetchImpl;
    boundary?: Boundary | null;
    readBody?: number;
    timeoutMs?: number;
    userAgent?: string;
  } = {},
): Promise<FollowRedirectsResult> {
  const { maxHops = 5, resolver, fetchImpl = fetch, boundary = null, readBody = 0, timeoutMs = 12000, userAgent = "PRISM-research-spike/0.0" } = opts;
  const hops: { url: string; status: number }[] = [];
  let current = parseHttpsUrl(url).toString();
  let boundaryOk = boundary ? withinBoundary(current, boundary) : true;
  for (let i = 0; ; i += 1) {
    const u = parseHttpsUrl(current);
    await resolveSafe(u.hostname, resolver);
    const res = await fetchImpl(u.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": userAgent, accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = res.status;
    hops.push({ url: u.toString(), status });
    const location = res.headers?.get?.("location");
    if (status >= 300 && status < 400 && location) {
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
      if (i >= maxHops) throw new PreflightError("too-many-hops", `more than ${maxHops} redirects`);
      const next = parseHttpsUrl(location, u.toString()).toString();
      // An off-boundary hop is never requested: consent covers the boundary only.
      if (boundary && !withinBoundary(next, boundary)) return { hops, finalUrl: u.toString(), status, boundaryOk: false, body: "" };
      current = next;
      continue;
    }
    let body = "";
    if (readBody > 0 && res.body) {
      body = await readCapped(res, readBody);
    } else {
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
    }
    return { hops, finalUrl: u.toString(), status, boundaryOk, body };
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= cap) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, cap));
}

// ---- robots ---------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/** Parse robots.txt into groups: [{ agents: [lowercase tokens], rules: [{ allow, pattern }] }]. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (!cur) continue;
      // An empty Disallow allows everything: it adds no rule.
      if (value === "") continue;
      cur.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const src = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + src + (anchored ? "$" : ""));
}

/**
 * Longest-match wins; on a tie Allow beats Disallow. `agents` are the crawler
 * tokens to look for; a group naming one of them is used, else the `*` group,
 * else everything is allowed. `path` includes the query string when present.
 */
export function isAllowed(groups: RobotsGroup[], path: string, agents: string[] = ["*"]): boolean {
  const wanted = agents.map((a) => a.toLowerCase()).filter((a) => a !== "*");
  let group = groups.find((g) => g.agents.some((a) => wanted.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.pattern).test(path)) continue;
    const len = rule.pattern.replace(/\*/g, "").length;
    if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) {
      best = { len, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}
