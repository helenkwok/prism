// Offline tests for the spike pre-flight and redaction libraries (FND-06, D-16).
// No network: fetch and DNS are injected.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PreflightError,
  deriveBoundary,
  followRedirects,
  isAllowed,
  isBlockedAddress,
  parseRobots,
  resolveSafe,
  withinBoundary,
} from "../scripts/spikes/lib/preflight.mjs";
import { redactText, scrubSecrets } from "../scripts/spikes/lib/redact.mjs";
import {
  CEILING_CREDITS,
  CreditBudget,
  extractCredits,
  isPageLike,
  mapCredits,
  median,
  percentile,
  selectorsFor,
} from "../scripts/spikes/lib/tavily-math.mjs";

const PUBLIC = async () => ["93.184.216.34"];

/** Build a fake fetch from a table: url -> { status, location?, body? }. Counts calls. */
function fakeFetch(table) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const row = table[url];
    if (!row) throw new Error(`unexpected fetch of ${url}`);
    const headers = new Headers();
    if (row.location) headers.set("location", row.location);
    return new Response(row.body ?? "", { status: row.status, headers });
  };
  impl.calls = calls;
  return impl;
}

describe("followRedirects", () => {
  it("flags a chain that leaves the boundary although the requested URL was inside", async () => {
    const boundary = deriveBoundary("https://app.example/");
    const fetchImpl = fakeFetch({
      "https://app.example/": { status: 302, location: "https://other.example/landing" },
      "https://other.example/landing": { status: 200, body: "ok" },
    });
    const r = await followRedirects("https://app.example/", { resolver: PUBLIC, fetchImpl, boundary });
    assert.equal(withinBoundary("https://app.example/", boundary), true);
    assert.equal(r.boundaryOk, false);
    assert.equal(r.finalUrl, "https://other.example/landing");
    assert.equal(r.hops.length, 2);
  });

  it("keeps boundaryOk true when the whole chain stays inside (www and https upgrade)", async () => {
    const boundary = deriveBoundary("https://example.com/");
    const fetchImpl = fakeFetch({
      "https://example.com/": { status: 301, location: "https://www.example.com/" },
      "https://www.example.com/": { status: 200, body: "hi" },
    });
    const r = await followRedirects("https://example.com/", { resolver: PUBLIC, fetchImpl, boundary });
    assert.equal(r.boundaryOk, true);
  });

  it("fails a chain longer than 5 hops, and accepts exactly 5 redirects", async () => {
    const table = {};
    for (let i = 0; i < 7; i += 1) {
      table[`https://h.example/${i}`] = { status: 302, location: `https://h.example/${i + 1}` };
    }
    table["https://h.example/5"] = { status: 200, body: "end" };
    const ok = await followRedirects("https://h.example/0", { resolver: PUBLIC, fetchImpl: fakeFetch(table) });
    assert.equal(ok.hops.length, 6); // requested + 5 redirects
    table["https://h.example/5"] = { status: 302, location: "https://h.example/6" };
    table["https://h.example/6"] = { status: 200, body: "end" };
    await assert.rejects(
      followRedirects("https://h.example/0", { resolver: PUBLIC, fetchImpl: fakeFetch(table) }),
      (e) => e instanceof PreflightError && e.code === "too-many-hops",
    );
  });

  it("rejects a hostname that resolves to a private address before connecting", async () => {
    const fetchImpl = fakeFetch({});
    await assert.rejects(
      followRedirects("https://rebind.example/", { resolver: async () => ["10.0.0.5"], fetchImpl }),
      (e) => e.code === "private-address",
    );
    assert.equal(fetchImpl.calls.length, 0, "no connection was attempted");
  });

  it("rejects a redirect that points at the metadata address, without fetching it", async () => {
    const fetchImpl = fakeFetch({
      "https://a.example/": { status: 302, location: "https://169.254.169.254/latest/meta-data" },
    });
    await assert.rejects(
      followRedirects("https://a.example/", { resolver: PUBLIC, fetchImpl }),
      (e) => e.code === "private-address",
    );
    assert.deepEqual(fetchImpl.calls, ["https://a.example/"]);
  });

  it("refuses http, credentials and odd ports", async () => {
    const fetchImpl = fakeFetch({});
    for (const [url, code] of [
      ["http://a.example/", "not-https"],
      ["https://user:pw@a.example/", "bad-url"],
      ["https://a.example:8443/", "bad-port"],
    ]) {
      await assert.rejects(followRedirects(url, { resolver: PUBLIC, fetchImpl }), (e) => e.code === code);
    }
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("refuses a redirect from https to http", async () => {
    const fetchImpl = fakeFetch({ "https://a.example/": { status: 302, location: "http://a.example/x" } });
    await assert.rejects(followRedirects("https://a.example/", { resolver: PUBLIC, fetchImpl }), (e) => e.code === "not-https");
  });

  it("returns a capped body when asked", async () => {
    const fetchImpl = fakeFetch({ "https://a.example/": { status: 200, body: "x".repeat(5000) } });
    const r = await followRedirects("https://a.example/", { resolver: PUBLIC, fetchImpl, readBody: 1000 });
    assert.equal(r.body.length, 1000);
  });
});

describe("resolveSafe and isBlockedAddress", () => {
  it("blocks loopback, private, link-local, unique-local, metadata and mapped forms", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00:ec2::254",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
    ]) {
      assert.equal(isBlockedAddress(a), true, a);
    }
  });

  it("allows public addresses", () => {
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isBlockedAddress(a), false, a);
    }
  });

  it("rejects when any one of several addresses is private", async () => {
    await assert.rejects(resolveSafe("mixed.example", async () => ["93.184.216.34", "192.168.0.9"]), (e) => e.code === "private-address");
  });

  it("rejects local names and IP literals without asking the resolver", async () => {
    const resolver = async () => {
      throw new Error("resolver must not be called");
    };
    await assert.rejects(resolveSafe("localhost", resolver), (e) => e.code === "private-address");
    await assert.rejects(resolveSafe("printer.local", resolver), (e) => e.code === "private-address");
    await assert.rejects(resolveSafe("[::1]", resolver), (e) => e.code === "private-address");
    await assert.rejects(resolveSafe("127.0.0.1", resolver), (e) => e.code === "private-address");
  });

  it("maps a resolver failure to dns-fail", async () => {
    await assert.rejects(resolveSafe("nx.example", async () => { throw new Error("ENOTFOUND"); }), (e) => e.code === "dns-fail");
  });
});

