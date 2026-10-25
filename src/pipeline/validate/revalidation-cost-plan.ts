// Conditional cost projection only; no collection, model request or spending approval.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveDataDir } from "../../app/server/db.ts";
import { buildContract } from "../coding/contract.ts";
import { buildChatBody, PINNED_MODEL } from "../coding/nebius-client.ts";
import { DEFAULT_TOKEN_CAP, estimateCostUsd, reservationInputTokens, type UsageObservation } from "../coding/spend-guards.ts";
import { CODING_MAX_TOKENS } from "../run.ts";

const MODELS = { recode: PINNED_MODEL, gold: "glm-5.3-flash:cloud", "full-confirm": "nemotron-3-ultra:cloud" };
type Role = keyof typeof MODELS;
type StateCount = { check_id: string; filtered_state: string; n: number };
type LedgerState = { cap: number; spent: number; reserved: number; estimated: number };
type Inputs = {
  gate: { sampleNs: number[]; checks: { checkId: string; status: string }[] };
  costPlan: { rows: { role: string; host: string; chunkChars: number; deduplicate: boolean; projects: number; requests: number; inputTokens: number; outputTokens: number }[] };
  ledger: { stages: Record<string, LedgerState> };
  usage: UsageObservation[];
  stateCounts: StateCount[];
  includedCreditUsd?: number;
};
const canonical = (model: string) => model.replace(/:cloud$/, "");
const positive = (row: StateCount) => row.filtered_state === "pass" || row.filtered_state === "claimed";

