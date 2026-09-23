// Offline tests for the Nebius spike fetch wrapper (FND-05, T-01-07-01, T-01-07-05).
// No network: fetch is injected via a fake implementation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NebiusError,
  buildChatBody,
  createClient,
  createLimiter,
  pickRateHeaders,
} from "../scripts/spikes/lib/nebius.mjs";

/** Build a fake fetch from an ordered list of responses; repeats the last one. */
function fakeFetch(responses) {
  let i = 0;
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers = new Headers(r.headers ?? {});
    return new Response(r.body ?? "", { status: r.status, headers });
  };
  impl.calls = calls;
  return impl;
}

describe("createClient: retries and rate-limit headers", () => {
  it("retries on a marked 429 with backoff and then succeeds, capturing rate-limit headers", async () => {
    const fetchImpl = fakeFetch([
      { status: 429, headers: { "x-ratelimit-over-limit": "yes" } },
      { status: 429, headers: { "x-ratelimit-over-limit": "yes" } },
      {
        status: 200,
        headers: { "x-ratelimit-remaining-requests": "598", "x-ratelimit-remaining-tokens": "399000" },
        body: JSON.stringify({ ok: true }),
      },
    ]);
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k-secret-value", fetchImpl, maxRetries: 5 });
    const res = await client.request("/models");
    assert.equal(res.status, 200);
    assert.equal(res.attempts, 3);
    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(res.headers["x-ratelimit-remaining-requests"], "598");
    assert.equal(res.headers["x-ratelimit-remaining-tokens"], "399000");
    assert.deepEqual(res.json, { ok: true });
  });

  it("also retries on a plain 429 with no marker header", async () => {
    const fetchImpl = fakeFetch([{ status: 429 }, { status: 200, body: "{}" }]);
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl });
    const res = await client.request("/models");
    assert.equal(res.status, 200);
    assert.equal(fetchImpl.calls.length, 2);
  });

  it("gives up after maxRetries and returns the last over-limit response rather than looping forever", async () => {
    const fetchImpl = fakeFetch([{ status: 429, headers: { "x-ratelimit-over-limit": "yes" } }]);
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, maxRetries: 1 });
    const res = await client.request("/models");
    assert.equal(res.status, 429);
    assert.ok(fetchImpl.calls.length <= 2, `expected at most 2 calls, got ${fetchImpl.calls.length}`);
  });

  it("does not throw on a non-2xx status that is not a rate limit (caller decides)", async () => {
    const fetchImpl = fakeFetch([{ status: 403, body: JSON.stringify({ detail: "nope" }) }]);
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl });
    const res = await client.request("/batches", { method: "POST", body: { x: 1 } });
    assert.equal(res.status, 403);
    assert.equal(res.ok, false);
    assert.deepEqual(res.json, { detail: "nope" });
  });

  it("never includes the API key value in a thrown error message on network failure", async () => {
    const SECRET = "sk-super-secret-key-value";
    const fetchImpl = async () => {
      throw new Error(`connection reset while calling with token ${SECRET}`);
    };
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: SECRET, fetchImpl });
    await assert.rejects(client.request("/models"), (err) => {
      assert.ok(err instanceof NebiusError);
      assert.ok(!err.message.includes(SECRET), "thrown message must not contain the API key");
      return true;
    });
  });

  it("sends a FormData body as-is (multipart), with no JSON content-type override", async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: JSON.stringify({ id: "file-1" }) }]);
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl });
    const form = new FormData();
    form.append("purpose", "batch");
    const res = await client.request("/files", { method: "POST", body: form });
    assert.equal(res.status, 200);
    const sentOpts = fetchImpl.calls[0].opts;
    assert.equal(sentOpts.body, form);
    assert.equal(sentOpts.headers["content-type"], undefined);
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return new Response("{}", { status: 200 });
    };
    const client = createClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, concurrency: 3 });
    const results = await Promise.all(Array.from({ length: 9 }, () => client.request("/x")));
    assert.equal(results.length, 9);
    assert.ok(maxActive <= 3, `max concurrent calls was ${maxActive}`);
  });
});

describe("createLimiter", () => {
  it("runs at most `concurrency` functions at once and runs all of them, in order of completion", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return i;
        }),
      ),
    );
    assert.ok(maxActive <= 2, `max concurrent calls was ${maxActive}`);
    assert.deepEqual(results, [0, 1, 2, 3, 4]);
  });
});

describe("pickRateHeaders", () => {
  it("keeps only known rate-limit header names", () => {
    const headers = new Headers({ "x-ratelimit-remaining-requests": "10", "content-type": "application/json" });
    const picked = pickRateHeaders(headers);
    assert.deepEqual(picked, { "x-ratelimit-remaining-requests": "10" });
  });
});

describe("buildChatBody", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("builds a json_schema body with the schema in response_format and thinking off by default", () => {
    const schema = { name: "x", schema: { type: "object" } };
    const body = buildChatBody({ model: "nvidia/x", messages, mode: "json_schema", schema });
    assert.deepEqual(body.response_format, { type: "json_schema", json_schema: schema });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.model, "nvidia/x");
    assert.equal(body.temperature, 0);
  });

  it("builds a json_object body with no schema, and can turn thinking on", () => {
    const body = buildChatBody({ model: "nvidia/x", messages, mode: "json_object", thinking: true });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  });

  it("throws (no network call needed) when required fields are missing", () => {
    assert.throws(() => buildChatBody({ messages, mode: "json_schema", schema: {} }), /model is required/);
    assert.throws(() => buildChatBody({ model: "m", messages: [], mode: "json_schema", schema: {} }), /messages is required/);
    assert.throws(() => buildChatBody({ model: "m", messages, mode: "json_schema" }), /schema is required/);
    assert.throws(() => buildChatBody({ model: "m", messages, mode: "bogus" }), /mode must be one of/);
  });
});
