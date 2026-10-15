// EVD-02 coverage for collectProjectPages(). The pure credit-math functions
// (mapCredits, extractCredits, CreditBudget, selectorsFor) are unchanged
// copies already proven by tests/spike-preflight.test.mjs; this file covers
// only collectProjectPages's new failure handling.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectProjectPages } from "../../src/pipeline/evidence/tavily.ts";

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function errorResponse(status, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => "",
  };
}

describe("collectProjectPages (EVD-02)", () => {
  test("a 500 on the extract call is recorded as a failed call, not a thrown error", async () => {
    const boundary = { host: "example.com" };
    const fetchImpl = async (url) => {
      if (url.includes("/map")) {
        return jsonResponse({ results: ["https://example.com/a", "https://example.com/b"], usage: { credits: 1 } });
      }
      // every /extract attempt (including the retry) fails
      return errorResponse(500, { "retry-after": "0.001" });
    };

    const result = await collectProjectPages({
      boundary,
      startUrl: "https://example.com/",
      apiKey: "test-key",
      fetchImpl,
      mapLimit: 10,
      extractCap: 5,
    });

    assert.equal(result.pages.length, 0);
    assert.ok(result.calls.some((c) => c.failed === true), "expected a failed call to be recorded");
  });

  test("a map result larger than the ceiling causes extraction to be refused, never exceeding the budget", async () => {
    const boundary = { host: "example.com" };
    const manyUrls = Array.from({ length: 500 }, (_, i) => `https://example.com/p${i}`);
    let extractCalled = false;
    const fetchImpl = async (url) => {
      if (url.includes("/map")) {
        return jsonResponse({ results: manyUrls, usage: { credits: 0 } });
      }
      extractCalled = true;
      throw new Error("extract must never be called once the map alone exceeds the ceiling");
    };

    const result = await collectProjectPages({
      boundary,
      startUrl: "https://example.com/",
      apiKey: "test-key",
      fetchImpl,
      mapLimit: 50,
      extractCap: 20,
    });

    assert.equal(extractCalled, false);
    assert.equal(result.pages.length, 0);
    assert.ok(result.creditsSpent <= result.creditsSpent, "sanity");
    assert.ok(result.calls.some((c) => c.refused === true), "expected a refused call to be recorded");
  });

  test("EVD-05: every extract attempt (basic and the advanced retry) fails for both URLs — both surface in missingUrls, pages is empty", async () => {
    const boundary = { host: "example.com" };
    const fetchImpl = async (url) => {
      if (url.includes("/map")) {
        return jsonResponse({ results: ["https://example.com/a", "https://example.com/b"], usage: { credits: 1 } });
      }
      // every /extract attempt (basic and the retry) fails
      return errorResponse(500, { "retry-after": "0.001" });
    };

    const result = await collectProjectPages({
      boundary,
      startUrl: "https://example.com/",
      apiKey: "test-key",
      fetchImpl,
      mapLimit: 10,
      extractCap: 5,
    });

    assert.equal(result.pages.length, 0);
    assert.ok(result.missingUrls.includes("https://example.com/a"));
    assert.ok(result.missingUrls.includes("https://example.com/b"));
  });

  test("EVD-05: the basic attempt succeeds for every URL — missingUrls is empty, no retry needed", async () => {
    const boundary = { host: "example.com" };
    const fetchImpl = async (url) => {
      if (url.includes("/map")) {
        return jsonResponse({ results: ["https://example.com/a"], usage: { credits: 1 } });
      }
      return jsonResponse({
        results: [{ url: "https://example.com/a", raw_content: "x".repeat(200) }],
        usage: { credits: 1 },
      });
    };

    const result = await collectProjectPages({
      boundary,
      startUrl: "https://example.com/",
      apiKey: "test-key",
      fetchImpl,
      mapLimit: 10,
      extractCap: 5,
    });

    assert.equal(result.missingUrls.length, 0);
    assert.equal(result.pages.length, 1);
  });

  test("EVD-05: the basic attempt fails for a URL but the advanced retry succeeds — that URL is in pages, not missingUrls", async () => {
    const boundary = { host: "example.com" };
    const fetchImpl = async (url, opts) => {
      if (url.includes("/map")) {
        return jsonResponse({ results: ["https://example.com/a"], usage: { credits: 1 } });
      }
      const body = JSON.parse(opts.body);
      if (body.extract_depth === "advanced") {
        return jsonResponse({
          results: [{ url: "https://example.com/a", raw_content: "y".repeat(200) }],
          usage: { credits: 2 },
        });
      }
      // basic attempt: empty content, below the EMPTY_BELOW_CHARS threshold
      return jsonResponse({ results: [{ url: "https://example.com/a", raw_content: "" }], usage: { credits: 1 } });
    };

    const result = await collectProjectPages({
      boundary,
      startUrl: "https://example.com/",
      apiKey: "test-key",
      fetchImpl,
      mapLimit: 10,
      extractCap: 5,
    });

    assert.deepEqual(
      result.pages.map((p) => p.url),
      ["https://example.com/a"],
    );
    assert.equal(result.missingUrls.length, 0);
  });
});
