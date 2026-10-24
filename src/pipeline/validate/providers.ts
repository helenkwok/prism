// Per-role inference provider (D-65) and A6/D-47 family independence.

import {
  createClient,
  PINNED_BASE_URL,
  PINNED_MODEL,
  SECOND_CODER_MODEL,
  type FetchImpl,
  QuotaStop,
} from "../coding/nebius-client.ts";
import { requireTfBudget, DollarBudget, DEFAULT_TOKEN_CAP, assertRequestAllowed, measuredCostUsd, tokenCount, cachedTokenCount, outputTokenLimit, reservationInputTokens, prefixDigest, ReservationExceededError, type UsageObserver } from "../coding/spend-guards.ts";
import { CONFIRMER_MODEL } from "../confirm/confirm.ts";
import { SCREENER_MODEL } from "../select/screen-model.ts";

export const OLLAMA_BASE_URL = "http://localhost:11434";

export type RoleName = "gold" | "auditor" | "gatherer";

export interface RoleSpec {
  provider: "ollama" | "token-factory";
  model: string;
  /** string → reasoning_effort / think; boolean → Ollama think / chat_template_kwargs */
  reasoning: "low" | "medium" | "high" | boolean;
}

/**
 * D-67 defaults: bulk gold/confirm/code2 → Ollama (billed against Pro credit).
 * Token Factory only with explicit --budget (coding showcase / capped recode).
 * Confirm default model id (Task G): nemotron-3-ultra on Ollama.
 * Code2 default: Super-VL on Ollama if available, else substitution recorded per A6.
 */
export const ROLE_CONFIG: Record<RoleName, RoleSpec> = {
  gold: { provider: "ollama", model: "glm-5.3-flash", reasoning: "low" },
  auditor: { provider: "ollama", model: "kimi-k3:cloud", reasoning: true },
  // low reasoning + larger num_predict: bare JSON items, fewer prose/empty replies (04-08 remasure)
  gatherer: { provider: "ollama", model: "kimi-k3:cloud", reasoning: "low" },
};

/** Task G hooks: concurrency 1–2, backoff, usage-cap stop; counters exportable. */
export type OllamaUsageCounters = {
  calls: number;
  retries: number;
  limit_hits: number;
};

export function createOllamaCounters(): OllamaUsageCounters {
  return { calls: 0, retries: 0, limit_hits: 0 };
}

export function formatOllamaSummary(c: OllamaUsageCounters): string {
  return `OLLAMA: ${JSON.stringify({ calls: c.calls, retries: c.retries, limit_hits: c.limit_hits })}`;
}

const FAMILY_NAMES = ["deepseek", "nemotron", "qwen", "glm", "kimi", "gemma", "llama"] as const;

export function familyOf(model: string): string {
  const lower = model.toLowerCase();
  for (const f of FAMILY_NAMES) {
    if (lower.includes(f)) return f;
  }
  const slash = lower.indexOf("/");
  return slash >= 0 ? lower.slice(0, slash) : lower;
}

