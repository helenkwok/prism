// Per-check publication decisions use registered point estimates, never pooled rescue.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { resolveDataDir, getDb } from "../../app/server/db.ts";
import { loadCodebook, type Codebook } from "../coding/codebook-prompt.ts";
import { loadGateFile, resolveGatesPath, type GateFile } from "../coding/contract.ts";
import { PINNED_MODEL } from "../coding/nebius-client.ts";
import { confirmationMatches, effectiveStates, inputDigest, projectSpans, spansDigest, publishedStates } from "../confirm/confirm.ts";
import { ARTCRAFT_HN_ID, GOLD_SEED, SECOND_MODEL_SEED } from "../select/draw-sample.ts";
import { assertA9Signed, a9Section } from "../signoff/a9.ts";
import { agreementByCheck, estimable, type AgreementRow } from "./agreement.ts";
import { loadReleaseProof } from "./release-proof.ts";
import { expandGateReviewBundle } from "./gate-review-bundle.ts";
import { loadFundingFallback, type FundingFallbackOptions } from "./funding-fallback.ts";
import { loadCorrectionApprovalFailures, type CorrectionApprovalFailure } from "./correction-approval-failure.ts";

export const AC1_THRESHOLD = 0.70;
export const PRECISION_THRESHOLD = 0.85;
export const PUBLISHABLE: ReadonlySet<string> = new Set(["released", "released-not-estimable", "corrected-revalidated", "person-coded"]);
const GOLD_MODEL = "glm-5.3-flash:cloud";
const GOLD_LABELLER = `agent:ollama:${GOLD_MODEL}`;
const STATES = new Set(["pass", "fail", "unknown", "claimed"]);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
type Action = { checkId: string; action: string; applied?: boolean; correctionVersion?: string; basis?: string };
type Revalidation = { kind?: string; sampleNs?: number[]; checks?: { checkId: string; goldPasses: number; ac1: number; precision: number | null }[] };
type Manifest = { hnId?: string; snapshotHashesInCollectionOrder: string[]; codingCorrection?: { version: string; checks: string[] } };
export type GateOptions = {
  db: Kysely<any>; dataDir: string; sampleNs: number[]; subsets: { secondModel?: string[]; seeds?: Record<string, string> };
  codebook: Codebook; codebookVersion: string; gateFile: GateFile;
  revalidation?: Revalidation; actions?: { checks: Action[] }; protocolPath?: string;
  screeningAuditAction?: { documentPath: string; signoffPath?: string };
  priorApprovalProofPath?: string;
  fundingFallback?: FundingFallbackOptions;
  correctionApprovalFailures?: CorrectionApprovalFailure[];
};

function within(metrics: { ac1: number; precision: number | null }): boolean {
  return Number.isFinite(metrics.ac1) && metrics.ac1 >= AC1_THRESHOLD && metrics.precision !== null && Number.isFinite(metrics.precision) && metrics.precision >= PRECISION_THRESHOLD;
}
function citationsResolve(row: any, known: Set<string>): boolean {
  try {
    const ids = JSON.parse(row.span_ids_json);
    return Array.isArray(ids) && ids.every(id => typeof id === "string" && known.has(id)) &&
      (row.filtered_state === "unknown" ? ids.length === 0 : ids.length > 0);
  } catch { return false; }
}
function readJson(file: string): any | null { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
function recoveryCutoff(o: GateOptions): number {
  const real = fs.existsSync(o.dataDir) ? fs.realpathSync(o.dataDir) : path.resolve(o.dataDir);
  if (real.split(path.sep).some(p => p === "backups" || p === "2026-10-21-whole-page-spans" || p === "2026-10-21-tavily-142")) throw new Error("archived evidence cannot be evaluated for publication");
  const protocolPath = o.protocolPath ?? path.resolve("protocol/PROTOCOL.md");
  if (o.priorApprovalProofPath) return loadReleaseProof(o.priorApprovalProofPath, protocolPath).recoveryCutoff;
  const signoffPath = path.join(o.dataDir, "decisions", "signoff.jsonl");
  assertA9Signed({ protocolPath, signoffPath });
  const digest = sha(a9Section(fs.readFileSync(protocolPath, "utf8")));
  const records = fs.readFileSync(signoffPath, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s));
  const dates = records.filter(r => r.docDigest === digest && r.decision === "approved").map(r => Date.parse(r.decidedAt));
  if (!dates.length || dates.some(n => !Number.isFinite(n))) throw new Error("recovery sign-off lacks an auditable timestamp");
  return Math.max(...dates);
}

