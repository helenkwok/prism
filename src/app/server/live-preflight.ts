// APP-02 / D-80: a live run starts only on a site that is on Helen's own or an
// opted-in company's list. Consent comes from the list, never from
// reachability: an off-list URL is refused before any DNS lookup or request,
// however public it is and whatever its robots.txt says. Pure: no TanStack.

import { parseHttpsUrl, PreflightError, resolveSafe, withinBoundary, type Boundary } from "../../pipeline/evidence/boundary.ts";

export type PreflightRefusal = "bad-url" | "off-list" | "private-address" | "dns-fail";
export type PreflightResult = { ok: true; boundary: Boundary } | { ok: false; reason: PreflightRefusal };

/** `boundaries` are the own and opt-in boundaries only; checks run in the order bad-url, off-list, address. */
export async function preflightLiveUrl(
  url: string,
  boundaries: readonly Boundary[],
  { resolver }: { resolver?: (hostname: string) => Promise<string[]> } = {},
): Promise<PreflightResult> {
  let u: URL;
  try {
    u = parseHttpsUrl(url);
  } catch {
    return { ok: false, reason: "bad-url" }; // not-https, bad-port, credentials, unparsable
  }
  const href = u.toString();
  const boundary = boundaries.find((b) => withinBoundary(href, b));
  if (!boundary) return { ok: false, reason: "off-list" };
  try {
    await resolveSafe(u.hostname, resolver);
  } catch (e) {
    if (e instanceof PreflightError && e.code === "private-address") return { ok: false, reason: "private-address" };
    return { ok: false, reason: "dns-fail" };
  }
  return { ok: true, boundary };
}
