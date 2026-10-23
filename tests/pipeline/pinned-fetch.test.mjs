// D-80 / APP-02: the pinned fetch checks every address at socket connect time.
// A local node:http server on 127.0.0.1 stands in for every site; a test
// transport sends each request there while passing pinnedFetch's lookup hook
// through, so the socket really connects to whatever address the hook hands
// back. No real DNS query and no outbound request.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";

import { deriveBoundary, followRedirects, PreflightError } from "../../src/pipeline/evidence/boundary.ts";
import { collectOwnSitePages } from "../../src/pipeline/evidence/own-site.ts";
import { createPinnedFetch } from "../../src/pipeline/evidence/pinned-fetch.ts";

const PUBLIC_AT_PREFLIGHT = async () => ["93.184.216.34"];
const ONLY_LOOPBACK_ALLOWED = (a) => a !== "127.0.0.1";

let server;
let port;
const seen = []; // "host path" of every request the server received

const PAGES = {
  "/robots.txt": ["text/plain", "User-agent: *\nAllow: /\n"],
  "/sitemap.xml": [
    "application/xml",
    "<urlset><url><loc>https://own.example/a</loc></url><url><loc>https://own.example/b</loc></url></urlset>",
  ],
  "/": ["text/html", "<html><body><h1>Own home</h1><p>First block.</p><div>Second block.</div></body></html>"],
  "/a": ["text/html", "<html><body><h1>Page A</h1><p>About us.</p></body></html>"],
  "/b": ["text/html", "<html><body><h1>Page B</h1><p>Security.</p></body></html>"],
};