// Explicit whitelists keep quotes, project text, URLs and free-form action prose out of reports.
function figureNumbers(source: any, keys: string[]): Record<string, number | boolean | number[] | null> {
  return Object.fromEntries(keys.filter(k => typeof source?.[k] === "number" || typeof source?.[k] === "boolean" ||
    (Array.isArray(source?.[k]) && source[k].every((n: unknown) => typeof n === "number"))).map(k => [k, source[k]]));
}
function signedDocument(documentPath: string, signoffPath: string, item: string): { binding: { item: string; docDigest: string }; text: string } | null {
  try {
    const text = fs.readFileSync(documentPath, "utf8");
    const docDigest = sha(text);
    const records = fs.readFileSync(signoffPath, "utf8").split("\n").filter(Boolean).map((line, i) => ({ ...JSON.parse(line), order: i }))
      .filter(r => r.item === item && r.docDigest === docDigest)
      .sort((a, b) => String(b.decidedAt ?? "").localeCompare(String(a.decidedAt ?? "")) || b.order - a.order);
    return records[0]?.decision === "approved" ? { binding: { item, docDigest }, text } : null;
  } catch { return null; }
}

function validationSummaries(dataDir: string, companion?: GateOptions["screeningAuditAction"], detached?: ReturnType<typeof loadReleaseProof>) {
  const audit = readJson(path.join(dataDir, "validation", "screening-audit.json"));
  const recall = readJson(path.join(dataDir, "validation", "recall.json"));
  const af = audit?.figure ?? audit;
  const rf = recall?.figure;
  const auditAction = audit?.action;
  const recallAction = recall?.action;
  const binding = detached?.auditApproval ?? (companion ? signedDocument(companion.documentPath, companion.signoffPath ?? path.join(dataDir, "decisions", "signoff.jsonl"), "Screening audit action (A7.10)")?.binding ?? null : null);
  let auditStatus = "missing";
  if (af && af.n === 50 && af.assessable > 0 && Number.isFinite(af.errorRate) && !audit?.stopped) {
    auditStatus = af.errorRate <= .1 ? "within" : "missed";
    // The same-case refit was exploratory and not applied to the sample. It never repairs the raw figure.
    if (auditStatus === "missed" && binding) auditStatus = "selection-limitation";
  }
  let recallStatus = "missing";
  if (rf && rf.acceptanceMet === true && Number.isFinite(rf.recall) && !recall?.stopped) {
    recallStatus = rf.recall >= .7 ? "within" : "missed";
    if (recallStatus === "missed" && recallAction?.kind === "widened-remeasure") {
      if (recallAction.decision === "wording-only" && recall.wording === "not found by the collector") recallStatus = "limitation-applied";
      else if (recallAction.decision === "apply-to-sample" && recallAction.applied === true && recallAction.remeasured?.recall >= .7) recallStatus = "corrected";
    }
  }
  return {
    screeningAudit: { status: auditStatus, figure: figureNumbers(af, ["n", "assessable", "notAssessable", "errors", "errorRate", "wilson95", "bar", "withinThreshold"]), action: binding ? { kind: "tightened-rescreen", publishedStatus: "selection-limitation", exploratoryOnly: true, appliedToSample: false, binding, remeasured: figureNumbers(auditAction?.remeasured, ["errors", "errorRate", "wilson95"]) } : auditAction ? { kind: ["none", "tightened-rescreen"].includes(auditAction.kind) ? auditAction.kind : "unrecognised", remeasured: figureNumbers(auditAction.remeasured, ["errors", "errorRate", "wilson95"]), finalStatus: ["within", "selection-limitation"].includes(auditAction.finalStatus) ? auditAction.finalStatus : null } : null },
    collectionRecall: { status: recallStatus, figure: figureNumbers(rf, ["projects", "contributing", "gatherFailed", "items", "found", "recall", "wilson95", "bar", "withinThreshold", "acceptanceMet", "droppedNonVerbatim"]), action: recallAction ? { kind: ["none", "widened-remeasure"].includes(recallAction.kind) ? recallAction.kind : "unrecognised", remeasured: figureNumbers(recallAction.remeasured, ["recall", "wilson95"]), decision: ["apply-to-sample", "wording-only"].includes(recallAction.decision) ? recallAction.decision : null, applied: recallAction.applied === true } : null, wording: recall?.wording === "not found by the collector" ? recall.wording : null },
  };
}