export function assertIndependent(role: RoleName, model: string): void {
  const fam = familyOf(model);
  if (role === "gold") {
    for (const banned of [PINNED_MODEL, SECOND_CODER_MODEL, CONFIRMER_MODEL, SCREENER_MODEL]) {
      if (fam === familyOf(banned)) throw new Error(`A6: gold labeller family ${fam} overlaps ${banned}`);
    }
    return;
  }
  if (fam === familyOf(SCREENER_MODEL)) throw new Error(`A6: ${role} family ${fam} overlaps screener`);
  if (fam === familyOf(ROLE_CONFIG.gold.model)) throw new Error(`A6: ${role} family ${fam} overlaps gold labeller`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ThinkingEnvelopeAudit = { model: string; nativeResponse: string; status: number; rawContent: string; reasoningContent: string | null; content: string; split: boolean };

export function thinkingEnvelopeEnabled(stage: string | undefined, model: string, requested: boolean): boolean {
  return requested && stage === "second-coder" && /^nemotron-3-super(?::cloud)?$/.test(model);
}

/** Split one leading channel envelope only. Final-answer validation remains the caller's job. */
export function splitLeadingThinkingBlock(raw: string): { reasoning: string; content: string } | null {
  const match = /^\s*<think>([\s\S]*?)<\/think>([\s\S]*)$/.exec(raw);
  if (!match || /<\/?think\b/i.test(match[1]) || /<\/?think\b/i.test(match[2])) return null;
  return { reasoning: match[1], content: match[2] };
}

/** The same native payload is used for byte-bound cost preflight and transmission. */
export function ollamaRequestBody(body: any) {
  const rf = body.response_format;
  const format = rf?.type === "json_schema" ? rf.json_schema?.schema : rf?.type === "json_object" ? "json" : undefined;
  const think = body.reasoning_effort !== undefined ? body.reasoning_effort : body.chat_template_kwargs?.enable_thinking;
  return { model: body.model, messages: body.messages, stream: false,
    ...(format !== undefined ? { format } : {}), ...(think !== undefined ? { think } : {}),
    options: { ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), num_predict: outputTokenLimit(body.max_tokens) } };
}

/** Translate an OpenAI-style chat body into Ollama /api/chat; return OpenAI-shaped json. */
export function ollamaClient({
  baseUrl = OLLAMA_BASE_URL,
  fetchImpl = fetch,
  maxRetries = 3,
  /** D-67 Task G: keep ≤2 for bulk; wired here so counters exist before Task G runs. */
  concurrency = 2,
  counters = createOllamaCounters(),
  budget = 5,
  tokenCap = DEFAULT_TOKEN_CAP,
  tokenCapForRequest,
  onUsage, stage,
  splitNemotronThinking = false, onThinkingEnvelope,
}: {
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  maxRetries?: number;
  concurrency?: number;
  counters?: OllamaUsageCounters;
  budget?: number | DollarBudget;
  tokenCap?: number;
  tokenCapForRequest?: (body: any) => number;
  onUsage?: UsageObserver;
  stage?: string;
  splitNemotronThinking?: boolean;
  onThinkingEnvelope?: (audit: ThinkingEnvelopeAudit) => void;
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("Ollama concurrency must be 1–2");
  const dollarBudget = budget instanceof DollarBudget ? budget : new DollarBudget(budget);
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < concurrency) {
        active += 1;
        resolve();
      } else waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  async function request(
    _path: string,
    { method = "POST", body }: { method?: string; body?: any } = {},
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    if (!body?.model || !body?.messages) throw new Error("ollamaClient: body.model and body.messages required");
    if (thinkingEnvelopeEnabled(stage, body.model, splitNemotronThinking) && !onThinkingEnvelope) throw new Error("second-coder envelope separation requires a private audit callback");
    const maxTokens = outputTokenLimit(body.max_tokens);
    const ollamaBody = ollamaRequestBody(body);
    await acquire();
    const usageAttempts: Record<string, unknown>[] = [];
    try {
      for (let attempt = 1; ; attempt += 1) {
        let cap = Math.min(tokenCap, DEFAULT_TOKEN_CAP);
        if (tokenCapForRequest && stage === "full-confirm" && /^nemotron-3-ultra(?::cloud)?$/.test(body.model)) {
          const approvedCap = tokenCapForRequest(body);
          if (approvedCap !== DEFAULT_TOKEN_CAP && approvedCap !== 50_000) throw new Error("invalid approved request cap");
          if (approvedCap === 50_000) cap = approvedCap;
        }
        const inputBound = reservationInputTokens(ollamaBody);
        const { projectedUsd } = assertRequestAllowed({ messages: body.messages, model: body.model, budget: dollarBudget, cap, completionTokens: maxTokens, reservationTokens: inputBound });
        dollarBudget.reserve(projectedUsd);
        counters.calls += 1;
        const started = Date.now();
        const transportFailure = (error: unknown, phase: "request" | "response-body") => {
          dollarBudget.settle(projectedUsd);
          const name = (error as any)?.name;
          const code = (error as any)?.cause?.code ?? (error as any)?.code;
          try {
            onUsage?.({ provider: "ollama", stage: stage ?? null, model: body.model,
              inputTokens: null, outputTokens: null, cachedInputTokens: null, measured: false,
              prefixDigest: prefixDigest(body.messages), chargedUsd: projectedUsd, status: 0, attempt,
              latencyMs: Math.max(0, Date.now() - started), transportFailure: true, phase,
              errorName: typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error",
              causeCode: typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null,
              reservation_bounds: { inputTokens: inputBound, outputTokens: maxTokens, spentUsd: projectedUsd, source: "request-reservation-upper-bound" },
            });
          } catch { /* The original transport failure remains the thrown error. */ }
        };
        let res: Response;
        try { res = await fetchImpl(`${baseUrl}/api/chat`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ollamaBody),
        }); } catch (error) { transportFailure(error, "request"); throw error; }
        let text: string;
        try { text = await res.text(); } catch (error) { transportFailure(error, "response-body"); throw error; }
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        const prompt = tokenCount(parsed?.prompt_eval_count);
        const completion = tokenCount(parsed?.eval_count);
        const cached = cachedTokenCount(parsed?.prompt_eval_cached_count, prompt);
        const measured = prompt !== null && completion !== null;
        const actual = measured ? measuredCostUsd(body.model, prompt, completion, cached) : projectedUsd;
        const reservationBounds = measured ? undefined : { inputTokens: inputBound, outputTokens: maxTokens, spentUsd: projectedUsd, source: "request-reservation-upper-bound" as const };
        const normalizedUsage = { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached }, ...(reservationBounds ? { reservation_bounds: reservationBounds } : {}) };
        usageAttempts.push(normalizedUsage);
        dollarBudget.settle(projectedUsd, actual);
        const rawContent = parsed?.message?.content ?? "";
        let content = rawContent;
        let channelFields = {};
        if (thinkingEnvelopeEnabled(stage, body.model, splitNemotronThinking)) {
          const envelope = typeof rawContent === "string" ? splitLeadingThinkingBlock(rawContent) : null;
          if (envelope) content = envelope.content;
          const reasoning = envelope?.reasoning ?? (typeof parsed?.message?.thinking === "string" ? parsed.message.thinking : null);
          channelFields = { raw_content: rawContent, ...(reasoning !== null ? { reasoning_content: reasoning } : {}) };
          onThinkingEnvelope?.({ model: body.model, nativeResponse: text, status: res.status, rawContent: typeof rawContent === "string" ? rawContent : "", reasoningContent: reasoning, content: typeof content === "string" ? content : "", split: envelope !== null });
        }
        onUsage?.({ provider: "ollama", stage: stage ?? null, model: body.model,
          inputTokens: prompt, outputTokens: completion, cachedInputTokens: cached,
          prefixDigest: prefixDigest(body.messages), chargedUsd: actual, measured,
          status: res.status, attempt, latencyMs: Date.now() - started,
          ...(reservationBounds ? { reservation_bounds: reservationBounds } : {}) });
        if (actual > projectedUsd + 1e-12) throw new ReservationExceededError(dollarBudget.snapshot());
        const blob = res.ok ? "" : `${text} ${JSON.stringify(parsed ?? "")}`.toLowerCase();
        const concurrent = res.status === 429 || /too many concurrent/.test(blob);
        const usageCap = /usage.?cap|rate.?limit.*pro|pro.*usage|insufficient.*credit|credit.*(?:exhausted|insufficient)|out of credits/.test(blob);
        if (usageCap || res.status === 402 || res.status === 403) {
          counters.limit_hits += 1;
          throw new QuotaStop(res.status, `OLLAMA usage-cap: stop and report (${formatOllamaSummary(counters)})`);
        }
        if (concurrent && attempt <= maxRetries) {
          counters.retries += 1;
          counters.limit_hits += 1;
          await sleep(400 * attempt);
          continue;
        }
        if (concurrent) throw new QuotaStop(res.status, `OLLAMA concurrency limit: stop and report (${formatOllamaSummary(counters)})`);
        const finish = parsed?.done_reason ?? (parsed?.done ? "stop" : undefined);
        return {
          ok: res.ok,
          status: res.status,
          text,
          json: { choices: [{ message: { content, ...channelFields }, finish_reason: finish }],
            usage: normalizedUsage, usage_attempts: usageAttempts,
            prompt_eval_count: prompt, eval_count: completion, prompt_eval_cached_count: cached },
        };
      }
    } finally {
      release();
    }
  }
  return { request, counters, dollarBudget };
}