describe("withinBoundary", () => {
  it("treats the host, its subdomains and www as inside, siblings as outside", () => {
    const b = deriveBoundary("https://www.acme.ai/");
    assert.equal(withinBoundary("https://acme.ai/docs", b), true);
    assert.equal(withinBoundary("https://docs.acme.ai/x", b), true);
    assert.equal(withinBoundary("https://notacme.ai/", b), false);
    assert.equal(withinBoundary("https://acme.ai.evil.example/", b), false);
    assert.equal(withinBoundary("https://github.com/acme", b), false);
  });

  it("distinguishes sibling paths on a shared host", () => {
    const b = deriveBoundary("https://github.com/Owner/Repo");
    assert.deepEqual(b, { host: "github.com", pathPrefix: "/owner/repo" });
    assert.equal(withinBoundary("https://github.com/owner/repo", b), true);
    assert.equal(withinBoundary("https://github.com/Owner/Repo/blob/main/README.md", b), true);
    assert.equal(withinBoundary("https://github.com/owner/repo-two", b), false);
    assert.equal(withinBoundary("https://github.com/owner/other", b), false);
    assert.equal(withinBoundary("https://gist.github.com/owner/repo", b), false);
  });

  it("does not expand a shared-suffix host to its siblings", () => {
    const b = deriveBoundary("https://alice.github.io/tool/");
    assert.equal(b.exact, true);
    assert.equal(withinBoundary("https://alice.github.io/other", b), true);
    assert.equal(withinBoundary("https://bob.github.io/tool/", b), false);
    assert.equal(withinBoundary("https://github.io/", b), false);
  });

  it("uses three segments for a huggingface space", () => {
    const b = deriveBoundary("https://huggingface.co/spaces/acme/demo");
    assert.equal(b.pathPrefix, "/spaces/acme/demo");
    assert.equal(withinBoundary("https://huggingface.co/spaces/acme/demo/tree/main", b), true);
    assert.equal(withinBoundary("https://huggingface.co/spaces/acme/other", b), false);
  });
});