export async function evaluateGate(o: GateOptions) {
  const cutoff = recoveryCutoff(o);
  const sampleNs = [...new Set(o.sampleNs)].sort((a, b) => a - b);
  if (!sampleNs.length || sampleNs.length !== o.sampleNs.length || sampleNs.some(n => !Number.isInteger(n) || n < 1)) throw new Error("gate requires a unique nonempty sample");
  if (o.codebookVersion !== o.codebook.codebookVersion) throw new Error("codebook version mismatch");
  const checkIds = o.gateFile.checkIds;
  if (!checkIds.length || new Set(checkIds).size !== checkIds.length || checkIds.some(id => !o.codebook.checks[id])) throw new Error("gate check set mismatch");
  const primary = await o.db.selectFrom("pipeline_check_states").selectAll().where("project_n", "in", sampleNs).execute();
  const projects = await o.db.selectFrom("pipeline_project_results").selectAll().where("project_n", "in", sampleNs).execute();
  const goldOutcomes = await o.db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "in", sampleNs).execute();
  const goldLabels = await o.db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "in", sampleNs).execute();
  const second = await o.db.selectFrom("pipeline_second_coder_states").selectAll().where("project_n", "in", sampleNs).execute();
  const edits = await o.db.selectFrom("pipeline_edits").selectAll().where("project_n", "in", sampleNs).execute();
  const flags = await o.db.selectFrom("pipeline_injection_flags").select(["project_n", "span_id"]).where("project_n", "in", sampleNs).execute();
  const confirmations = await o.db.selectFrom("pipeline_confirmations").selectAll().where("project_n", "in", sampleNs).execute();
  const manifests = new Map<number, Manifest>();
  const spans = new Map<number, { id: string; text: string }[]>();
  const included: number[] = [];
  const currentPrimary: number[] = [];
  const a3: number[] = [], missingManifest: number[] = [], missingData: number[] = [];
  const excluded: Record<string, number[]> = { noGold: [], staleGold: [], incompleteGold: [], stalePrimary: [] };
  const pairs: AgreementRow[] = [];
  const secondGold: AgreementRow[] = [], secondPrimary: AgreementRow[] = [];
  const secondIds = new Set((o.subsets.secondModel ?? []).map(String));
  const stateAt = (rows: any[], n: number, id: string) => rows.find(r => r.project_n === n && r.check_id === id);
  for (const n of sampleNs) {
    const record = projects.find(r => r.project_n === n);
    const file = path.join(o.dataDir, "pipeline", "manifests", `${n}.json`);
    const manifest = readJson(file) as Manifest | null;
    if (manifest) manifests.set(n, manifest); else missingManifest.push(n);
    if (record?.missing_data || !record) missingData.push(n);
    if (String(record?.hn_id ?? manifest?.hnId) === ARTCRAFT_HN_ID) { a3.push(n); continue; }
    if (!manifest) { excluded.incompleteGold!.push(n); continue; }
    let currentSpans: { id: string; text: string }[];
    try { currentSpans = projectSpans(o.dataDir, n); } catch { excluded.staleGold!.push(n); continue; }
    spans.set(n, currentSpans);
    const currentDigest = spansDigest(currentSpans);
    const knownIds = new Set(currentSpans.map(s => s.id));
    if (!record || record.model_id !== PINNED_MODEL || record.codebook_version !== o.codebookVersion || Date.parse(record.completed_at) < cutoff || !Number.isFinite(Date.parse(record.completed_at)) ||
        record.snapshot_hashes_json !== JSON.stringify(manifest.snapshotHashesInCollectionOrder) || checkIds.some(id => !STATES.has(stateAt(primary, n, id)?.filtered_state) || !citationsResolve(stateAt(primary, n, id), knownIds))) { excluded.stalePrimary!.push(n); continue; }
    currentPrimary.push(n);
    if (secondIds.has(String(record.hn_id))) for (const checkId of checkIds) {
      const s = stateAt(second, n, checkId);
      if (s && s.model_id?.replace(/:cloud$/, "") === "nemotron-3-super" && !s.coding_all_unknown && STATES.has(s.filtered_state) && citationsResolve(s, knownIds))
        secondPrimary.push({ projectN: n, checkId, a: s.filtered_state, b: stateAt(primary, n, checkId)!.filtered_state });
    }
    const matching = goldOutcomes.filter(r => r.project_n === n && r.codebook_version === o.codebookVersion && r.labeller_id === GOLD_LABELLER);
    const outcome = matching.find(r => r.input_digest === currentDigest && Date.parse(r.decided_at) >= cutoff);
    if (!outcome) { excluded.staleGold!.push(n); continue; }
    if (outcome.outcome !== "labelled") { excluded.noGold!.push(n); continue; }
    const labels = goldLabels.filter(r => r.project_n === n && r.codebook_version === o.codebookVersion && r.labeller_id === GOLD_LABELLER && r.provider === "ollama" && r.model_id === GOLD_MODEL && r.reasoning === "low" && r.input_digest === currentDigest && Date.parse(r.labelled_at) >= cutoff && STATES.has(r.filtered_state) && citationsResolve(r, knownIds));
    if (checkIds.some(id => !stateAt(labels, n, id))) { excluded.incompleteGold!.push(n); continue; }
    included.push(n);
    for (const checkId of checkIds) {
      const a = stateAt(primary, n, checkId)!.filtered_state;
      const b = stateAt(labels, n, checkId)!.filtered_state;
      pairs.push({ projectN: n, checkId, a, b });
      if (secondIds.has(String(record.hn_id))) {
        const s = stateAt(second, n, checkId);
        if (s && s.model_id?.replace(/:cloud$/, "") === "nemotron-3-super" && !s.coding_all_unknown && STATES.has(s.filtered_state) && citationsResolve(s, knownIds)) {
          secondGold.push({ projectN: n, checkId, a: s.filtered_state, b });
        }
      }
    }
  }
  const goldSeed = o.subsets.seeds?.gold ?? GOLD_SEED;
  const secondSeed = o.subsets.seeds?.secondModel ?? SECOND_MODEL_SEED;
  if (goldSeed !== GOLD_SEED || secondSeed !== SECOND_MODEL_SEED) throw new Error("agreement seed differs from registration");
  const primaryFigure = agreementByCheck(pairs, checkIds, goldSeed, 2000);
  const published = await publishedStates(o.db, o.dataDir, o.codebook, included, { allowedModelIds: ["nemotron-3-ultra"] });
  const secondaryPairs = pairs.map(row => ({ ...row, a: published.find(p => p.projectN === row.projectN && p.checkId === row.checkId)?.published ?? "unknown" }));
  const actions = o.actions?.checks ?? [];
  if (actions.some(a => !checkIds.includes(a.checkId)) || (o.revalidation?.checks ?? []).some(c => !checkIds.includes(c.checkId))) throw new Error("action or revalidation contains an unknown check");
  const funding = o.fundingFallback ? loadFundingFallback(o.fundingFallback, o.dataDir, sampleNs, checkIds, actions) : undefined;
  if (!funding && actions.some(a => a.basis === "funding-envelope")) throw new Error("funding fallback evidence is required");
  const approvalFailures = o.correctionApprovalFailures ? loadCorrectionApprovalFailures(o.correctionApprovalFailures, o.dataDir, checkIds, actions, cutoff) : [];
  if (!approvalFailures.length && actions.some(a => a.basis === "correction-approval-failed")) throw new Error("correction approval failure evidence is required");
  const freshNs = o.revalidation?.sampleNs ?? [];
  const freshDraw = readJson(path.join(o.dataDir, "pipeline", "fresh-projects.json"));
  const quarters = Array.isArray(freshDraw) ? [1, 2, 3, 4].map(q => freshDraw.filter(e => freshNs.includes(e.n) && e.quarter === q).length) : null;
  const fresh = freshNs.length === 76 && new Set(freshNs).size === 76 && freshNs.every(n => Number.isInteger(n) && n >= 301 && !sampleNs.includes(n)) &&
    (!quarters || quarters.every(n => n === 19));
  const activeSample = sampleNs.filter(n => !a3.includes(n));
  const personCoverage = (id: string) => activeSample.length > 0 && activeSample.every(n => {
    const candidates = edits.filter(e => e.project_n === n && e.check_id === id).sort((a, b) => String(b.edited_at).localeCompare(String(a.edited_at)));
    const e = candidates[0];
    if (!e || e.actor_kind !== "person" || !e.actor_id || !STATES.has(e.filtered_state) || !Number.isFinite(Date.parse(e.edited_at)) || Date.parse(e.edited_at) < cutoff) return false;
    let ids: string[]; try { ids = JSON.parse(e.span_ids_json); } catch { return false; }
    const known = new Map((spans.get(n) ?? []).map(s => [s.id, s.text]));
    if (!Array.isArray(ids) || ids.some(id => !known.has(id)) || (e.filtered_state !== "unknown" && !ids.length)) return false;
    return e.input_digest === sha(JSON.stringify({ checkId: id, state: e.state, spanIds: ids, spans: ids.map(id => ({ id, text: known.get(id)! })) }));
  });
  const checks = primaryFigure.checks.map(metric => {
    const action = actions.find(a => a.checkId === metric.checkId);
    const candidate = fresh ? o.revalidation?.checks?.find(c => c.checkId === metric.checkId) : undefined;
    const rv = candidate && Number.isInteger(candidate.goldPasses) && candidate.goldPasses >= 0 && candidate.goldPasses <= freshNs.length &&
      Number.isFinite(candidate.ac1) && candidate.ac1 >= -1 && candidate.ac1 <= 1 &&
      (candidate.precision === null || (Number.isFinite(candidate.precision) && candidate.precision >= 0 && candidate.precision <= 1)) ? candidate : undefined;
    const versions = activeSample.map(n => manifests.get(n)?.codingCorrection).filter(c => c?.checks.includes(metric.checkId)).map(c => c!.version);
    const correctionApplied = activeSample.length > 0 && versions.length === activeSample.length && versions.every(v => !!v && v === versions[0] && (!action?.correctionVersion || v === action.correctionVersion));
    let status = metric.n === 0 ? "missed" : !estimable(metric.goldPasses) ? "released-not-estimable" : within(metric) ? "released" : "missed";
    let reason = status === "released-not-estimable" ? "validated by confirmation only; agreement not estimable (fewer than 10 gold passes)" : status === "released" ? "both registered point-estimate thresholds met" : "registered point-estimate threshold missed or no current paired gold";
    const fundingWithheld = funding?.checkIds.includes(metric.checkId) === true;
    const approvalFailure = approvalFailures.find(failure => failure.checkId === metric.checkId);
    if (approvalFailure) {
      if (status !== "missed") throw new Error("correction approval failure may only withhold an originally missed check");
      if (versions.length) throw new Error("a rejected correction must remain unapplied on every scoped project");
      status = "withheld";
      reason = "independent approval of the correction was rejected; correction remains unapplied and the originally missed check is withheld; any fresh metrics remain reported separately";
    }
    else if (fundingWithheld) {
      if (status !== "missed") throw new Error("funding fallback may only withhold a check that missed its original gate");
      status = "withheld";
      reason = `funding envelope prevents ${funding!.step}; withheld under the standing funding directive; any fresh revalidation result remains reported separately`;
    }
    else if (action?.action === "person-coded" && action.applied && personCoverage(metric.checkId)) { status = "person-coded"; reason = "a person coded this check across the full scoped sample on current citations"; }
    else if (rv && (!estimable(rv.goldPasses) || !within(rv)) && action?.action === "withhold" && action.applied) { status = "withheld"; reason = !estimable(rv.goldPasses) ? "fresh revalidation is not estimable; withhold under A7.4" : "the single fresh correction did not pass; withhold under A7.5"; }
    else if (rv && estimable(rv.goldPasses) && within(rv) && correctionApplied) { status = "corrected-revalidated"; reason = "passed estimable fresh revalidation and correction is recorded on every scoped sample manifest"; }
    return { ...metric, status, reason, correctionApplied, ...(approvalFailure ? { approvalFailureEvidenceDigest: approvalFailure.approvalFailureEvidenceDigest } : {}), ...(fundingWithheld ? { fundingDecisionDigest: funding!.decisionDigest } : {}), ...(rv ? { revalidation: { sampleRef: "revalidationSampleNs", checkId: rv.checkId, goldPasses: rv.goldPasses, ac1: rv.ac1, precision: rv.precision } } : {}) };
  });
  const detached = o.priorApprovalProofPath ? loadReleaseProof(o.priorApprovalProofPath, o.protocolPath ?? path.resolve("protocol/PROTOCOL.md")) : undefined;
  const validation = validationSummaries(o.dataDir, o.screeningAuditAction, detached);
  const flaggedProjects = new Set(flags.map(f => f.project_n));
  const injectionDecisions: Record<string, number> = {};
  let invalidFlaggedDecisions = 0;
  const effective = currentPrimary.length ? await effectiveStates(o.db, currentPrimary) : [];
  for (const row of confirmations.filter(r => flaggedProjects.has(r.project_n) && currentPrimary.includes(r.project_n) && Date.parse(r.decided_at) >= cutoff)) {
    const state = effective.find(e => e.projectN === row.project_n && e.checkId === row.check_id);
    if (!state || !["pass", "claimed"].includes(state.filteredState)) continue;
    const ids = state.spanIds;
    const known = new Map((spans.get(row.project_n) ?? []).map(s => [s.id, s.text]));
    const p = { projectN: row.project_n, checkId: row.check_id, state: state.filteredState as "pass" | "claimed", spans: ids.map(id => ({ id, text: known.get(id) ?? "" })), flaggedSpanIds: flags.filter(f => f.project_n === row.project_n).map(f => f.span_id) };
    if (row.input_digest !== inputDigest(o.codebook, p)) continue;
    if (confirmationMatches(row, p, o.codebook, { editActorId: state.editActorId, allowedModelIds: ["nemotron-3-ultra"] })) injectionDecisions[row.decision] = (injectionDecisions[row.decision] ?? 0) + 1;
    else if (ids.some(id => p.flaggedSpanIds.includes(id)) && ["confirmed", "downgraded"].includes(row.decision)) invalidFlaggedDecisions++;
  }
  return {
    generatedAt: new Date().toISOString(), codebookVersion: o.codebookVersion, gateSha: o.gateFile.sha256, sampleNs, revalidationSampleNs: fresh ? freshNs : [],
    ...(funding ? { fundingFallback: funding } : {}),
    ...(approvalFailures.length ? { correctionApprovalFailures: approvalFailures } : {}),
    ...(detached ? { approvalEvidence: { basis: "retained-completion-and-user-attestation", proofDigest: detached.proofDigest, a7Digest: detached.a7Digest, recoveryCutoffUpperBound: new Date(detached.recoveryCutoff).toISOString() } } : {}),
    bootstrap: { resamples: 2000, unit: "projects", primarySeed: goldSeed, secondModelSeed: secondSeed },
    thresholds: { ac1: AC1_THRESHOLD, passPrecision: PRECISION_THRESHOLD, goldPassesForEstimability: 10, basis: "point estimates; pooled results never rescue a check" },
    labeller: { kind: "agent", provider: "ollama", modelId: GOLD_MODEL, reasoning: "low", wording: "agreement with an independent labeller (GLM-5.3)" },
    checks, pooled: primaryFigure.pooled, published: agreementByCheck(secondaryPairs, checkIds, goldSeed, 2000),
    secondModel: { seed: secondSeed, usedAsGate: false, requested: secondIds.size, pairedProjects: new Set(secondGold.map(r => r.projectN)).size, vsGoldProjects: new Set(secondGold.map(r => r.projectN)).size, vsPrimaryProjects: new Set(secondPrimary.map(r => r.projectN)).size, vsGold: agreementByCheck(secondGold, checkIds, secondSeed, 2000), vsPrimary: agreementByCheck(secondPrimary, checkIds, secondSeed, 2000) },
    exclusions: { a3Projects: a3.length, noGoldProjects: excluded.noGold!.length, staleGoldProjects: excluded.staleGold!.length, incompleteGoldProjects: excluded.incompleteGold!.length, stalePrimaryProjects: excluded.stalePrimary!.length, includedProjects: included.length, sampleProjects: sampleNs.length },
    ...validation,
    validationReady: ["within", "corrected", "selection-limitation"].includes(validation.screeningAudit.status) && ["within", "corrected", "limitation-applied"].includes(validation.collectionRecall.status),
    injection: { flaggedProjects: flaggedProjects.size, flaggedSpans: flags.length, currentDecisionCounts: injectionDecisions, invalidFlaggedDecisions },
    collection: { sampleProjects: sampleNs.length, missingManifestProjects: missingManifest.length, missingDataProjects: missingData.length, failedProjects: new Set([...missingManifest, ...missingData]).size, projectNs: [...new Set([...missingManifest, ...missingData])].sort((a, b) => a - b) },
  };
}

