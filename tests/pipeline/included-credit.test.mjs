import assert from "node:assert/strict";
import { test } from "node:test";
import { assertIncludedCredit } from "../../src/pipeline/validate/included-credit.ts";
import { ollamaClient } from "../../src/pipeline/validate/providers.ts";

const approval = { version: 1, approvalDate: "2026-10-24", source: "user-dashboard", provider: "ollama", model: "nemotron-3-ultra:cloud", thinking: true, funding: "included-only", autoReload: false, creditPurchaseAllowed: false, oauthGrantAllowed: false, refillAfterDeadline: true, runCap: 7, includedBalanceUsd: 9.10, runSpentAtBalanceUsd: .3006193 };
test("included credit funds the full authorized remainder and subtracts already consumed credit on resume", () => {
  const result = assertIncludedCredit(approval, 6.7145636, .3006193);
  assert.equal(result.available, 9.10);
  assert.ok(Math.abs(result.projectedRemaining - 6.4139443) < 1e-9);
  assert.ok(Math.abs(assertIncludedCredit(approval, 6.7145636, 1.3006193).available - 8.10) < 1e-9);
  assert.throws(() => assertIncludedCredit({ ...approval, includedBalanceUsd: 6 }, 6.7145636, .3006193), { name: "IncludedCreditExceededError" });
  assert.throws(() => assertIncludedCredit({ ...approval, includedBalanceUsd: 6.5 }, 6.7145636, .3006193), { name: "IncludedCreditExceededError" });
  for (const patch of [{ creditPurchaseAllowed: true }, { oauthGrantAllowed: true }, { autoReload: true }, { funding: "purchased" }, { runCap: 8 }]) assert.throws(() => assertIncludedCredit({ ...approval, ...patch }, 6.7145636, .3006193));
});

test("a lack-of-credit response stops immediately without a retry", async () => {
  let calls = 0;
  const client = ollamaClient({ budget: 7, maxRetries: 3, stage: "full-confirm", fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: "Insufficient included credits" }), { status: 429 }); } });
  await assert.rejects(client.request("/chat/completions", { method: "POST", body: { model: "nemotron-3-ultra:cloud", messages: [{ role: "user", content: "Synthetic fixture" }], max_tokens: 100 } }), { name: "QuotaStop" });
  assert.equal(calls, 1); assert.equal(client.counters.retries, 0);
});
