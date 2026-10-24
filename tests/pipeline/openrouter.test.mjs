// OpenRouter provider swap: thinking switch translation, bounded 429 wait, prices from the public list.
import assert from "node:assert/strict";
import { test } from "node:test";

const { openRouterFetch, registerOpenRouterPrices, OPENROUTER_MODEL_MAP } = await import("../../src/pipeline/validate/providers.ts");
const { LIST_PRICES } = await import("../../src/pipeline/coding/spend-guards.ts");

test("thinking becomes reasoning, require_parameters is set, and a 429 is retried a bounded number of times", async () => {
  const sent = [];
  let n = 0;
  const f = openRouterFetch({
    maxAttempts: 3,
    maxWaitMs: 1,
    fetchImpl: async (_u, init) => {
      sent.push(JSON.parse(init.body));
      n += 1;
      return new Response("{}", { status: n < 3 ? 429 : 200, headers: { "retry-after": "0" } });
    },
  });
  const res = await f("https://x/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [], chat_template_kwargs: { enable_thinking: true } }) });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0].reasoning, { enabled: true });
  assert.equal(sent[0].chat_template_kwargs, undefined);
  assert.deepEqual(sent[0].provider, { require_parameters: true });
  const always = openRouterFetch({ maxAttempts: 2, maxWaitMs: 1, fetchImpl: async () => new Response("{}", { status: 429 }) });
  assert.equal((await always("u", { body: "{}" })).status, 429);
});

test("beforeRequest can refuse without sending", async () => {
  let called = false;
  const f = openRouterFetch({ fetchImpl: async () => ((called = true), new Response("{}")), beforeRequest: () => new Response("{}", { status: 402 }) });
  assert.equal((await f("u", { body: JSON.stringify({ model: "m" }) })).status, 402);
  assert.equal(called, false);
});

test("prices come from the public list for every mapped model, and a missing one refuses", () => {
  const ids = Object.values(OPENROUTER_MODEL_MAP);
  registerOpenRouterPrices(ids.map((id) => ({ id, pricing: { prompt: "0.0000001", completion: "0.0000002" } })));
  for (const id of ids) assert.deepEqual(LIST_PRICES[id], { prompt: 1e-7, completion: 2e-7 });
  assert.throws(() => registerOpenRouterPrices([]), /no list price/);
});