export function assertPublishable(gate: { checks: { checkId: string; status: string }[]; validationReady?: boolean }, checkId: string): void {
  const check = gate.checks.find(c => c.checkId === checkId);
  if (!check || !PUBLISHABLE.has(check.status) || gate.validationReady === false) throw new Error(`publication refused for check ${checkId}`);
}

export function loadSignedGate(gatePath: string, signoffPath: string): any | null {
  try {
    const signed = signedDocument(gatePath, signoffPath, "VAL-07 gate record (final)");
    return signed ? expandGateReviewBundle(JSON.parse(signed.text), path.dirname(gatePath), signoffPath) : null;
  } catch { return null; }
}

export function renderGateMarkdown(gate: Awaited<ReturnType<typeof evaluateGate>>): string {
  return ["# Validation gate", "", gate.labeller.wording, "", "Gate: AC1 ≥ 0.70 and pass precision ≥ 0.85 on point estimates.", "", "| Check | N | Gold passes | AC1 | Precision | Status |", "|---|---:|---:|---:|---:|---|", ...gate.checks.map(c => `| ${c.checkId} | ${c.n} | ${c.goldPasses} | ${c.ac1} | ${c.precision ?? "not estimable"} | ${c.status} |`), "", `Audit: ${gate.screeningAudit.status}. Recall: ${gate.collectionRecall.status}.`, `Included projects: ${gate.exclusions.includedProjects}. Collection failures: ${gate.collection.failedProjects}.`, "", "All binary and four-state estimates and project-bootstrap intervals are retained in the accompanying JSON. Second-coder comparisons are descriptive and never gate publication.", ""].join("\n");
}