before(async () => {
  server = http.createServer((req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    seen.push(`${host} ${req.url}`);
    if (req.url === "/r-in") {
      res.writeHead(302, { location: "https://docs.own.example/a" });
      return res.end();
    }
    if (req.url === "/r-out") {
      res.writeHead(302, { location: "https://third-party.example/" });
      return res.end();
    }
    const page = PAGES[req.url];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": page[0] });
    res.end(page[1]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

after(() => new Promise((r) => server.close(r)));

/** Sends every request to the local server; keeps the URL's host name and pinnedFetch's lookup hook. */
function transport(url, options, cb) {
  return http.request(
    {
      host: url.hostname,
      port,
      path: url.pathname + url.search,
      method: options.method,
      headers: { ...options.headers, host: url.hostname },
      lookup: options.lookup,
      agent: options.agent,
      signal: options.signal,
    },
    cb,
  );
}

/** A dns.lookup stand-in answering a fixed address list; records the names asked. */
function stubLookup(addresses) {
  const fn = (hostname, _opts, cb) => {
    fn.calls.push(hostname);
    cb(null, addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })));
  };
  fn.calls = [];
  return fn;
}

function resolverSpy(addrs) {
  const fn = async (hostname) => {
    fn.calls.push(hostname);
    return addrs;
  };
  fn.calls = [];
  return fn;
}

const requestsSince = (n) => seen.length - n;

describe("pinnedFetch (D-80 connect-time address check)", () => {
  test("allowlisted collection succeeds through the pinned socket", async () => {
    const lookup = stubLookup(["127.0.0.1"]);
    const fetchImpl = createPinnedFetch({ lookup, isBlocked: ONLY_LOOPBACK_ALLOWED, request: transport });
    const start = seen.length;
    const r = await collectOwnSitePages({
      boundary: deriveBoundary("https://own.example/"),
      startUrl: "https://own.example/",
      fetchImpl,
      resolver: PUBLIC_AT_PREFLIGHT,
      pageCap: 3,
    });
    assert.ok(r.pages.length >= 2, `collected ${r.pages.length} pages`);
    assert.ok(r.pages.some((p) => p.rawText.includes("Own home")));
    assert.ok(lookup.calls.length > 0, "every connect went through the lookup hook");
    assert.ok(requestsSince(start) > 0);
    console.log(`RESULT allowlisted collection pages=${r.pages.length} serverRequests=${requestsSince(start)} connectLookups=${lookup.calls.length}`);
  });

  test("rebinding refused: public at pre-flight, 127.0.0.1 at connect, zero server requests", async () => {
    const lookup = stubLookup(["127.0.0.1"]);
    const fetchImpl = createPinnedFetch({ lookup, request: transport }); // real isBlockedAddress
    const start = seen.length;
    const r = await collectOwnSitePages({
      boundary: deriveBoundary("https://own.example/"),
      startUrl: "https://own.example/",
      fetchImpl,
      resolver: PUBLIC_AT_PREFLIGHT,
      pageCap: 3,
    });
    assert.equal(r.pages.length, 0);
    assert.ok(r.calls.some((c) => c.failed && c.reason === "private-address"), JSON.stringify(r.calls));
    assert.ok(lookup.calls.length > 0, "the refusal happened at connect, after a public pre-flight answer");
    assert.equal(requestsSince(start), 0);
    console.log(`RESULT rebinding refused pages=0 serverRequests=${requestsSince(start)} reason=private-address`);
  });

  test("any-address rule: a lookup answering [public, 10.0.0.1] is refused", async () => {
    const lookup = stubLookup(["93.184.216.34", "10.0.0.1"]);
    const fetchImpl = createPinnedFetch({ lookup, request: transport });
    const start = seen.length;
    await assert.rejects(fetchImpl("https://own.example/"), (e) => e instanceof PreflightError && e.code === "private-address");
    assert.equal(requestsSince(start), 0);
  });

  test("an empty lookup answer is refused", async () => {
    const fetchImpl = createPinnedFetch({ lookup: stubLookup([]), request: transport });
    await assert.rejects(fetchImpl("https://own.example/"), (e) => e.code === "private-address");
  });

  test("a blocked IP-literal host is refused without a lookup (Node skips the hook for literals)", async () => {
    const lookup = stubLookup(["93.184.216.34"]);
    const fetchImpl = createPinnedFetch({ lookup, request: transport });
    const start = seen.length;
    await assert.rejects(fetchImpl("https://127.0.0.1/"), (e) => e.code === "private-address");
    await assert.rejects(fetchImpl("https://[::1]/"), (e) => e.code === "private-address");
    assert.equal(lookup.calls.length, 0);
    assert.equal(requestsSince(start), 0);
  });

  test("redirect hop inside the boundary: resolveSafe and the connect check both run again", async () => {
    const lookup = stubLookup(["127.0.0.1"]);
    const fetchImpl = createPinnedFetch({ lookup, isBlocked: ONLY_LOOPBACK_ALLOWED, request: transport });
    const resolver = resolverSpy(["93.184.216.34"]);
    const r = await followRedirects("https://own.example/r-in", {
      fetchImpl,
      resolver,
      boundary: deriveBoundary("https://own.example/"),
      readBody: 10_000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.boundaryOk, true);
    assert.equal(r.finalUrl, "https://docs.own.example/a");
    assert.deepEqual(resolver.calls, ["own.example", "docs.own.example"]);
    assert.deepEqual(lookup.calls, ["own.example", "docs.own.example"]);
  });

  test("redirect hop leaving the boundary is not followed (no DNS, no connect, no request)", async () => {
    const lookup = stubLookup(["127.0.0.1"]);
    const fetchImpl = createPinnedFetch({ lookup, isBlocked: ONLY_LOOPBACK_ALLOWED, request: transport });
    const resolver = resolverSpy(["93.184.216.34"]);
    const start = seen.length;
    const r = await followRedirects("https://own.example/r-out", {
      fetchImpl,
      resolver,
      boundary: deriveBoundary("https://own.example/"),
      readBody: 10_000,
    });
    assert.equal(r.boundaryOk, false);
    assert.equal(r.status, 302);
    assert.equal(r.body, "");
    assert.deepEqual(resolver.calls, ["own.example"]);
    assert.deepEqual(lookup.calls, ["own.example"]);
    assert.deepEqual(seen.slice(start), ["own.example /r-out"]);
  });

  test("the response is a web Response with status, headers and body", async () => {
    const fetchImpl = createPinnedFetch({ lookup: stubLookup(["127.0.0.1"]), isBlocked: ONLY_LOOPBACK_ALLOWED, request: transport });
    const res = await fetchImpl("https://own.example/robots.txt", { headers: { "user-agent": "t" } });
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    assert.match(await res.text(), /User-agent: \*/);
  });
});
