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

test("shared parent cap reserves atomically and persists recovery state", () => {
  const changes = [];
  const total = new DollarBudget(1, { onChange: s => changes.push(s) });
  const first = new DollarBudget(.8, { parent: total });
  const second = new DollarBudget(.8, { parent: total });
  first.reserve(.7);
  assert.equal(total.reserved, .7);
  assert.throws(() => second.reserve(.4), BudgetExceededError);
  assert.equal(second.reserved, 0);
  assert.equal(total.reserved, .7);
  first.settle(.7, .2);
  assert.equal(first.spent, .2);
  assert.equal(total.spent, .2);
  assert.equal(total.reserved, 0);
  assert.deepEqual(changes.at(-1), { estimated: 0, spent: .2, cap: 1, reserved: 0 });
  const recovered = new DollarBudget(1, { initialSpent: .9 });
  assert.throws(() => recovered.reserve(.2), BudgetExceededError);
});

test("host payloads bound default output and retain nullable usage metadata", async () => {
  for (const provider of ["ollama", "tf"]) {
    let sent;
    const observations = [];
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify(provider === "ollama"
        ? { prompt_eval_count: 30, eval_count: 10, message: { content: "{}" } }
        : { usage: { prompt_tokens: 30, completion_tokens: 10 }, choices: [] }));
    };
    const options = { budget: 1, fetchImpl, onUsage: x => observations.push(x), stage: "unit" };
    const client = provider === "ollama" ? ollamaClient(options)
      : createClient({ ...options, baseUrl: "https://example.test", apiKey: "test" });
    const model = provider === "ollama" ? "glm-5.3-flash" : FLASH;
    const response = await client.request("/chat/completions", { body: { model,
      messages: [{ role: "system", content: "codebook" }, { role: "user", content: "fixture" }] } });
    assert.equal(provider === "ollama" ? sent.options.num_predict : sent.max_tokens, 4096);
    assert.equal(observations[0].cachedInputTokens, null);
    assert.equal(observations[0].inputTokens, 30);
    assert.match(observations[0].prefixDigest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(observations).includes("fixture"), false);
    assert.equal(response.json.usage.prompt_tokens, 30);
    if (provider === "ollama") assert.equal(response.json.prompt_eval_cached_count, null);
  }
});

test("cache discounts require valid measured hits", async () => {
  for (const cached of [80, undefined, 101]) {
    const observations = [];
    const client = ollamaClient({ budget: 1, onUsage: x => observations.push(x), fetchImpl: async () =>
      new Response(JSON.stringify({ prompt_eval_count: 100, eval_count: 20,
        prompt_eval_cached_count: cached, thinking_count: 10, message: { content: "{}" } })) });
    await client.request("/chat/completions", { body: { model: "glm-5.3-flash", messages: [{ content: "hi" }], max_tokens: 100 } });
    const expected = cached === 80 ? (20 * .15 + 80 * .03 + 20 * .5) / 1e6 : estimateCostUsd("glm-5.3-flash", 100, 20);
    assert.ok(Math.abs(client.dollarBudget.spent - expected) < 1e-12);
    assert.equal(observations[0].cachedInputTokens, cached === 80 ? 80 : null);
  }
});

test("measured input exceeding heuristic is settled on both host budgets", async () => {
  for (const provider of ["ollama", "tf"]) {
    const total = new DollarBudget(1);
    const budget = new DollarBudget(.5, { parent: total });
    const fetchImpl = async () => new Response(JSON.stringify(provider === "ollama"
      ? { prompt_eval_count: 500, eval_count: 10 }
      : { usage: { prompt_tokens: 500, completion_tokens: 10 } }));
    const client = provider === "ollama" ? ollamaClient({ budget, fetchImpl })
      : createClient({ budget, fetchImpl, baseUrl: "https://example.test", apiKey: "test" });
    const model = provider === "ollama" ? "glm-5.3-flash" : FLASH;
    await client.request("/chat/completions", { body: { model, messages: [{ content: "hi" }], max_tokens: 10 } });
    assert.equal(budget.spent, estimateCostUsd(model, 500, 10));
    assert.equal(total.spent, budget.spent);
    assert.equal(total.reserved, 0);
  }
});

test("reservation persistence failure prevents HTTP", async () => {
  let calls = 0;
  const budget = new DollarBudget(1, { onChange: () => { throw Error("ledger unavailable"); } });
  const client = ollamaClient({ budget, fetchImpl: async () => { calls++; throw Error("unexpected"); } });
  await assert.rejects(client.request("/chat/completions", { body: { model: "glm-5.3-flash", messages: [{ content: "hi" }] } }), /ledger unavailable/);
  assert.equal(calls, 0);
  assert.ok(budget.reserved > 0);
});

test("UTF8 reservation and failed body reads remain charged", async () => {
  for (const provider of ["ollama", "tf"]) {
    const budget = new DollarBudget(1);
    let reservedAtFetch;
    const fetchImpl = async () => {
      reservedAtFetch = budget.reserved;
      return { ok: true, status: 200, headers: new Headers(), text: async () => { throw Error("read failed"); } };
    };
    const client = provider === "ollama" ? ollamaClient({ budget, fetchImpl })
      : createClient({ budget, fetchImpl, baseUrl: "https://example.test", apiKey: "test" });
    const model = provider === "ollama" ? "glm-5.3-flash" : FLASH;
    await assert.rejects(client.request("/chat/completions", { body: { model,
      messages: [{ content: "界".repeat(100) }], max_tokens: 10 } }), /read failed/);
    assert.ok(reservedAtFetch > estimateCostUsd(model, 300, 10));
    assert.equal(budget.reserved, 0);
    assert.equal(budget.spent, reservedAtFetch);
  }
});

test("unbounded output requests never fetch", async () => {
  for (const provider of ["ollama", "tf"]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw Error("unexpected"); };
    const client = provider === "ollama" ? ollamaClient({ budget: 1, fetchImpl })
      : createClient({ budget: 1, fetchImpl, baseUrl: "https://example.test", apiKey: "test" });
    for (const max_tokens of [-1, 0, Infinity, 2.5])
      await assert.rejects(client.request("/chat/completions", { body: { model: provider === "ollama" ? "glm-5.3-flash" : FLASH,
        messages: [{ content: "hi" }], max_tokens } }), /positive integer/);
    assert.equal(calls, 0);
  }
});

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
    const budget = new DollarBudget(.02);
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
