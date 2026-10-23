// Nebius Token Factory fetch wrapper (FND-05, D-21). Promoted unchanged from
// scripts/spikes/lib/nebius.mjs.
//
// Plain fetch, no SDK, so response headers (x-ratelimit-*) and vLLM extras
// (chat_template_kwargs) stay under harness control. The API key is read by
// the caller from process.env and passed in; this module never logs it and
// scrubs it from any thrown error text.
//
// Coding is pinned to D-15's configuration (spikes/nebius.md), with the model
// moved on 2026-10-19 (see PINNED_MODEL and SECOND_CODER_MODEL), baseUrl "https://api.tokenfactory.nebius.com/v1", mode "json_schema",
// thinking false.

import { scrubSecrets } from "../evidence/redact.ts";
import {
  assertRequestAllowed,
  DEFAULT_TOKEN_CAP,
  DollarBudget,
  measuredCostUsd,
  tokenCount, cachedTokenCount, outputTokenLimit, reservationInputTokens, prefixDigest,
  type UsageObserver,
  ReservationExceededError,
  TooLargeError,
  type BudgetSnapshot,
} from "./spend-guards.ts";

export { TooLargeError, DollarBudget, DEFAULT_TOKEN_CAP };

export class NebiusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Live CLI stop: out of credit / balance / quota (D-64). */
export class QuotaStop extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "QuotaStop";
  }
}

/** True for HTTP 402, or 403/429 after retries, or a non-OK body naming credit/balance/quota. */
export function isQuotaResponse(res: { status: number; ok?: boolean; text?: string; json?: unknown }): boolean {
  if (res.status === 402 || res.status === 403 || res.status === 429) return true;
  // Never scan a successful body: coding replies can mention "credit"/"balance"/"quota" as data.
  if (res.ok === true || (res.status >= 200 && res.status < 300)) return false;
  const blob = `${res.text ?? ""} ${typeof res.json === "string" ? res.json : JSON.stringify(res.json ?? "")}`.toLowerCase();
  return /\b(credit|balance|quota)\b/.test(blob);
}

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-over-limit",
];