export function roleClient(
  role: RoleName,
  {
    nebiusKey,
    fetchImpl,
    roleSpec, budget, counters, concurrency, onUsage, stage, splitNemotronThinking, onThinkingEnvelope,
  }: { nebiusKey?: string; fetchImpl?: FetchImpl; roleSpec?: RoleSpec; budget?: number | DollarBudget;
    counters?: OllamaUsageCounters; concurrency?: number; onUsage?: UsageObserver; stage?: string;
    splitNemotronThinking?: boolean; onThinkingEnvelope?: (audit: ThinkingEnvelopeAudit) => void } = {},
) {
  const spec = roleSpec ?? ROLE_CONFIG[role];
  if (!spec) throw new Error(`unknown role: ${role}`);
  if (spec.model === "openrouter/free") throw new Error("D-65: openrouter/free is never a valid model");
  assertIndependent(role, spec.model);
  if (spec.provider === "token-factory") {
    if (!nebiusKey) throw new Error("token-factory role needs nebiusKey");
    // D-67: TF roles need an explicit budget (env or caller-supplied via process argv).
    return createClient({
      baseUrl: PINNED_BASE_URL,
      apiKey: nebiusKey,
      fetchImpl,
      budget: budget ?? requireTfBudget(),
      onUsage, stage, concurrency,
    });
  }
  return ollamaClient({ fetchImpl, budget, counters, concurrency, onUsage, stage, splitNemotronThinking, onThinkingEnvelope });
}
