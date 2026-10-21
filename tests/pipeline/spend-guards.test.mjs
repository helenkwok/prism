// D-67: spending guards — no live Token Factory HTTP.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createClient } from "../../src/pipeline/coding/nebius-client.ts";
import {
  DollarBudget,
  DEFAULT_TOKEN_CAP,
  estimateTokens,
  formatBudgetLine,
  requireTfBudget,
  TooLargeError,
  BudgetExceededError,
  assertRequestAllowed,
} from "../../src/pipeline/coding/spend-guards.ts";

const FLASH = "deepseek-ai/DeepSeek-V4-Flash-0731";

describe("estimateTokens", () => {
  test("≈ chars/4", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("a".repeat(80_000)), 20_000);
    assert.equal(estimateTokens("a".repeat(80_004)), 20_001);
  });
});

describe("requireTfBudget", () => {
  test("throws without flag or env", () => {
    assert.throws(() => requireTfBudget({ argv: ["node", "x"], env: {} }), /explicit budget/);
  });
  test("reads --budget", () => {
    assert.equal(requireTfBudget({ argv: ["node", "x", "--budget", "5"], env: {} }), 5);
  });
  test("reads PRISM_TF_BUDGET", () => {
    assert.equal(requireTfBudget({ argv: ["node", "x"], env: { PRISM_TF_BUDGET: "2.5" } }), 2.5);
  });
});

describe("DollarBudget + BUDGET line", () => {
  test("shape BUDGET: {estimated,spent,cap}", () => {
    const b = new DollarBudget(5);
    b.addEstimated(1.2);
    b.recordSpent(0.4);
    const line = b.budgetLine();
    assert.match(line, /^BUDGET: /);
    const j = JSON.parse(line.slice("BUDGET: ".length));
    assert.deepEqual(j, { estimated: 1.2, spent: 0.4, cap: 5 });
    assert.equal(formatBudgetLine(b.snapshot()), line);
  });
  test("stops before overspend", () => {
    const b = new DollarBudget(1);
    assert.equal(b.allows(0.5), true);
    b.recordSpent(0.8);
    assert.equal(b.allows(0.3), false);
    assert.throws(
      () => assertRequestAllowed({ messages: [{ content: "hi" }], model: FLASH, budget: b, completionTokens: 1e9 }),
      BudgetExceededError,
    );
  });
});

describe("too-large refuse never calls fetch", () => {
  test("createClient without budget throws", () => {
    assert.throws(
      () => createClient({ baseUrl: "https://example.test/v1", apiKey: "k" }),
      /explicit budget/,
    );
  });

  test("oversized chat body returns too-large and never fetch", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      throw new Error("must not fetch");
    };
    const client = createClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl,
      budget: 5,
      tokenCap: DEFAULT_TOKEN_CAP,
    });
    const huge = "x".repeat(DEFAULT_TOKEN_CAP * 4 + 4); // estimateTokens > 20k
    const res = await client.request("/chat/completions", {
      method: "POST",
      body: {
        model: FLASH,
        messages: [{ role: "user", content: huge }],
        max_tokens: 16,
      },
    });
    assert.equal(res.outcome, "too-large");
    assert.equal(res.ok, false);
    assert.equal(fetches, 0);
  });

  test("assertRequestAllowed throws TooLargeError above cap", () => {
    assert.throws(
      () =>
        assertRequestAllowed({
          messages: [{ content: "y".repeat(DEFAULT_TOKEN_CAP * 4 + 4) }],
          model: FLASH,
          cap: DEFAULT_TOKEN_CAP,
        }),
      TooLargeError,
    );
  });

  test("under-cap request does call fetch", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetchImpl,
      budget: 5,
    });
    const res = await client.request("/chat/completions", {
      method: "POST",
      body: { model: FLASH, messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
    });
    assert.equal(fetches, 1);
    assert.equal(res.ok, true);
    assert.ok(client.dollarBudget.spent > 0);
  });
});
