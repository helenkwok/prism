// Spike pre-flight: an https-only, SSRF-blocked redirect follower, a boundary
// check and a minimal robots matcher (research Pitfalls 8; decisions D-16, EVD-01
// groundwork).
//
// These are spike-only approximations. Phase 2 replaces the domain logic with
// the Public Suffix List and robots-parser. Two known limits, both recorded in
// the spike commentary rather than solved here:
//   - the DNS answer checked here is not pinned to the socket fetch() opens
//     (a rebinding gap); Phase 7's SSRF guard closes it;
//   - only HTTP redirects are followed, not meta-refresh or script redirects.

import dns from "node:dns/promises";
import net from "node:net";

export class PreflightError extends Error {
  constructor(code, message) {
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
]) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local, includes fd00:ec2::254
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
]) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** True when the address is loopback, private, link-local, unique-local, multicast or metadata. */
export function isBlockedAddress(address) {
  const a = String(address).replace(/^\[|\]$/g, "");
  if (net.isIPv4(a)) return BLOCKED.check(a, "ipv4");
  if (net.isIPv6(a)) {
    const lower = a.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) and NAT64 (64:ff9b::/96): judge the embedded v4.
    const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (dotted) return BLOCKED.check(dotted[1], "ipv4");
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return BLOCKED.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return BLOCKED.check(a, "ipv6");
  }
  return true; // not an address at all: refuse
}

const defaultResolver = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/**
 * https only, DNS-resolve with all addresses, reject if ANY address is in a
 * blocked range. The resolver is injectable. Returns the address list.
 */
export async function resolveSafe(hostname, resolver = defaultResolver) {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PreflightError("private-address", "hostname is a local or internal name");
  }
  let addrs;
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

function parseHttpsUrl(url, base) {
  let u;
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

const stripWww = (h) => h.toLowerCase().replace(/^www\./, "");

export function hostClass(hostname) {
  const h = stripWww(hostname);
  if (SHARED_PATH_HOSTS.includes(h)) return "shared-path-host";
  if (SHARED_SUFFIXES.some((s) => h === s || h.endsWith("." + s))) return "shared-suffix-host";
  return "own-domain";
}

/**
 * Derive the boundary of a project from its entry URL. A boundary is
 * { host } (same host or a subdomain of it, leading www ignored) or, for
 * shared-path hosts, { host, pathPrefix } (exact host, path under the prefix).
 * A shared-suffix host is { host, exact: true }: never expanded to subdomains.
 */
export function deriveBoundary(url) {
  const u = new URL(url);
  const host = stripWww(u.hostname);
  const segs = u.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (host === "github.com" && segs.length >= 2) return { host, pathPrefix: `/${segs[0]}/${segs[1]}` };
  if (host === "huggingface.co" && segs.length >= 2) {
    const n = ["spaces", "datasets"].includes(segs[0]) ? 3 : 2;
    if (segs.length >= n) return { host, pathPrefix: "/" + segs.slice(0, n).join("/") };
  }
  if (hostClass(host) === "shared-suffix-host") return { host, exact: true };
  return { host };
}

/** True when `url` lies inside `boundary` (see deriveBoundary). */
export function withinBoundary(url, boundary) {
  let u;
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

/**
 * Follow redirects by hand: redirect "manual", no cookies, https only, DNS
 * checked before every connection. Returns
 *   { hops: [{ url, status }], finalUrl, status, boundaryOk, body }
 * where boundaryOk is true only when EVERY URL in the chain (the requested URL,
 * each intermediate hop, the final URL) is inside `boundary` (when supplied).
 * Throws PreflightError on a bad scheme, a blocked address, or more than
 * maxHops redirects. `fetchImpl` and `resolver` are injectable.
 */
export async function followRedirects(url, opts = {}) {
  const { maxHops = 5, resolver, fetchImpl = fetch, boundary = null, readBody = 0, timeoutMs = 12000, userAgent = "PRISM-research-spike/0.0" } = opts;
  const hops = [];
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
      const next = parseHttpsUrl(location, u).toString();
      if (boundary && !withinBoundary(next, boundary)) boundaryOk = false;
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

async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const chunks = [];
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

/** Parse robots.txt into groups: [{ agents: [lowercase tokens], rules: [{ allow, pattern }] }]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
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

function patternToRegex(pattern) {
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
export function isAllowed(groups, path, agents = ["*"]) {
  const wanted = agents.map((a) => a.toLowerCase()).filter((a) => a !== "*");
  let group = groups.find((g) => g.agents.some((a) => wanted.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.pattern).test(path)) continue;
    const len = rule.pattern.replace(/\*/g, "").length;
    if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) {
      best = { len, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}
