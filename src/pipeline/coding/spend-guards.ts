import { createHash } from "node:crypto";

// D-67 spending guards: per-request token cap + per-run $ budget + TF budget flag.
// No Token Factory HTTP until estimate ≤ cap and an explicit budget is set.

/** Default per-request prompt token cap (estimateTokens). */
export const DEFAULT_TOKEN_CAP = 20_000;

/**
 * Token Factory list prices (USD per token) from Nebius catalogue
 * (~/.prism-data/spikes/nebius-catalogue-raw.json, prompt/completion fields).
 * DeepSeek-V4-Flash-0731: $0.14 / $0.28 per MTok; Ultra: $1 / $3 per MTok.
 */
export const LIST_PRICES: Record<string, { prompt: number; completion: number }> = {
  "deepseek-ai/DeepSeek-V4-Flash-0731": { prompt: 0.00000014, completion: 0.00000028 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { prompt: 0.000001, completion: 0.000003 },
  "nvidia/Nemotron-3.5-Super-VL": { prompt: 0.0000003, completion: 0.0000009 },
  // https://nebius.com/services/token-factory/models/qwen-models-inference
  "Qwen/Qwen3.5-397B-A17B": { prompt: 0.60 / 1e6, completion: 3.60 / 1e6 },
  // USD per token; D-65/D-67 correction 2026-10-23, Pro monthly credit is $60.
  "glm-5.3-flash": { prompt: 0.15 / 1e6, completion: 0.50 / 1e6 },
  "nemotron-3-ultra": { prompt: 0.10 / 1e6, completion: 3 / 1e6 },
  "nemotron-3-super": { prompt: 0.015 / 1e6, completion: 0.60 / 1e6 },
  // Standard rates, no cache or off-peak discount assumed: https://ollama.com/pricing
  "deepseek-v4.1-flash": { prompt: 0.30 / 1e6, completion: 1.20 / 1e6 },
  "kimi-k3": { prompt: 3 / 1e6, completion: 15 / 1e6 },
  "glm-5.3": { prompt: 1.40 / 1e6, completion: 4.40 / 1e6 },
  "minimax-m3.1-flash": { prompt: 0.15 / 1e6, completion: 0.60 / 1e6 },
};

/** Heuristic: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

export function estimateMessagesTokens(messages: { content?: string }[]): number {
  let n = 0;
  for (const m of messages ?? []) n += estimateTokens(m?.content ?? "");
  return n;
}

export function priceOf(model: string): { prompt: number; completion: number } {
  const p = LIST_PRICES[model.replace(/:cloud$/, "")];
  if (!p) throw new Error(`spend-guards: no list price for model ${model}`);
  return p;
}

/** Cost estimate in USD for prompt (+ optional completion) tokens at list price. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens = 0,
): number {
  const p = priceOf(model);
  return promptTokens * p.prompt + completionTokens * p.completion;
}

export const CACHED_PRICES: Record<string, number> = {
  // Provider public catalogue, checked 2026-10-23: /api/public/models_info.
  "deepseek-ai/DeepSeek-V4-Flash-0731": .01 / 1e6,
  "glm-5.3-flash": .03 / 1e6,
  "nemotron-3-super": .015 / 1e6,
  "nemotron-3-ultra": .10 / 1e6,
};

/** Discount only measured cache hits with a verified published rate. */
export function measuredCostUsd(model: string, input: number, output: number, cached: number | null): number {
  const rate = CACHED_PRICES[model.replace(/:cloud$/, "")];
  const hits = rate !== undefined && cached !== null ? cached : 0;
  return estimateCostUsd(model, input - hits, output) + hits * (rate ?? 0);
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function cachedTokenCount(value: unknown, input: number | null): number | null {
  const count = tokenCount(value);
  return count !== null && input !== null && count <= input ? count : null;
}

export function outputTokenLimit(value: unknown): number {
  if (value === undefined) return 4096;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("max_tokens must be a positive integer");
  return value;
}

/** Byte-bound reservation includes schema and a conservative template allowance. */
export function reservationInputTokens(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
}

export type ReservationUsageBounds = { inputTokens: number; outputTokens: number; spentUsd: number; source: "request-reservation-upper-bound" };

export type UsageObservation = {
  provider: "ollama" | "token-factory";
  stage: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  prefixDigest: string | null;
  chargedUsd: number;
  measured: boolean;
  status: number;
  attempt: number;
  latencyMs: number;
  reservation_bounds?: ReservationUsageBounds;
};
export type UsageObserver = (observation: UsageObservation) => void;

export function prefixDigest(messages: { role?: string; content?: string }[]): string | null {
  const prefix = messages.filter(m => m.role === "system").map(m => m.content ?? "").join("\n");
  return prefix ? createHash("sha256").update(prefix).digest("hex") : null;
}

export type BudgetSnapshot = { estimated: number; spent: number; cap: number };

export function formatBudgetLine(s: BudgetSnapshot): string {
  return `BUDGET: ${JSON.stringify({ estimated: s.estimated, spent: s.spent, cap: s.cap })}`;
}

/** Per-run dollar budget (mirrors CreditBudget shape). */
export type BudgetState = BudgetSnapshot & { reserved: number };

export class DollarBudget {
  cap: number;
  estimated = 0;
  spent: number;
  reserved = 0;
  readonly parent?: DollarBudget;
  private readonly onChange?: (state: BudgetState) => void;
  constructor(cap: number, options: { parent?: DollarBudget; initialSpent?: number; onChange?: (state: BudgetState) => void } = {}) {
    if (!Number.isFinite(cap) || !(cap > 0)) throw new Error("DollarBudget: cap must be finite and > 0");
    this.cap = cap;
    this.spent = options.initialSpent ?? 0;
    this.validate(this.spent);
    this.parent = options.parent;
    this.onChange = options.onChange;
  }
  private validate(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("DollarBudget: amount must be finite and nonnegative");
  }
  private changed(): void { this.onChange?.({ ...this.snapshot(), reserved: this.reserved }); }
  snapshot(): BudgetSnapshot { return { estimated: this.estimated, spent: this.spent, cap: this.cap }; }
  budgetLine(): string { return formatBudgetLine(this.snapshot()); }
  allows(projected: number): boolean {
    this.validate(projected);
    return this.spent + this.reserved + projected <= this.cap + 1e-12 && (this.parent?.allows(projected) ?? true);
  }
  reserve(usd: number): void {
    if (!this.allows(usd)) throw new BudgetExceededError(this.parent && !this.parent.allows(usd) ? this.parent.snapshot() : this.snapshot());
    this.parent?.reserve(usd);
    this.reserved += usd;
    this.changed();
  }
  settle(reserved: number, actual = reserved): void {
    this.validate(reserved); this.validate(actual);
    this.reserved = Math.max(0, this.reserved - reserved);
    this.spent += actual;
    this.parent?.settle(reserved, actual);
    this.changed();
  }
  addEstimated(usd: number): void {
    this.validate(usd); this.estimated += usd; this.parent?.addEstimated(usd);
  }
  recordSpent(usd: number): void {
    this.validate(usd); this.spent += usd; this.parent?.recordSpent(usd); this.changed();
  }
}

export class TooLargeError extends Error {
  estimate: number;
  cap: number;
  constructor(estimate: number, cap: number) {
    super(`too-large: estimated ${estimate} tokens exceeds cap ${cap}`);
    this.name = "TooLargeError";
    this.estimate = estimate;
    this.cap = cap;
  }
}

export class BudgetExceededError extends Error {
  snapshot: BudgetSnapshot;
  constructor(snapshot: BudgetSnapshot) {
    super(`budget exceeded: ${formatBudgetLine(snapshot)}`);
    this.name = "BudgetExceededError";
    this.snapshot = snapshot;
  }
}

/** Metering beyond the reserved bound requires a stop even below the run cap. */
export class ReservationExceededError extends BudgetExceededError {
  constructor(snapshot: BudgetSnapshot) {
    super(snapshot);
    this.message = `usage exceeded reserved allowance: ${formatBudgetLine(snapshot)}`;
  }
}

/**
 * Resolve TF budget from CLI `--budget <n>` / `--token-factory-budget <n>` or
 * env `PRISM_TF_BUDGET`. Throws if missing — Token Factory bulk must be explicit.
 */
export function requireTfBudget(opts?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): number {
  const argv = opts?.argv ?? process.argv;
  const env = opts?.env ?? process.env;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--budget" || argv[i] === "--token-factory-budget") && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || !(n > 0)) throw new Error(`Token Factory budget flag must be a finite positive number, got ${argv[i + 1]}`);
      return n;
    }
  }
  const fromEnv = env.PRISM_TF_BUDGET;
  if (fromEnv != null && fromEnv !== "") {
    const n = Number(fromEnv);
    if (!Number.isFinite(n) || !(n > 0)) throw new Error(`PRISM_TF_BUDGET must be a finite positive number, got ${fromEnv}`);
    return n;
  }
  throw new Error(
    "Token Factory requires an explicit budget: pass --budget <dollars> (or --token-factory-budget) or set PRISM_TF_BUDGET",
  );
}

