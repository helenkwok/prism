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

/** Evidence collectors. Tavily runs on the user's own key, or on PRISM's within its demo limits. Extend the list, not the form. */
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
  /** Tavily runs: credits spent and whose key paid. */
  tavily?: { credits: number; paidBy: string };
}

// ---- demo limits on PRISM's own keys (Helen, 2026-10-24; counted in demo-quota.ts) ----------------

export type DemoKind = "tavily" | "model";
/** Which limit refused a run on PRISM's key, and when it frees up (ISO; null for a spent total). */
export interface DemoLimitHit {
  kind: DemoKind;
  limit: "session" | "account" | "total";
  of: number;
  resetsAt: string | null;
}
/** What the signed-in session has left on PRISM's keys. Totals only for Tavily (credits). */
export interface DemoAllowance {
  kind: DemoKind;
  sessionLeft: number;
  sessionOf: number;
  sessionResetsAt: string | null;
  accountLeft: number;
  accountOf: number;
  accountResetsAt: string | null;
  totalLeft: number | null;
  totalOf: number | null;
  perRun: number | null;
}

const DEMO_WHAT: Record<DemoKind, string> = { tavily: "Tavily", model: "model" };
const OWN_KEY: Record<DemoKind, string> = {
  tavily: "Use your own Tavily key, or the own-site collector",
  model: "Use your own Token Factory key (or an OpenRouter key)",
};
/** Local time of day, in the reader's own time zone, with the zone named. */
export const localTime = (isoString: string) =>
  new Date(isoString).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

/** "2 of 3 Tavily runs left today on PRISM's demo budget": the tighter of the session and account limits. */
export function allowanceLine(a: DemoAllowance, at: (iso: string) => string = localTime): string {
  const account = a.accountLeft < a.sessionLeft;
  const left = account ? a.accountLeft : a.sessionLeft;
  const of = account ? a.accountOf : a.sessionOf;
  const reset = account ? a.accountResetsAt : a.sessionResetsAt;
  let line = `${left} of ${of} ${DEMO_WHAT[a.kind]} runs left today ${account ? "for this account " : ""}on PRISM's demo budget`;
  if (left === 0 && reset) line += `; the next one frees up ${at(reset)}`;
  if (a.totalLeft !== null) line += ` (${a.totalLeft} of ${a.totalOf} Tavily credits left; up to ${a.perRun} per run)`;
  return line + ".";
}

/** The refusal text for a demo limit: which limit, when it resets, and the way round it. */
export function demoLimitMessage(h: DemoLimitHit, at: (iso: string) => string = localTime): string {
  const what = DEMO_WHAT[h.kind];
  const head =
    h.limit === "total"
      ? `Not run: PRISM's Tavily demo budget (${h.of} credits) is used up.`
      : `Not run: ${h.limit === "session" ? "this session" : "this account"} has used all ${h.of} ${what} runs on PRISM's demo budget in the last 24 hours.${h.resetsAt ? ` The next one frees up ${at(h.resetsAt)}.` : ""}`;
  return `${head} ${OWN_KEY[h.kind]}, or read the recorded reports. Nothing was fetched.`;
}
