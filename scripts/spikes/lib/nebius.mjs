// Nebius Token Factory fetch wrapper (FND-05, D-21, T-01-07-01, T-01-07-05).
//
// Plain fetch, no SDK, so response headers (x-ratelimit-*) and vLLM extras
// (chat_template_kwargs) stay under harness control (research Standard Stack).
// The API key is read by the caller from process.env and passed in; this
// module never logs it and scrubs it from any thrown error text.

import { scrubSecrets } from "./redact.mjs";
import { sleep } from "./paths.mjs";

export class NebiusError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-over-limit",
];

/** Keep only the rate-limit headers we care about, as a plain object. */
export function pickRateHeaders(headers) {
  const out = {};
  for (const name of RATE_LIMIT_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

function jitteredDelayMs(attempt, base = 400, cap = 8000) {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** A small concurrency limiter. `run(fn)` queues fn behind at most `concurrency` others. */
export function createLimiter(concurrency = 4) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

/**
 * client.request(path, { method, body, headers }) -> { status, headers, json, text, latencyMs }
 * (`text` is the raw response body; `json` is its JSON.parse, or null when it does not parse.)
 *
 * - `body` is JSON-serialized unless it is a FormData/Blob instance (the files
 *   upload endpoint), in which case it is sent as-is with no content-type
 *   override so fetch sets the multipart boundary itself.
 * - Retries on 429, or when the `x-ratelimit-over-limit` marker header reads
 *   "yes", with exponential backoff and jitter, up to `maxRetries`.
 * - Never throws on a non-2xx HTTP response (the caller decides); only a
 *   genuine network failure throws a NebiusError, with the API key scrubbed
 *   from its message.
 */
export function createClient({ baseUrl, apiKey, fetchImpl = fetch, maxRetries = 5, concurrency = 4 } = {}) {
  if (!baseUrl) throw new NebiusError(0, "baseUrl is required");
  if (!apiKey) throw new NebiusError(0, "apiKey is required (set NEBIUS_API_KEY in the private env file)");
  const limit = createLimiter(concurrency);

  async function request(path, { method = "GET", body, headers = {} } = {}) {
    return limit(async () => {
      const isMultipart = body instanceof FormData || body instanceof Blob;
      for (let attempt = 1; ; attempt += 1) {
        const t0 = Date.now();
        let res;
        try {
          res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${apiKey}`,
              ...(isMultipart ? {} : { "content-type": "application/json" }),
              ...headers,
            },
            body: body === undefined ? undefined : isMultipart ? body : JSON.stringify(body),
          });
        } catch (e) {
          const msg = scrubSecrets(`network failure on ${method} ${path}: ${e?.message ?? e?.name ?? "error"}`, [apiKey]);
          throw new NebiusError(0, msg);
        }
        const latencyMs = Date.now() - t0;
        const rateHeaders = pickRateHeaders(res.headers);
        const overLimit = res.status === 429 || rateHeaders["x-ratelimit-over-limit"] === "yes";
        if (overLimit && attempt <= maxRetries) {
          await sleep(jitteredDelayMs(attempt));
          continue;
        }
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return { status: res.status, ok: res.ok, headers: rateHeaders, json, text, latencyMs, attempts: attempt };
      }
    });
  }

  return { request };
}

const OUTPUT_MODES = ["json_schema", "json_object"];

/**
 * Build a chat/completions body. `mode` is "json_schema" (schema is the
 * `json_schema` object, name+schema+strict) or "json_object". `thinking` sets
 * chat_template_kwargs.enable_thinking (Nemotron reasoning toggle); with
 * thinking left on, a schema-constrained reply can exhaust max_tokens before
 * emitting JSON (measured), so callers that want a parseable reply pass false.
 */
export function buildChatBody({
  model,
  messages,
  mode = "json_schema",
  schema,
  thinking = false,
  maxTokens = 4096,
  temperature = 0,
}) {
  if (!model) throw new NebiusError(0, "model is required");
  if (!Array.isArray(messages) || messages.length === 0) throw new NebiusError(0, "messages is required");
  if (!OUTPUT_MODES.includes(mode)) throw new NebiusError(0, `mode must be one of ${OUTPUT_MODES.join(", ")}`);
  if (mode === "json_schema" && !schema) throw new NebiusError(0, "schema is required for json_schema mode");

  return {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    response_format: mode === "json_schema" ? { type: "json_schema", json_schema: schema } : { type: "json_object" },
    chat_template_kwargs: { enable_thinking: thinking },
  };
}
