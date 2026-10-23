// Offline projections: no client construction, network requests, or source-data writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveDataDir } from "../../app/server/db.ts";
import { loadCodebook, type Codebook } from "../coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../coding/contract.ts";
import { DEFAULT_TOKEN_CAP, estimateMessagesTokens, estimateCostUsd, LIST_PRICES } from "../coding/spend-guards.ts";
import { confirmMessages, projectSpans } from "../confirm/confirm.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS } from "../run.ts";

type Span = { id: string; text: string };
type Project = { n: number; hn_id: string; spans: Span[] };
type Projection = { requests: number; inputTokens: number; outputTokens: number; refusedRequests: number; allowedInputTokens: number; allowedOutputTokens: number };
type CostRow = Projection & { host: string; role: string; model: string; projects: number; chunkChars: number; deduplicate: boolean; usd: number | null; allowedUsd: number | null; priceStatus: string; outputBasis: string; workloadBasis?: string };
const emptyProjection = (): Projection => ({ requests: 0, inputTokens: 0, outputTokens: 0, refusedRequests: 0, allowedInputTokens: 0, allowedOutputTokens: 0 });
const pageOf = (id: string) => id.split("-")[0];

/** Exact text equality, first occurrence retained per project, for projection only. */
export function deduplicateSpanText(spans: Span[]): Span[] {
  const seen = new Set<string>();
  return spans.filter(({ text }) => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

export function duplicateSpanStats(projects: { spans: Span[] }[]) {
  let totalSpans = 0, totalChars = 0, withinPageSpans = 0, withinPageChars = 0;
  let acrossPagesSpans = 0, acrossPagesChars = 0, oncePerProjectSpans = 0, oncePerProjectChars = 0;
  for (const { spans } of projects) {
    const pageSeen = new Map<string, Set<string>>();
    const firstPage = new Map<string, string>();
    for (const s of spans) {
      totalSpans++; totalChars += s.text.length;
      const page = pageOf(s.id);
      const seen = pageSeen.get(page) ?? new Set<string>();
      if (seen.has(s.text)) { withinPageSpans++; withinPageChars += s.text.length; }
      seen.add(s.text); pageSeen.set(page, seen);
      if (firstPage.has(s.text)) {
        oncePerProjectSpans++; oncePerProjectChars += s.text.length;
        if (firstPage.get(s.text) !== page) { acrossPagesSpans++; acrossPagesChars += s.text.length; }
      } else firstPage.set(s.text, page);
    }
  }
  return {
    denominator: { spanOccurrences: totalSpans, textCharacters: totalChars },
    definition: "Within-page counts occurrences after the first equal text on that page; across-pages counts occurrences on a page other than the first project page containing that text. Categories may overlap. Once-per-project is their union; there is no cross-project deduplication.",
    withinPage: { spans: withinPageSpans, characters: withinPageChars, spanShare: withinPageSpans / (totalSpans || 1), characterShare: withinPageChars / (totalChars || 1) },
    acrossProjectPages: { spans: acrossPagesSpans, characters: acrossPagesChars, spanShare: acrossPagesSpans / (totalSpans || 1), characterShare: acrossPagesChars / (totalChars || 1) },
    oncePerProject: { spans: oncePerProjectSpans, characters: oncePerProjectChars, spanShare: oncePerProjectSpans / (totalSpans || 1), characterShare: oncePerProjectChars / (totalChars || 1) },
  };
}

function addRequest(out: Projection, messages: { content: string }[], completion: number) {
  const input = estimateMessagesTokens(messages);
  out.requests++; out.inputTokens += input; out.outputTokens += completion;
  if (input > DEFAULT_TOKEN_CAP) out.refusedRequests++;
  else { out.allowedInputTokens += input; out.allowedOutputTokens += completion; }
}

export function projectCodingCostInputs(projects: { spans: Span[] }[], codebook: Codebook, checkIds: string[], schema: unknown, chunkChars: number, deduplicate: boolean): Projection {
  const out = emptyProjection();
  for (const project of projects) {
    const spans = deduplicate ? deduplicateSpanText(project.spans) : project.spans;
    for (const chunk of chunkSpans(spans, chunkChars)) addRequest(out, buildCodingMessages(checkIds, codebook, schema, chunk), CODING_MAX_TOKENS);
  }
  return out;
}

/** Unknown future citations are bounded by all project spans for each positive. */
export function projectConfirmationUpperInputs(projects: { n: number; spans: Span[] }[], codebook: Codebook, checkIds: string[], deduplicate: boolean, historicalChecks?: Map<number, string[]>): Projection {
  const out = emptyProjection();
  for (const p of projects) for (const checkId of historicalChecks?.get(p.n) ?? (historicalChecks ? [] : checkIds)) {
    addRequest(out, confirmMessages(codebook, { projectN: p.n, checkId, state: "claimed", spans: deduplicate ? deduplicateSpanText(p.spans) : p.spans }), 8192);
  }
  return out;
}

const MODELS = {
  "token-factory": { recode: "deepseek-ai/DeepSeek-V4-Flash-0731", secondCoder: "nvidia/Nemotron-3.5-Super-VL", gold: "zai-org/GLM-5.3-Flash", confirm: "nvidia/Nemotron-3-Ultra-550b-a55b" },
  ollama: { recode: "deepseek-v4.1-flash", secondCoder: "nemotron-3-super", gold: "glm-5.3-flash", confirm: "nemotron-3-ultra" },
};

export function formatCostPlanLine(record: unknown): string { return `COST_PLAN: ${JSON.stringify(record)}`; }

function readPositiveWorkload(file: string): { project_n: number; check_id: string }[] | null {
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT project_n, check_id FROM pipeline_check_states WHERE filtered_state IN ('pass', 'claimed')").all() as { project_n: number; check_id: string }[];
  } finally { db.close(); }
}

export function buildCostPlan({ dataDir = resolveDataDir(), projectsPath = path.join(dataDir, "pipeline", "sample-projects.json"), subsetsPath = path.join(dataDir, "pipeline", "sample-subsets.json") } = {}) {
  const projects: Project[] = JSON.parse(fs.readFileSync(projectsPath, "utf8")).map((p: { n: number; hn_id: string }) => ({ n: p.n, hn_id: p.hn_id, spans: projectSpans(dataDir, p.n) }));
  if (projects.length !== 300) throw new Error("cost-plan requires the full 300-project sample");
  if (projects.some(p => p.spans.some(s => s.text.length > 1500))) throw new Error("cost-plan requires resegmented spans capped at 1500 characters");
  const subsets = JSON.parse(fs.readFileSync(subsetsPath, "utf8"));
  const secondIds = new Set<string>(subsets.secondModel.map(String));
  const second = projects.filter((p) => secondIds.has(String(p.hn_id)));
  if (second.length !== 100) throw new Error("cost-plan requires the seeded 100-project second-coder subset");
  const codebook = loadCodebook();
  const { checkIds } = loadGateFile(resolveGatesPath());
  const { jsonSchema } = buildContract(checkIds);
  const historical = readPositiveWorkload(path.join(dataDir, "backups", "2026-10-21-whole-page-spans", "prism.sqlite"));
  const historicalChecks = historical === null ? undefined : new Map<number, string[]>();
  for (const row of historical ?? []) {
    const checks = historicalChecks!.get(row.project_n) ?? [];
    checks.push(row.check_id); historicalChecks!.set(row.project_n, checks);
  }
  const rows: CostRow[] = [];
  for (const chunkChars of [40_000, 120_000]) for (const deduplicate of [false, true]) {
    const inputs = {
      recode: projectCodingCostInputs(projects, codebook, checkIds, jsonSchema, chunkChars, deduplicate),
      secondCoder: projectCodingCostInputs(second, codebook, checkIds, jsonSchema, chunkChars, deduplicate),
      gold: projectCodingCostInputs(projects, codebook, checkIds, jsonSchema, chunkChars, deduplicate),
      confirm: projectConfirmationUpperInputs(projects, codebook, checkIds, deduplicate),
    };
    for (const [host, models] of Object.entries(MODELS)) {
      const addRow = (role: string, model: string, projection: Projection, workloadBasis?: string) => {
        const hasPrice = !!LIST_PRICES[model];
        rows.push({ host, role, model, projects: role === "secondCoder" ? 100 : 300, chunkChars, deduplicate, ...projection,
          usd: hasPrice ? estimateCostUsd(model, projection.inputTokens, projection.outputTokens) : null,
          allowedUsd: hasPrice ? estimateCostUsd(model, projection.allowedInputTokens, projection.allowedOutputTokens) : null,
          priceStatus: hasPrice ? "known" : "unverified; no substitute silently applied",
          outputBasis: "maximum completion reservation per request; not expected usage; no retry allowance",
          ...(workloadBasis ? { workloadBasis } : {}),
        });
      };
      for (const [role, projection] of Object.entries(inputs)) addRow(role, models[role as keyof typeof models], projection,
        role === "confirm" ? "conservative envelope: every check positive and all project spans cited; future actual positives/citations unknown; chunk size does not split confirmation requests" : undefined);
      if (host === "token-factory") addRow("gold-priced-alternative", "nvidia/Nemotron-3-Ultra-550b-a55b", inputs.gold, "hypothetical priced alternative only; not an approved replacement for pinned GLM");
      if (historicalChecks) addRow("confirm-historical-workload", models.confirm, projectConfirmationUpperInputs(projects, codebook, checkIds, deduplicate, historicalChecks), "archived defective positive project/check counts only; no archived outcomes used as current; all new spans cited as conservative citation envelope");
    }
  }
  return {
    generatedAt: new Date().toISOString(), paidCalls: 0, budgetApproved: false,
    assumptions: {
      tokenEstimator: "sum ceil(message content characters / 4), same as spending guards; not a tokenizer; excludes provider framing and reasoning outside completion limit",
      completionLimits: { recode: CODING_MAX_TOKENS, secondCoder: CODING_MAX_TOKENS, gold: CODING_MAX_TOKENS, confirm: 8192 },
      requestInputTokenCap: DEFAULT_TOKEN_CAP,
      refusedPolicy: "All hypothetical requests included for comparison. allowedUsd excludes requests refused by unchanged input-token cap. 120k chunks are a projection only, not executable approval.",
      models: "Host comparisons use different model IDs and are not availability checks or approved substitutions. Ollama text-only Super is not Super-VL; substitution review is pending. Token Factory GLM price is unverified and null; a separate Ultra alternative is explicitly labelled.",
      confirmation: "Zero current positives after archival does not imply zero future cost. Both all-checks and historical-workload envelopes use all project spans and the longer claimed state prompt. Actual workload requires recoding and citations. No defective labels count as current positives.",
      ollama: { creditUsdPerMonth: 60, accountConcurrentRequests: 3, plannedRoleConcurrency: "1–2", pricingUrl: "https://ollama.com/pricing", billing: "per input/output token against monthly credit; no free calls assumed" },
      mutationPolicy: "Only aggregate report written. Source spans, packing limits, model settings, labels, and decisions unchanged.",
    },
    currentStoredPositiveRows: readPositiveWorkload(path.join(dataDir, "prism.sqlite"))?.length ?? null,
    historicalExploratoryPositiveRows: historical?.length ?? null,
    futurePositiveCount: { min: 0, max: projects.length * checkIds.length, known: false },
    duplicates: duplicateSpanStats(projects),
    pricesUsdPerMillionTokens: Object.fromEntries(Object.entries(LIST_PRICES).map(([model, p]) => [model, { input: p.prompt * 1e6, output: p.completion * 1e6 }])),
    rows,
  };
}

export function main() {
  const dataDir = resolveDataDir();
  const report = buildCostPlan({ dataDir });
  const file = path.join(dataDir, "validation", "cost-plan.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const row of report.rows) console.log(formatCostPlanLine(row));
  console.log(formatCostPlanLine({ kind: "duplicates", ...report.duplicates }));
  console.log(formatCostPlanLine({ kind: "summary", paidCalls: 0, budgetApproved: false, currentStoredPositiveRows: report.currentStoredPositiveRows, historicalExploratoryPositiveRows: report.historicalExploratoryPositiveRows, futurePositiveCount: report.futurePositiveCount, report: file, rows: report.rows.length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
