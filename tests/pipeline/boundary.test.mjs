// EVD-01 coverage for the promoted boundary.ts: the tldts-backed own-domain
// case, the unchanged shared-path/shared-suffix branches, fail-closed parsing,
// and deterministic hostClass().

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveBoundary, hostClass, withinBoundary } from "../../src/pipeline/evidence/boundary.ts";

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