export function buildRevalidationCostPlan({ gate, costPlan, ledger, usage, stateCounts, includedCreditUsd = 2.4975689 }: Inputs) {
  const missed = gate.checks.filter(c => c.status === "missed").map(c => c.checkId);
  if (gate.sampleNs.length !== 300 || new Set(gate.sampleNs).size !== 300 || !missed.length) throw new Error("projection requires the full sample and its missed checks");
  if (!Number.isFinite(includedCreditUsd) || includedCreditUsd < 0) throw new Error("invalid included-credit estimate");
  const checkIds = gate.checks.map(c => c.checkId);
  const schema = buildContract(checkIds).jsonSchema;
  const summaries = Object.fromEntries((Object.keys(MODELS) as Role[]).map(role => {
    const rows = usage.filter(row => row.stage === role);
    if (!rows.length || rows.some(row => canonical(row.model) !== canonical(MODELS[role]))) throw new Error(`missing or mixed-model usage for ${role}`);
    const measured = rows.filter(row => row.measured && Number.isSafeInteger(row.inputTokens) && Number.isSafeInteger(row.outputTokens) && row.inputTokens! >= 0 && row.outputTokens! >= 0);
    return [role, { model: MODELS[role], requests: rows.length, measuredRequests: measured.length, unmeasuredRequests: rows.length - measured.length, inputTokens: measured.reduce((n, row) => n + row.inputTokens!, 0), outputTokens: measured.reduce((n, row) => n + row.outputTokens!, 0), measuredChargedUsd: measured.reduce((n, row) => n + row.chargedUsd, 0), observedChargedUsd: rows.reduce((n, row) => n + row.chargedUsd, 0) }];
  })) as Record<Role, { model: string; requests: number; measuredRequests: number; unmeasuredRequests: number; inputTokens: number; outputTokens: number; measuredChargedUsd: number; observedChargedUsd: number }>;
  const currentPositiveCount = stateCounts.filter(row => missed.includes(row.check_id) && positive(row)).reduce((n, row) => n + row.n, 0);
  const potentialMaximum = gate.sampleNs.length * missed.length;
  const byCheck = missed.map(checkId => ({ checkId, currentPositives: stateCounts.filter(row => row.check_id === checkId && positive(row)).reduce((n, row) => n + row.n, 0), maximumPossibleChangedPositives: gate.sampleNs.length }));
  const headroom = (stage: string) => Math.max(0, ledger.stages[stage].cap - ledger.stages[stage].spent - ledger.stages[stage].reserved);
  const component = (id: string, role: Role, units: number, baselineUnits: number, condition: string) => {
    const measured = summaries[role];
    const scale = units / baselineUnits;
    const requests = Math.ceil(measured.requests * units / baselineUnits);
    const inputTokens = Math.ceil(measured.inputTokens * units / baselineUnits);
    const outputTokens = Math.ceil(measured.outputTokens * units / baselineUnits);
    const outputLimit = role === "full-confirm" ? 8192 : CODING_MAX_TOKENS;
    const body = buildChatBody({ model: MODELS[role], messages: [{ role: "system", content: "" }, { role: "user", content: "" }], mode: "json_schema", schema: { name: "gate_checks", schema, strict: true }, thinking: role === "full-confirm", ...(role === "gold" ? { reasoningEffort: "low" as const } : {}), maxTokens: outputLimit });
    // ≤4 UTF-16 units per heuristic token; JSON encodes any unit in at most six bytes.
    // The full coding response schema is a conservative allowance for the smaller confirmation schema.
    const maxInputReservationPerRequest = DEFAULT_TOKEN_CAP * 4 * 6 + reservationInputTokens(body);
    const observedExtrapolationUsd = measured.observedChargedUsd * scale;
    const ledgerExtrapolationUsd = ledger.stages[role].spent * scale;
    const uncachedUsd = estimateCostUsd(MODELS[role], inputTokens, outputTokens);
    const recordedUnmeteredAllowanceUsd = Math.max(0, ledger.stages[role].spent - measured.measuredChargedUsd) * scale;
    return { id, host: role === "recode" ? "token-factory" : "ollama", role, model: MODELS[role], units, baselineUnits, condition,
      measuredTokenExtrapolation: { requests, inputTokens, outputTokens, uncachedUsd, recordedUnmeteredAllowanceUsd, uncachedPlusRecordedUnmeteredUsd: uncachedUsd + recordedUnmeteredAllowanceUsd, observedCacheAndRetryExtrapolationUsd: observedExtrapolationUsd, conservativeRecordedSpendExtrapolationUsd: ledgerExtrapolationUsd, usageMissingRequests: measured.unmeasuredRequests, ledgerMinusObservedUsd: ledger.stages[role].spent - measured.observedChargedUsd },
      maximumOutputAtMeasuredInput: { inputTokens, outputTokens: requests * outputLimit, usd: estimateCostUsd(MODELS[role], inputTokens, requests * outputLimit) },
      reservationEnvelope: { modeledRequests: requests, perRequestInputBound: maxInputReservationPerRequest, perRequestOutputLimit: outputLimit, inputReservationTokens: requests * maxInputReservationPerRequest, outputReservationTokens: requests * outputLimit, usd: estimateCostUsd(MODELS[role], requests * maxInputReservationPerRequest, requests * outputLimit), scope: "conservative per-request serialization envelope at the modeled request count, not a guaranteed fresh-project run total" },
    };
  };
  const components = [
    component("fresh-primary", "recode", 76, 300, "mandatory fresh draw: 19 per quarter; full contract"),
    component("fresh-gold", "gold", 76, 300, "mandatory fresh revalidation labels; full contract; no fresh confirmation required"),
    component("reapply-primary", "recode", 300, 300, "only if one or more missed checks pass fresh, estimable revalidation; joint full-contract request cost used conservatively"),
    component("changed-confirm-current-workload", "full-confirm", currentPositiveCount, 1700, "conditional workload scenario: every currently positive state in all missed checks changes its confirmation digest"),
    component("changed-confirm-maximum-workload", "full-confirm", potentialMaximum, 1700, "conditional maximum: all sample projects positive on every missed check; citation lengths and usage still extrapolated"),
  ];
  const baselinePacking = costPlan.rows.find(r => r.host === "token-factory" && r.role === "recode" && r.chunkChars === 40_000 && r.deduplicate);
  if (!baselinePacking || baselinePacking.projects !== 300) throw new Error("missing measured packing-plan baseline");
  const ollamaStages = new Set(["gold", "second-coder", "spike", "full-confirm", "irrelevant-probe"]);
  const cumulativeSpent = Object.entries(ledger.stages).filter(([stage]) => ollamaStages.has(stage)).reduce((n, [, state]) => n + state.spent + state.reserved, 0);
  const existing = { primaryStageHeadroomUsd: headroom("recode"), goldStageHeadroomUsd: headroom("gold"), confirmationStageHeadroomUsd: headroom("full-confirm"), combinedOllamaCapUsd: 10.75, combinedOllamaHeadroomUsd: Math.max(0, 10.75 - cumulativeSpent), approximateIncludedCreditUsd: includedCreditUsd };
  const scenario = (id: string, reapply: boolean, confirm: string | null) => {
    const selected = components.filter(c => c.id === "fresh-primary" || c.id === "fresh-gold" || (reapply && c.id === "reapply-primary") || c.id === confirm);
    const total = (host: string, basis: "uncachedUsd" | "conservativeRecordedSpendExtrapolationUsd") => selected.filter(c => c.host === host).reduce((n, c) => n + c.measuredTokenExtrapolation[basis], 0);
    const tf = total("token-factory", "uncachedUsd"), ollama = total("ollama", "uncachedUsd");
    const ledgerOllama = total("ollama", "conservativeRecordedSpendExtrapolationUsd");
    const unmeteredOllama = selected.filter(c => c.host === "ollama").reduce((n, c) => n + c.measuredTokenExtrapolation.recordedUnmeteredAllowanceUsd, 0);
    return { id, componentIds: selected.map(c => c.id), tokenFactoryUncachedUsd: tf, ollamaUncachedUsd: ollama, ollamaUncachedPlusUnmeteredAllowanceUsd: ollama + unmeteredOllama, tokenFactoryRecordedSpendExtrapolationUsd: total("token-factory", "conservativeRecordedSpendExtrapolationUsd"), ollamaRecordedSpendExtrapolationUsd: ledgerOllama, additionalPrimaryHeadroomNeededUsd: Math.max(0, tf - existing.primaryStageHeadroomUsd), additionalCombinedOllamaHeadroomNeededUsd: Math.max(0, ollama + unmeteredOllama - existing.combinedOllamaHeadroomUsd), likelyIncludedCreditShortfallUsd: Math.max(0, ollama + unmeteredOllama - includedCreditUsd), includedCreditShortfallAtRecordedSpendPatternUsd: Math.max(0, ledgerOllama - includedCreditUsd) };
  };
  return { generatedAt: new Date().toISOString(), paidCalls: 0, freshDrawPerformed: false, collectorCalls: 0, topUpPerformed: false, newSpendAuthorized: false,
    freshProjects: 76, freshPerQuarter: 19, originalProjects: 300, missedChecks: missed, currentPositiveCount, potentialMaximumChangedPositives: potentialMaximum, byCheck,
    assumptions: {
      baseline: "Measured prior 300-project full-contract coding/gold and 1700-positive confirmation usage; no fresh projects drawn or measured. Generalisation to the next 76 is uncertain.",
      preferredEstimate: "Measured token extrapolation priced at uncached installed rates, plus separately shown recorded spend without measured-token support; cache savings are not guaranteed. Observed-charge and recorded-spend extrapolations are separate historical scenarios, not invoices.",
      changedPositives: "Only new or changed state/citation digests on original-sample checks that pass fresh revalidation need confirmation. Actual workload can be zero; existing unchanged decisions remain reusable. Current-positive and maximum-positive scenarios are alternatives, never additive.",
      packing: "Retain 40k-character chunks and send exact-duplicate text once per project. Reapplication is budgeted as one joint full-contract run, not seventeen separate runs; targeted-check packing is not assumed implemented.",
      guidance: "Additional correction guidance tokens and any rule-version change/re-labelling cost are unpriced because the correction is not drafted. A rule change needs its own cost plan and approval.",
      reservations: "Maximum-output figures differ from expected usage. The cap/JSON-serialization envelope includes conservative input reservations but uses an extrapolated request count; fresh page sizes and retries can differ. Actual execution still requires approved hard caps.",
      funding: "Historical stage headroom is informational, not approval for this new branch. The separate per-call evaluation-review approval is not a reusable coding or labelling budget. Approximate included credit is a reported shared balance, not a live account query.",
    }, baselinePacking, usage: summaries, existing, components,
    scenarios: [scenario("fresh-validation-only", false, null), scenario("passed-checks-with-no-changed-positives", true, null), scenario("all-missed-checks-pass-current-positive-workload", true, "changed-confirm-current-workload"), scenario("all-missed-checks-pass-maximum-positive-workload", true, "changed-confirm-maximum-workload")],
  };
}

