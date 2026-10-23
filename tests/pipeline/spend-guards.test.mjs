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
  estimateCostUsd,
} from "../../src/pipeline/coding/spend-guards.ts";
import { ollamaClient } from "../../src/pipeline/validate/providers.ts";

const FLASH = "deepseek-ai/DeepSeek-V4-Flash-0731";

test("Ollama standard prices include cloud aliases without credit or cache discounts", () => {
  for (const [model, input, output] of [
    ["glm-5.3-flash", .15, .50], ["nemotron-3-ultra", .10, 3],
    ["kimi-k3", 3, 15], ["glm-5.3", 1.4, 4.4],
    ["minimax-m3.1-flash", .15, .60], ["nemotron-3-super", .015, .60],
    ["deepseek-v4.1-flash", .30, 1.20],
  ]) {
    assert.equal(estimateCostUsd(model, 1e6, 0), input);
    assert.equal(estimateCostUsd(`${model}:cloud`, 0, 1e6), output);
  }
});

test("Ollama token and budget refusals never invoke fetch", async () => {
  let calls = 0;
  const client = ollamaClient({ budget: .001, fetchImpl: async () => { calls++; throw Error("unexpected network"); } });
  const body = { model: "kimi-k3:cloud", messages: [{ content: "x".repeat(80004) }], max_tokens: 1 };
  await assert.rejects(client.request("/chat/completions", { body }), TooLargeError);
  body.messages = [{ content: "hi" }];
  body.max_tokens = 1000;
  await assert.rejects(client.request("/chat/completions", { body }), BudgetExceededError);
  assert.equal(calls, 0);
});

test("in-flight reservations prevent concurrent budget overspend on either host", async () => {
  for (const provider of ["ollama", "tf"]) {
    const budget = new DollarBudget(.0151);
    let calls = 0;
    const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return new Response("{}"); };
    const client = provider === "ollama" ? ollamaClient({ budget, fetchImpl }) : createClient({ baseUrl: "https://example.test", apiKey: "test", budget, fetchImpl });
    const model = provider === "ollama" ? "kimi-k3" : "Qwen/Qwen3.5-397B-A17B";
    const max_tokens = provider === "ollama" ? 1000 : 4000;
    const results = await Promise.allSettled([1, 2].map(() => client.request("/chat/completions", { body: { model, messages: [{ content: "hi" }], max_tokens } })));
    assert.equal(calls, 1);
    assert.equal(results.filter(r => r.status === "rejected" && r.reason instanceof BudgetExceededError).length, 1);
    assert.ok(budget.spent > 0, "missing usage is charged conservatively");
    assert.ok(budget.spent <= budget.cap);
    assert.equal(budget.reserved, 0);
  }
});

test("Ollama rejects concurrency beyond 1–2", () => {
  for (const concurrency of [0, 3, Infinity, 1.5]) assert.throws(() => ollamaClient({ concurrency }), /concurrency/);
});

test("Ollama counts measured token spend", async () => {
  const client = ollamaClient({ fetchImpl: async () => new Response(JSON.stringify({ message: { content: "{}" }, prompt_eval_count: 100, eval_count: 20, done: true })) });
  await client.request("/chat/completions", { body: { model: "glm-5.3-flash:cloud", messages: [{ content: "hi" }], max_tokens: 100 } });
  assert.equal(client.dollarBudget.spent, estimateCostUsd("glm-5.3-flash", 100, 20));
  assert.deepEqual(JSON.parse(client.dollarBudget.budgetLine().slice(8)), { estimated: client.dollarBudget.estimated, spent: client.dollarBudget.spent, cap: 5 });
});

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
  test("rejects unbounded or invalid caps", () => {
    for (const value of ["Infinity", "NaN", "0", "-1"]) {
      assert.throws(() => requireTfBudget({ argv: ["--budget", value], env: {} }), /finite positive/);
      assert.throws(() => new DollarBudget(Number(value)), /finite/);
    }
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
