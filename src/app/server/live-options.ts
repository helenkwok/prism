// Bring-your-own-key choices for the live run (Helen, 2026-10-24). Fixed allow-lists only: the
// client sends an id from these lists, never a URL, so the server's outbound hosts stay fixed
// (no SSRF). Each provider's base URL and model map live on the server, in live-run.ts. Labels
// only here, so the form can import this file without pulling server code into the client.

export const MODEL_PROVIDERS = {
  "token-factory": "Nebius Token Factory",
  openrouter: "OpenRouter (alternative, your key only)",
} as const;
export type ProviderId = keyof typeof MODEL_PROVIDERS;
export const DEFAULT_PROVIDER: ProviderId = "token-factory";
/** The provider's plain name, for the report and the run receipt. */
export const PROVIDER_NAME: Record<ProviderId, string> = { "token-factory": "Nebius Token Factory", openrouter: "OpenRouter" };

/** Evidence collectors. Tavily needs the user's own Tavily key. Extend the list, not the form. */
export const COLLECTORS = {
  "own-site": "own-site collector",
  tavily: "Tavily",
} as const;
export type CollectorId = keyof typeof COLLECTORS;

export type KeySource = "server" | "user";
export const PAID_BY: Record<KeySource, string> = { server: "PRISM's key", user: "your key" };
/** The same, in the stored report, which judges and companies read: the runner's key is not theirs. */
export const REPORT_PAID_BY: Record<KeySource, string> = { server: "PRISM's key", user: "the runner's own key" };

export const KEY_NOTE = "Used for this run only and never stored.";

/** Plain model names for the progress list and the receipt, by pipeline model id. */
export const MODEL_NAME: Record<string, string> = {
  "nvidia/Nemotron-3_5-Lightning": "Nemotron 3.5 Lightning",
  "deepseek-ai/DeepSeek-V4-Flash-0731": "DeepSeek V4 Flash",
  "nvidia/Nemotron-3-Ultra-550b-a55b": "Nemotron 3 Ultra",
};
/** Which model each model stage calls (live-run.ts and run.ts use these ids). */
export const STAGE_MODEL: Record<string, string> = {
  screen: "nvidia/Nemotron-3_5-Lightning",
  code: "deepseek-ai/DeepSeek-V4-Flash-0731",
  confirm: "nvidia/Nemotron-3-Ultra-550b-a55b",
};
/** J7: a rough wait per job ahead in the queue, the median full run on the 2026-10-24 tests. */
export const MEDIAN_RUN_SECONDS = 135;

/** The run receipt (J2): per stage model, provider, key source, tokens and list-price dollars. No keys. */
export interface ReceiptLine {
  stage: string;
  model: string;
  provider: string;
  paidBy: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}
export interface RunReceipt {
  lines: ReceiptLine[];
  total: { calls: number; tokensIn: number; tokensOut: number; usd: number };
  /** Estimate: the same tokens at Nemotron 3 Ultra's Token Factory list price, for every model step. */
  ultraEstimateUsd: number;
}