async function main() {
  const dataDir = resolveDataDir();
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const entries = readJson(path.join(dataDir, "pipeline", "sample-projects.json"));
  const codebook = loadCodebook();
  const db = getDb();
  try {
    const revalidation = value("--revalidation"); const actions = value("--actions"); const screeningAction = value("--screening-audit-action"); const priorApprovalProofPath = value("--prior-approval-proof");
    const gate = await evaluateGate({ db, dataDir, sampleNs: entries.map((e: { n: number }) => e.n), subsets: readJson(path.join(dataDir, "pipeline", "sample-subsets.json")), codebook, codebookVersion: codebook.codebookVersion, gateFile: loadGateFile(resolveGatesPath()), revalidation: revalidation ? readJson(revalidation) : undefined, actions: actions ? readJson(actions) : undefined, screeningAuditAction: screeningAction ? { documentPath: screeningAction } : undefined, priorApprovalProofPath });
    const dir = path.join(dataDir, "validation"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "gate-v1.0.json"), JSON.stringify(gate) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "gate-v1.0.md"), renderGateMarkdown(gate), { mode: 0o600 });
    const count = (status: string) => gate.checks.filter(c => c.status === status).length;
    console.log(`GATE: ${JSON.stringify({ released: count("released"), notEstimable: count("released-not-estimable"), corrected: count("corrected-revalidated"), personCoded: count("person-coded"), missed: count("missed"), withheld: count("withheld"), audit: gate.screeningAudit.status, recall: gate.collectionRecall.status })}`);
  } finally { await db.destroy(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
