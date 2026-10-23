import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCacheUsage } from "../../src/pipeline/validate/approved-run.ts";
const row = { provider: "ollama", stage: "gold", model: "glm-5.3-flash", inputTokens: 1000, outputTokens: 100, prefixDigest: "stable", chargedUsd: .0002, measured: true, status: 200, attempt: 1, latencyMs: 1 };
test("cache measurement distinguishes absent metadata from a measured zero or hit", () => {
  let [summary] = summarizeCacheUsage([{ ...row, cachedInputTokens: null }, { ...row, cachedInputTokens: null }]);
  assert.equal(summary.cachedInputTokens, null);
  assert.equal(summary.cacheMetadataRequests, 0);
  [summary] = summarizeCacheUsage([{ ...row, cachedInputTokens: 0 }, { ...row, cachedInputTokens: 800 }]);
  assert.equal(summary.cachedInputTokens, 800);
  assert.equal(summary.laterCacheHitRequests, 1);
  assert.equal(summary.repeatedPrefixRequests, 1);
  assert.equal(summarizeCacheUsage([{ ...row, cachedInputTokens: 1 }, { ...row, model: "nemotron-3-super", cachedInputTokens: 1 }]).length, 2);
});
test("verified primary-host cache pricing is distinguished from retained ledger charges", () => {
  const [summary] = summarizeCacheUsage([{ ...row, provider: "token-factory", model: "deepseek-ai/DeepSeek-V4-Flash-0731", cachedInputTokens: 800, chargedUsd: .000168 }]);
  assert.equal(summary.cachedInputPricePerMillion, .01);
  assert.equal(summary.chargedUsd, .000168);
  assert.ok(Math.abs(summary.publishedPriceUsd - .000064) < 1e-12);
});