/** Keep only the rate-limit headers we care about, as a plain object. */
export function pickRateHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jitteredDelayMs(attempt: number, base = 400, cap = 8000): number {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** A small concurrency limiter. `run(fn)` queues fn behind at most `concurrency` others. */
export function createLimiter(concurrency = 4) {
  let active = 0;
  const queue: { fn: () => any; resolve: (v: any) => void; reject: (e: any) => void }[] = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift()!;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  return function run<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

export interface NebiusResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  json: unknown;
  text: string;
  latencyMs: number;
  attempts: number;
}

export type FetchImpl = typeof fetch;

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
export function createClient({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  maxRetries = 5,
  concurrency = 4,
  /** Per-run $ cap (D-67). Required unless skipBudgetGate (unit tests of HTTP only). */
  budget,
  skipBudgetGate = false,
  tokenCap = DEFAULT_TOKEN_CAP,
  onUsage, stage,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  maxRetries?: number;
  concurrency?: number;
  budget?: number | DollarBudget;
  skipBudgetGate?: boolean;
  tokenCap?: number;
  onUsage?: UsageObserver;
  stage?: string;
}) {
  if (!baseUrl) throw new NebiusError(0, "baseUrl is required");
  if (!apiKey) throw new NebiusError(0, "apiKey is required (set NEBIUS_API_KEY in the private env file)");
  if (!skipBudgetGate && budget == null) {
    throw new Error(
      "Token Factory requires an explicit budget: pass --budget <dollars> (or --token-factory-budget) or set PRISM_TF_BUDGET",
    );
  }
  const dollarBudget =
    budget == null ? undefined : budget instanceof DollarBudget ? budget : new DollarBudget(budget);
  const limit = createLimiter(concurrency);

  async function request(
    path: string,
    { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<NebiusResponse & { outcome?: "too-large"; budget?: BudgetSnapshot }> {
    return limit(async () => {
      const isMultipart = body instanceof FormData || body instanceof Blob;
      let projectedUsd = 0;
      let requestModel = "";
      // D-67: estimate + refuse before any HTTP for chat/completions with messages.
      if (!isMultipart && body && typeof body === "object" && Array.isArray((body as any).messages)) {
        const messages = (body as any).messages as { content?: string }[];
        const model = String((body as any).model ?? "");
        requestModel = model || "deepseek-ai/DeepSeek-V4-Flash-0731";
        body = { ...body, max_tokens: outputTokenLimit((body as any).max_tokens) };
        try {
          ({ projectedUsd } = assertRequestAllowed({
            messages,
            model: model || "deepseek-ai/DeepSeek-V4-Flash-0731",
            budget: dollarBudget,
            cap: tokenCap,
            completionTokens: (body as any).max_tokens,
            reservationTokens: reservationInputTokens(body),
          }));
        } catch (e) {
          if (e instanceof TooLargeError) {
            return {
              status: 0,
              ok: false,
              headers: {},
              json: { error: "too-large", estimate: e.estimate, cap: e.cap },
              text: e.message,
              latencyMs: 0,
              attempts: 0,
              outcome: "too-large" as const,
              budget: dollarBudget?.snapshot(),
            };
          }
          throw e;
        }
      }
      for (let attempt = 1; ; attempt += 1) {
        dollarBudget?.reserve(projectedUsd);
        const t0 = Date.now();
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${apiKey}`,
              ...(isMultipart ? {} : { "content-type": "application/json" }),
              ...headers,
            },
            body: body === undefined ? undefined : isMultipart ? (body as BodyInit) : JSON.stringify(body),
          });
        } catch (e: any) {
          dollarBudget?.settle(projectedUsd);
          if (attempt <= maxRetries) {
            await sleep(jitteredDelayMs(attempt));
            continue;
          }
          const msg = scrubSecrets(`network failure on ${method} ${path}: ${e?.message ?? e?.name ?? "error"}`, [apiKey]);
          throw new NebiusError(0, msg);
        }
        const latencyMs = Date.now() - t0;
        const rateHeaders = pickRateHeaders(res.headers);
        const overLimit = res.status === 429 || rateHeaders["x-ratelimit-over-limit"] === "yes";
        if (overLimit && attempt <= maxRetries) {
          dollarBudget?.settle(projectedUsd);
          await sleep(jitteredDelayMs(attempt));
          continue;
        }
        let text: string;
        try { text = await res.text(); } catch (error) { dollarBudget?.settle(projectedUsd); throw error; }
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        const usage = (json as any)?.usage;
        const inputTokens = tokenCount(usage?.prompt_tokens);
        const outputTokens = tokenCount(usage?.completion_tokens);
        const cachedInputTokens = cachedTokenCount(usage?.prompt_tokens_details?.cached_tokens, inputTokens);
        const measured = inputTokens !== null && outputTokens !== null;
        const actualUsd = measured && requestModel
          ? measuredCostUsd(requestModel, inputTokens, outputTokens, cachedInputTokens) : projectedUsd;
        dollarBudget?.settle(projectedUsd, actualUsd);
        if (requestModel) onUsage?.({ provider: "token-factory", stage: stage ?? null, model: requestModel,
          inputTokens, outputTokens, cachedInputTokens, prefixDigest: prefixDigest((body as any).messages),
          chargedUsd: actualUsd, measured, status: res.status, attempt, latencyMs });
        if (dollarBudget && actualUsd > projectedUsd + 1e-12)
          throw new ReservationExceededError(dollarBudget.snapshot());
        return {
          status: res.status,
          ok: res.ok,
          headers: rateHeaders,
          json,
          text,
          latencyMs,
          attempts: attempt,
          budget: dollarBudget?.snapshot(),
        };
      }
    });
  }

  return { request, dollarBudget };
}

const OUTPUT_MODES = ["json_schema", "json_object"] as const;

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
  reasoningEffort,
}: {
  model: string;
  messages: { role: string; content: string }[];
  mode?: (typeof OUTPUT_MODES)[number];
  schema?: unknown;
  thinking?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** D-62: GLM reasoning_effort; omitted → body byte-identical to pre-D-62. */
  reasoningEffort?: "low" | "medium" | "high";
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
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

/** D-15's pinned coding configuration (spikes/nebius.md). Primary coder since 2026-10-19:
 * the cheapest model that codes reliably (Helen's rule), chosen on 21 projects x 24 checks
 * (precision 0.74, pooled recall 0.71, $0.0057 per project). Nemotron is the second coder. */
export const PINNED_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
/** The NVIDIA second coder (hackathon rule: at least one NVIDIA open model): highest precision (0.88). */
export const SECOND_CODER_MODEL = "nvidia/Nemotron-3.5-Super-VL";
export const PINNED_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