/**
 * Refuse before fetch when estimate > cap. Returns `{ outcome: "too-large", ... }`
 * without calling `fetchImpl`. Otherwise calls fetchImpl and returns its result.
 */
export async function guardedFetch(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  {
    estimate,
    cap = DEFAULT_TOKEN_CAP,
  }: { estimate: number; cap?: number },
): Promise<Response | { outcome: "too-large"; estimate: number; cap: number }> {
  if (estimate > cap) {
    return { outcome: "too-large", estimate, cap };
  }
  return fetchImpl(input, init);
}

/** Pre-check a chat body: throw TooLargeError / BudgetExceededError before HTTP. */
export function assertRequestAllowed({
  messages,
  model,
  budget,
  cap = DEFAULT_TOKEN_CAP,
  completionTokens = 4096,
  reservationTokens,
}: {
  messages: { content?: string }[];
  model: string;
  budget?: DollarBudget;
  cap?: number;
  completionTokens?: number;
  reservationTokens?: number;
}): { promptTokens: number; projectedUsd: number } {
  const promptTokens = estimateMessagesTokens(messages);
  if (promptTokens > cap) throw new TooLargeError(promptTokens, cap);
  const projectedUsd = estimateCostUsd(model, reservationTokens ?? promptTokens, completionTokens);
  if (budget) {
    budget.addEstimated(projectedUsd);
    if (!budget.allows(projectedUsd)) throw new BudgetExceededError(budget.snapshot());
  }
  return { promptTokens, projectedUsd };
}
