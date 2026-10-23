// APP-02 / SC2 / D-80: a live run is accepted only for a URL on the own or
// opt-in list. Every refusal before the address check makes zero resolver
// calls. The resolver is a spy; no real DNS.

import assert from "node:assert/strict";
import { test } from "node:test";

import { preflightLiveUrl } from "../../src/app/server/live-preflight.ts";
import { deriveBoundary } from "../../src/pipeline/evidence/boundary.ts";

const OWN = deriveBoundary("https://own.example/");
const OPT_IN = deriveBoundary("https://github.com/optin-co/agent");
const LIST = [OWN, OPT_IN];

function spy(answer) {
  const fn = async (hostname) => {
    fn.calls.push(hostname);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  fn.calls = [];
  return fn;
}

test("off-list: a public URL not on the list is refused with zero resolver calls", async () => {
  const resolver = spy(["93.184.216.34"]);
  for (const url of ["https://not-consenting.example/", "https://github.com/someone-else/repo", "https://own.example.evil.example/"]) {
    assert.deepEqual(await preflightLiveUrl(url, LIST, { resolver }), { ok: false, reason: "off-list" }, url);
  }
  assert.deepEqual(await preflightLiveUrl("https://own.example/", [], { resolver }), { ok: false, reason: "off-list" });
  assert.equal(resolver.calls.length, 0);
  console.log("RESULT off-list refused resolverCalls=0");
});

test("bad-url: http://, port 8443 and user:pass@ are refused before any network call", async () => {
  const resolver = spy(["93.184.216.34"]);
  for (const url of ["http://own.example/", "https://own.example:8443/", "https://user:pass@own.example/", "not a url"]) {
    assert.deepEqual(await preflightLiveUrl(url, LIST, { resolver }), { ok: false, reason: "bad-url" }, url);
  }
  assert.equal(resolver.calls.length, 0);
  console.log("RESULT bad-url refused (http, :8443, credentials) resolverCalls=0");
});

test("private-address: an on-list host resolving to the metadata address is refused", async () => {
  const resolver = spy(["169.254.169.254"]);
  assert.deepEqual(await preflightLiveUrl("https://own.example/", LIST, { resolver }), { ok: false, reason: "private-address" });
  assert.deepEqual(resolver.calls, ["own.example"]);
  console.log("RESULT private-address refused (169.254.169.254)");
});

test("dns-fail: an on-list host that does not resolve", async () => {
  const resolver = spy(new Error("ENOTFOUND"));
  assert.deepEqual(await preflightLiveUrl("https://own.example/", LIST, { resolver }), { ok: false, reason: "dns-fail" });
});

test("ok: an in-boundary subdomain URL returns the matched boundary", async () => {
  const resolver = spy(["93.184.216.34"]);
  assert.deepEqual(await preflightLiveUrl("https://docs.own.example/start", LIST, { resolver }), { ok: true, boundary: OWN });
  assert.deepEqual(await preflightLiveUrl("https://github.com/optin-co/agent/tree/main", LIST, { resolver }), { ok: true, boundary: OPT_IN });
  assert.deepEqual(resolver.calls, ["docs.own.example", "github.com"]);
});