export function main() {
  const dataDir = resolveDataDir(); const dir = path.join(dataDir, "validation");
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const gate = read("gate-v1.0.json"); const missed = gate.checks.filter((c: { status: string }) => c.status === "missed").map((c: { checkId: string }) => c.checkId);
  const usage = fs.readFileSync(path.join(dir, "approved-usage.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const db = new Database(path.join(dataDir, "prism.sqlite"), { readonly: true, fileMustExist: true });
  let stateCounts: StateCount[];
  try { stateCounts = db.prepare(`SELECT check_id, filtered_state, COUNT(*) AS n FROM pipeline_check_states WHERE project_n IN (${gate.sampleNs.map(() => "?").join(",")}) AND check_id IN (${missed.map(() => "?").join(",")}) GROUP BY check_id, filtered_state`).all(...gate.sampleNs, ...missed) as StateCount[]; } finally { db.close(); }
  const report = buildRevalidationCostPlan({ gate, costPlan: read("cost-plan.json"), ledger: read("approved-budget-2026-10-23.json"), usage, stateCounts });
  fs.writeFileSync(path.join(dir, "revalidation-cost-plan.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const component of report.components) console.log(`REVALIDATION_COST_PLAN: ${JSON.stringify(component)}`);
  console.log(`REVALIDATION_COST_PLAN: ${JSON.stringify({ kind: "summary", missed: missed.length, currentPositiveCount: report.currentPositiveCount, maximumChangedPositives: report.potentialMaximumChangedPositives, paidCalls: 0, existing: report.existing, scenarios: report.scenarios })}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