describe("robots", () => {
  const rules = parseRobots(`
    User-agent: *
    Disallow: /private
    Allow: /private/open
    Disallow: /*.json$
    Disallow: /tmp/

    User-agent: badbot
    Disallow: /
  `);

  it("longest match wins between Allow and Disallow", () => {
    assert.equal(isAllowed(rules, "/private/secret"), false);
    assert.equal(isAllowed(rules, "/private/open/page"), true);
    assert.equal(isAllowed(rules, "/public"), true);
  });

  it("supports * and $ and treats a trailing-slash rule as a prefix", () => {
    assert.equal(isAllowed(rules, "/data/x.json"), false);
    assert.equal(isAllowed(rules, "/data/x.json.txt"), true);
    assert.equal(isAllowed(rules, "/tmp/a"), false);
    assert.equal(isAllowed(rules, "/tmp"), true);
  });

  it("uses a group that names the crawler, otherwise the star group", () => {
    assert.equal(isAllowed(rules, "/anything", ["badbot"]), false);
    assert.equal(isAllowed(rules, "/anything", ["otherbot"]), true);
  });

  it("an empty Disallow allows everything, an absent file allows everything", () => {
    assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/x"), true);
    assert.equal(isAllowed(parseRobots(""), "/x"), true);
  });

  it("on a tie Allow beats Disallow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
    assert.equal(isAllowed(r, "/a/b"), true);
  });

  it("stacked user-agent lines share one group", () => {
    const r = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x");
    assert.equal(isAllowed(r, "/x", ["a"]), false);
    assert.equal(isAllowed(r, "/x", ["b"]), false);
    assert.equal(isAllowed(r, "/x", ["c"]), true);
  });
});

describe("redaction", () => {
  it("replaces emails and phone numbers and counts them", () => {
    const { text, counts } = redactText("Contact jane.doe+x@mail.example.com or +44 20 7946 0958, also (415) 555-0132.");
    assert.equal(counts.emails, 1);
    assert.equal(counts.phones, 2);
    assert.ok(!/@/.test(text));
    assert.ok(!/7946|555-0132/.test(text));
  });

  it("leaves dates, versions and short numbers alone", () => {
    const src = "Released 2026-09-20 as v1.14.0 with 1,000 users and 3.5 stars, build 12345.";
    const { text, counts } = redactText(src);
    assert.equal(text, src);
    assert.deepEqual(counts, { emails: 0, phones: 0 });
  });

  it("scrubSecrets removes an exact secret and token shapes", () => {
    const key = "tvly-dev-ABCDEFGHIJKLMNOP";
    const out = scrubSecrets(`failed with ${key} and Bearer abcdefghijkl and ${key}`, [key]);
    assert.ok(!out.includes("ABCDEFGH"));
    assert.ok(!/Bearer abcdefghijkl/.test(out));
  });
});

describe("tavily credit math and selectors", () => {
  it("applies the documented rates", () => {
    assert.equal(mapCredits(50), 5);
    assert.equal(mapCredits(51), 6);
    assert.equal(mapCredits(50, { instructions: true }), 10);
    assert.equal(extractCredits(20, "basic"), 4);
    assert.equal(extractCredits(20, "advanced"), 8);
    assert.equal(extractCredits(1, "basic"), 1);
    assert.equal(extractCredits(0, "basic"), 0);
  });

  it("nearest-rank p95 over 5 values is the maximum; median is the middle", () => {
    assert.equal(percentile([9, 3, 30, 5, 7], 95), 30);
    assert.equal(median([9, 3, 30, 5, 7]), 7);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("refuses a call that would cross the ceiling and counts the larger of two methods", () => {
    const b = new CreditBudget(CEILING_CREDITS);
    assert.equal(b.allows(40), true);
    b.record({ perCall: 30, formula: 36 });
    assert.equal(b.tally, 36);
    assert.equal(b.allows(4), true);
    assert.equal(b.allows(5), false);
  });

  it("selectors are anchored and match the boundary and nothing else", () => {
    const own = selectorsFor(deriveBoundary("https://www.acme.ai/"));
    const re = new RegExp(own.select_domains[0]);
    assert.ok(re.test("acme.ai") && re.test("docs.acme.ai") && re.test("www.acme.ai"));
    assert.ok(!re.test("notacme.ai") && !re.test("acme.ai.evil.example") && !re.test("acmeXai"));
    const repo = selectorsFor(deriveBoundary("https://github.com/Owner/Repo"));
    const dom = new RegExp(repo.select_domains[0]);
    const path = new RegExp(repo.select_paths[0]);
    assert.ok(dom.test("github.com") && !dom.test("gist.github.com"));
    assert.ok(path.test("/Owner/Repo") && path.test("/owner/repo/blob/main/x") && !path.test("/owner/repo-two") && !path.test("/owner/other"));
  });

  it("treats assets as not page-like", () => {
    assert.equal(isPageLike("https://a.example/docs/intro"), true);
    assert.equal(isPageLike("https://a.example/logo.png"), false);
    assert.equal(isPageLike("https://a.example/data.json"), false);
  });
});
