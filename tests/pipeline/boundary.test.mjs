// EVD-01 coverage for the promoted boundary.ts: the tldts-backed own-domain
// case, the unchanged shared-path/shared-suffix branches, fail-closed parsing,
// and deterministic hostClass().

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveBoundary, hostClass, isBlockedAddress, PreflightError, resolveSafe, withinBoundary } from "../../src/pipeline/evidence/boundary.ts";

describe("deriveBoundary / withinBoundary (EVD-01)", () => {
  test("a non-www subdomain entry resolves its boundary to the tldts registrable domain", () => {
    const boundary = deriveBoundary("https://blog.example.com/");
    assert.equal(boundary.host, "example.com");
  });

  test("both the bare domain and www are within-boundary; a sibling domain is not", () => {
    const boundary = deriveBoundary("https://blog.example.com/");
    assert.equal(withinBoundary("https://example.com/x", boundary), true);
    assert.equal(withinBoundary("https://www.example.com/x", boundary), true);
    assert.equal(withinBoundary("https://other-example.com/", boundary), false);
  });

  test("github.com boundary: adjacency without a separating slash is rejected, a sub-path is accepted", () => {
    const boundary = deriveBoundary("https://github.com/acme/repo");
    assert.deepEqual(boundary, { host: "github.com", pathPrefix: "/acme/repo" });
    assert.equal(withinBoundary("https://github.com/acme-other/x", boundary), false);
    assert.equal(withinBoundary("https://github.com/acme/repo/sub", boundary), true);
    assert.equal(withinBoundary("https://github.com/acme/repo", boundary), true);
  });

  test("a malformed URL is treated as outside the boundary (fail-closed)", () => {
    const boundary = deriveBoundary("https://example.com/");
    assert.equal(withinBoundary("not a url", boundary), false);
    assert.equal(withinBoundary("", boundary), false);
  });

  test("hostClass is deterministic: two calls on the same hostname always agree", () => {
    for (const h of ["example.com", "github.com", "foo.github.io", "www.example.com"]) {
      assert.equal(hostClass(h), hostClass(h));
    }
    assert.equal(hostClass("github.com"), "shared-path-host");
    assert.equal(hostClass("foo.github.io"), "shared-suffix-host");
    assert.equal(hostClass("example.com"), "own-domain");
  });

  test("a bare-IP entry falls back to the host heuristic when tldts cannot parse it", () => {
    const boundary = deriveBoundary("https://192.168.1.1/x");
    assert.equal(boundary.host, "192.168.1.1");
  });
});

// T-07-08: IPv6 encodings that still reached loopback or metadata (07-RESEARCH
// Pattern 4). Literal hosts come from the URL parser, as in production.
describe("resolveSafe: IPv6 encodings of private IPv4 (D-80)", () => {
  const NEVER = async () => {
    throw new Error("a literal host must not reach the resolver");
  };
  const hostOf = (url) => new URL(url).hostname;
  const refused = (url) =>
    assert.rejects(resolveSafe(hostOf(url), NEVER), (e) => e instanceof PreflightError && e.code === "private-address", url);

  test("IPv4-compatible ::a.b.c.d is judged by the embedded IPv4", async () => {
    await refused("https://[::127.0.0.1]/");
    await refused("https://[::169.254.169.254]/");
    assert.equal(isBlockedAddress("::7f00:1"), true);
    assert.equal(isBlockedAddress("::a9fe:a9fe"), true);
    assert.equal(isBlockedAddress("::5db8:d822"), false); // embedded public IPv4
  });

  test("6to4-private: 2002::/16 wrapping 127.0.0.1 or 169.254.169.254 is refused", async () => {
    await refused("https://[2002:7f00:1::]/");
    assert.equal(isBlockedAddress("2002:a9fe:a9fe::1"), true);
  });

  test("6to4-public-allowed: 2002::/16 wrapping a public IPv4 is allowed", async () => {
    assert.equal(isBlockedAddress("2002:5db8:d822::"), false);
    assert.deepEqual(await resolveSafe(hostOf("https://[2002:5db8:d822::]/"), NEVER), ["2002:5db8:d822::"]);
  });

  test("Teredo: the whole 2001:0::/32 prefix is refused", async () => {
    await refused("https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/");
    assert.equal(isBlockedAddress("2001::1"), true);
  });

  test("100::/64 (discard-only) is refused", async () => {
    await refused("https://[100::1]/");
  });

  test("SIIT ::ffff:0:a.b.c.d (::ffff:0:0/96) is judged by the embedded IPv4", async () => {
    await refused("https://[::ffff:0:127.0.0.1]/");
    await refused("https://[::ffff:0:169.254.169.254]/");
    assert.equal(isBlockedAddress("::ffff:0:a00:1"), true); // 10.0.0.1
    assert.equal(isBlockedAddress("::ffff:0:93.184.216.34"), false);
  });

  test("local-use NAT64 64:ff9b:1::/48 is refused whole (its IPv4 position depends on the operator's prefix length)", async () => {
    await refused("https://[64:ff9b:1::7f00:1]/");
    await refused("https://[64:ff9b:1::a9fe:a9fe]/");
    assert.equal(isBlockedAddress("64:ff9b:1:abcd::5db8:d822"), true);
    assert.equal(isBlockedAddress("64:ff9b:2::5db8:d822"), false); // outside the /48
  });

  test(":: and ::1 stay blocked; mapped, NAT64 and public addresses keep their verdicts", () => {
    for (const a of ["::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "fd00:ec2::254", "fe80::1", "ff02::1", "2001:db8::1"]) {
      assert.equal(isBlockedAddress(a), true, a);
    }
    for (const a of ["2606:4700::1111", "::ffff:93.184.216.34", "64:ff9b::5db8:d822", "2001:4860:4860::8888", "93.184.216.34"]) {
      assert.equal(isBlockedAddress(a), false, a);
    }
  });
});
