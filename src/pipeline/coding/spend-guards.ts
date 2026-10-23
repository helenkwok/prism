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

export type BudgetSnapshot = { estimated: number; spent: number; cap: number };

export function formatBudgetLine(s: BudgetSnapshot): string {
  return `BUDGET: ${JSON.stringify({ estimated: s.estimated, spent: s.spent, cap: s.cap })}`;
}

/** Per-run dollar budget (mirrors CreditBudget shape). */
export class DollarBudget {
  cap: number;
  estimated = 0;
  spent = 0;
  reserved = 0;
  constructor(cap: number) {
    if (!Number.isFinite(cap) || !(cap > 0)) throw new Error("DollarBudget: cap must be finite and > 0");
    this.cap = cap;
  }
  snapshot(): BudgetSnapshot {
    return { estimated: this.estimated, spent: this.spent, cap: this.cap };
  }
  budgetLine(): string {
    return formatBudgetLine(this.snapshot());
  }
  /** True when adding `projected` spend still fits under the cap. */
  allows(projected: number): boolean {
    return this.spent + this.reserved + projected <= this.cap + 1e-12;
  }
  reserve(usd: number): void {
    if (!this.allows(usd)) throw new BudgetExceededError(this.snapshot());
    this.reserved += usd;
  }
  settle(reserved: number, actual = reserved): void {
    this.reserved = Math.max(0, this.reserved - reserved);
    this.recordSpent(actual);
  }
  addEstimated(usd: number): void {
    this.estimated += usd;
  }
  recordSpent(usd: number): void {
    this.spent += usd;
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
      if (!(n > 0)) throw new Error(`Token Factory budget flag must be a positive number, got ${argv[i + 1]}`);
      return n;
    }
  }
  const fromEnv = env.PRISM_TF_BUDGET;
  if (fromEnv != null && fromEnv !== "") {
    const n = Number(fromEnv);
    if (!(n > 0)) throw new Error(`PRISM_TF_BUDGET must be a positive number, got ${fromEnv}`);
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
}: {
  messages: { content?: string }[];
  model: string;
  budget?: DollarBudget;
  cap?: number;
  completionTokens?: number;
}): { promptTokens: number; projectedUsd: number } {
  const promptTokens = estimateMessagesTokens(messages);
  if (promptTokens > cap) throw new TooLargeError(promptTokens, cap);
  const projectedUsd = estimateCostUsd(model, promptTokens, completionTokens);
  if (budget) {
    budget.addEstimated(projectedUsd);
    if (!budget.allows(projectedUsd)) throw new BudgetExceededError(budget.snapshot());
  }
  return { promptTokens, projectedUsd };
}
