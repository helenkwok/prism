// D-80: fetch-compatible HTTPS client whose socket can only connect to an
// address that passed isBlockedAddress. It closes the DNS-rebinding gap that
// resolveSafe alone leaves (resolveSafe checks one answer, fetch() resolves
// again): here the lookup hook resolves, checks EVERY address, and hands only
// those checked addresses to the socket. Drop it into followRedirects /
// collectOwnSitePages as fetchImpl.
//
// Limits, by design:
// - Node never calls the lookup hook for an IP-literal host, so callers keep
//   resolveSafe before connecting (followRedirects does). pinnedFetch also
//   refuses a blocked IP literal itself, as a second line.
// - Redirects are never followed here; followRedirects follows them by hand
//   and re-runs resolveSafe and this connect-time check on every hop.
// - Thin-page rendering through a browser resolves and loads on its own and is
//   outside this guard; the server live run disables rendering (D-80, 07-13).

import dns from "node:dns";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

import { isBlockedAddress, PreflightError } from "./boundary.ts";

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;
export type LookupFn = (hostname: string, options: dns.LookupAllOptions, cb: LookupCallback) => void;
export type RequestFn = (url: URL, options: https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.ClientRequest;

const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function createPinnedFetch({
  lookup = dns.lookup as unknown as LookupFn,
  isBlocked = isBlockedAddress,
  request = https.request as unknown as RequestFn,
}: { lookup?: LookupFn; isBlocked?: (address: string) => boolean; request?: RequestFn } = {}): typeof fetch {
  const refuse = () => new PreflightError("private-address", "resolved to a blocked address at connect time");

  // net calls this with (hostname, { all?, family?, hints? }, cb); the answer
  // shape must follow options.all.
  const safeLookup = (hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!Array.isArray(addrs) || addrs.length === 0 || addrs.some((a) => isBlocked(a.address))) return cb(refuse());
      if (options?.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };

  return ((input: string | URL, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      if (typeof input !== "string" && !(input instanceof URL)) {
        return reject(new TypeError("pinnedFetch takes a string or URL"));
      }
      const url = new URL(String(input));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) && isBlocked(host)) return reject(refuse());
      const body = init.body;
      if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
        return reject(new TypeError("pinnedFetch sends only string or Uint8Array bodies"));
      }
      let req: http.ClientRequest;
      try {
        req = request(
          url,
          {
            method: init.method ?? "GET",
            headers: Object.fromEntries(new Headers(init.headers)),
            lookup: safeLookup as unknown as https.RequestOptions["lookup"],
            agent: false, // no pooled socket can skip the hook
            signal: init.signal ?? undefined,
          },
          (res) => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined) continue;
              for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
            }
            const status = res.statusCode ?? 0;
            if (NULL_BODY_STATUS.has(status)) {
              res.resume();
              return resolve(new Response(null, { status, headers }));
            }
            resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, headers }));
          },
        );
      } catch (e) {
        return reject(e);
      }
      req.on("error", reject);
      req.end(body ?? undefined);
    })) as typeof fetch;
}

export const pinnedFetch = createPinnedFetch();
