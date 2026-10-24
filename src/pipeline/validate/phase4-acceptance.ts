import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function requireEvidence(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const printed = (text: string, prefix: string) => text.split("\n").filter(line => line.startsWith(prefix)).flatMap(line => { try { return [JSON.parse(line.slice(prefix.length))]; } catch { return []; } });

export function assertTapSuccess(text: string): void {
  const passes = [...text.matchAll(/^# pass (\d+)\s*$/gm)].at(-1);
  const failures = [...text.matchAll(/^# fail (\d+)\s*$/gm)].at(-1);
  requireEvidence(passes && Number(passes[1]) > 0 && failures && Number(failures[1]) === 0 && !/^\s*not ok\b/m.test(text), "test-output-not-successful");
}

export function assertCachedConfirmation(result: any, requests: number): void {
  requireEvidence(requests === 0 && result?.stage === "full-confirm" && integer(result.total) && result.total > 0 && result.valid === result.total && result.accounted === result.total && result.cached === result.total && result.attempted === 0 && result.failed === 0 && result.awaitingGold === 0 && result.remaining === 0 && result.stopped === 0 && result.complete === true && result.ok === true, "confirmation-not-fully-cached");
}

export function assertScreeningAudit(audit: any, drawn: string[]) {
  requireEvidence(Array.isArray(drawn) && drawn.length === 50 && new Set(drawn).size === 50 && audit?.stopped === false && integer(audit.n) && audit.n === 50 && integer(audit.assessable) && integer(audit.notAssessable) && audit.assessable + audit.notAssessable === audit.n && audit.assessable > 0 && Array.isArray(audit.records) && audit.records.length === audit.n && Array.isArray(audit.auditIds) && audit.auditIds.length === audit.n, "audit-denominator-incomplete");
  const ids = new Set(audit.records.map((row: any) => row.id));
  requireEvidence(ids.size === 50 && audit.records.every((row: any) => drawn.includes(row.id)) && audit.auditIds.every((id: string) => ids.has(id)) && audit.records.filter((row: any) => row.assessable === true).length === audit.assessable && integer(audit.errors) && audit.errors === audit.records.filter((row: any) => row.assessable === true && row.auditorInclude === true).length && Math.abs(audit.errorRate - audit.errors / audit.assessable) < 1e-12 && audit.withinThreshold === (audit.errorRate <= .1), "audit-figure-inconsistent");
  requireEvidence(audit.action && typeof audit.action.kind === "string" && (audit.withinThreshold ? audit.action.kind === "none" : audit.publicationStatus === "selection-limitation" || audit.action.kind === "selection-limitation" || audit.action.finalStatus === "selection-limitation"), "audit-action-not-applied");
  return { drawn: audit.n, eligible: audit.assessable, assessable: audit.assessable, notAssessable: audit.notAssessable };
}

export function assertRecall(recall: any): void {
  const f = recall?.figure;
  requireEvidence(recall?.stopped === false && f && integer(f.projects) && f.projects === 10 && integer(f.contributing) && f.contributing >= 8 && f.contributing <= f.projects && integer(f.gatherFailed) && f.gatherFailed <= f.projects && integer(f.items) && f.items > 0 && integer(f.found) && f.found <= f.items && Math.abs(f.recall - f.found / f.items) < 1e-12 && f.acceptanceMet === true && f.withinThreshold === (f.recall >= .7) && Array.isArray(recall.records) && recall.records.length === f.projects && Object.hasOwn(recall, "wording") && recall.wording !== undefined && recall.action && typeof recall.action.kind === "string", "recall-evidence-incomplete");
  requireEvidence(f.withinThreshold ? recall.action.kind === "none" : recall.action.kind === "widened-remeasure" && (recall.action.decision === "apply-to-sample" || recall.action.decision === "wording-only" && typeof recall.wording === "string"), "recall-action-not-applied");
}

export function assertExportQuotes(record: any, spans: Map<string, string>): void {
  requireEvidence(Array.isArray(record.spanIds) && Array.isArray(record.quotes) && record.quotes.length === record.spanIds.length && record.spanIds.every((id: string, i: number) => typeof id === "string" && spans.has(id) && record.quotes[i]?.spanId === id && record.quotes[i]?.text === spans.get(id)), "export-quote-not-exact");
}

export function assertGoldOutcome(outcome: any, labels: { check_id: string }[], checkIds: string[], excluded = false): void {
  requireEvidence(outcome && (excluded ? ["excluded-a3", "no-gold"] : ["labelled", "no-gold"]).includes(outcome.outcome), "gold-outcome-missing");
  if (outcome.outcome === "labelled") requireEvidence(labels.length === checkIds.length && new Set(labels.map(row => row.check_id)).size === checkIds.length && checkIds.every(id => labels.some(row => row.check_id === id)), "gold-checks-incomplete");
  else requireEvidence(labels.length === 0 && (outcome.outcome !== "no-gold" || typeof outcome.reason === "string" && outcome.reason.length > 0), "no-gold-outcome-has-labels");
}

export function acceptanceApprovalPaths(dataDir: string, { priorApprovalProofPath, signoffPath }: { priorApprovalProofPath?: string; signoffPath?: string }) {
  const legacy = path.resolve(dataDir, "decisions", "signoff.jsonl");
  const selected = path.resolve(signoffPath ?? legacy);
  requireEvidence(!priorApprovalProofPath || signoffPath && selected !== legacy, "detached-proof-requires-dedicated-signoff-file");
  return { priorApprovalProofPath: priorApprovalProofPath ? path.resolve(priorApprovalProofPath) : undefined, signoffPath: selected };
}

export function assertInheritedGoldApproval(proof: any, a7Digest: string) {
  requireEvidence(/^[a-f0-9]{64}$/.test(a7Digest) && proof?.a7Digest === a7Digest && /^[a-f0-9]{64}$/.test(proof.proofDigest) && Number.isFinite(proof.recoveryCutoff) && proof.recoveryCutoff > 0 && proof.auditApproval?.item === "Screening audit action (A7.10)" && proof.auditApproval.decision === "approved" && proof.auditApproval.source === "user-verified-signature" && /^[a-f0-9]{64}$/.test(proof.auditApproval.docDigest) && typeof proof.auditApproval.decidedAt === "string" && Number.isFinite(Date.parse(proof.auditApproval.decidedAt)), "inherited-gold-approval-stale-or-incomplete");
  return { basis: "inherited-prior-bulk-verification", proofDigest: proof.proofDigest, a7Digest, recoveryCutoff: proof.recoveryCutoff };
}

export async function verifyGoldApproval({ proofPath, expectedA7Digest }: { proofPath?: string; expectedA7Digest: string }, { loadProof, legacySigned }: { loadProof: (file: string) => unknown | Promise<unknown>; legacySigned: () => boolean | Promise<boolean> }) {
  if (proofPath) return assertInheritedGoldApproval(await loadProof(proofPath), expectedA7Digest);
  requireEvidence(await legacySigned(), "a7-not-signed");
  return { basis: "current-signoff-file", a7Digest: expectedA7Digest };
}

export async function runAcceptanceChecks(checks: { id: string; run: () => unknown | Promise<unknown> }[], log: (line: string) => void) {
  requireEvidence(checks.length === 11 && checks.every((check, i) => check.id === `C${i + 1}`), "eleven-checks-required");
  let passed = 0; let failed = 0;
  for (const check of checks) {
    let ok = false;
    try { ok = await check.run() === true; } catch { /* Individual failures never bypass later checks. */ }
    if (ok) passed++; else failed++;
    log(`${ok ? "PASS" : "FAIL"} ${check.id}`);
  }
  return { passed, failed, ok: passed === 11 && failed === 0 };
}

export async function runPhase4Acceptance({ dataDir, repoRoot = process.cwd(), log = console.log, priorApprovalProofPath, signoffPath: requestedSignoffPath }: { dataDir: string; repoRoot?: string; log?: (line: string) => void; priorApprovalProofPath?: string; signoffPath?: string }) {
  const { getDb } = await import("../../app/server/db.ts");
  const { loadCodebook } = await import("../coding/codebook-prompt.ts");
  const { ARTCRAFT_HN_ID, GOLD_SEED } = await import("../select/draw-sample.ts");
  const { sortPilotCandidates } = await import("../select/pilot-draw.ts");
  const { a7Signed, a7Section } = await import("./gold.ts");
  const { projectSpans, spansDigest } = await import("../confirm/confirm.ts");
  const { ROLE_CONFIG } = await import("./providers.ts");
  const { DollarBudget } = await import("../coding/spend-guards.ts");
  const { APPROVED_CAPS } = await import("./approved-budget.ts");
  const validation = path.join(dataDir, "validation");
  const sampleFile = path.join(dataDir, "pipeline", "sample-projects.json");
  const subsetFile = path.join(dataDir, "pipeline", "sample-subsets.json");
  const approvalPaths = acceptanceApprovalPaths(dataDir, { priorApprovalProofPath, signoffPath: requestedSignoffPath });
  const signoffPath = approvalPaths.signoffPath;
  if (approvalPaths.priorApprovalProofPath && fs.existsSync(signoffPath)) requireEvidence(fs.realpathSync(signoffPath) !== path.resolve(dataDir, "decisions", "signoff.jsonl"), "detached-proof-refuses-production-signoff-file");
  const protocolPath = path.join(repoRoot, "protocol", "PROTOCOL.md");
  const a7Digest = crypto.createHash("sha256").update(a7Section(fs.readFileSync(protocolPath, "utf8"))).digest("hex");
  const inheritedProof = async (file: string) => { const modulePath = "./release-proof.ts"; const mod = await import(modulePath); return mod.loadReleaseProof(file, protocolPath); };
  const gatePath = path.join(validation, "gate-v1.0.json");
  const sample = () => readJson(sampleFile) as { n: number; hn_id: string; quarter: number }[];
  const subsets = () => readJson(subsetFile);
  const db = getDb(); const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
  const gateModule = async () => { const modulePath = "./gate.ts"; return await import(modulePath); };
  const signedGate = async () => {
    const mod = await gateModule(); const gate = await mod.loadSignedGate(gatePath, signoffPath);
    requireEvidence(gate, "gate-not-signed");
    if (approvalPaths.priorApprovalProofPath) { const inherited = assertInheritedGoldApproval(await inheritedProof(approvalPaths.priorApprovalProofPath), a7Digest); requireEvidence(gate.approvalEvidence?.proofDigest === inherited.proofDigest && gate.approvalEvidence.a7Digest === inherited.a7Digest, "gate-detached-approval-mismatch"); }
    return { mod, gate };
  };
  const tests = (files: string[]) => {
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
    log(result.stdout ?? ""); log(result.stderr ?? ""); assertTapSuccess(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  };
  const checks = [
    { id: "C1", run: async () => {
      const entries = sample(); const s = subsets(); const ids = entries.map(e => String(e.hn_id));
      requireEvidence(entries.length === 300 && new Set(entries.map(e => e.n)).size === 300 && new Set(ids).size === 300 && entries.every(e => Number.isSafeInteger(e.n) && e.n >= 1 && e.n <= 300) && [1, 2, 3, 4].every(q => entries.filter(e => e.quarter === q).length === 75), "sample-not-stratified-300");
      requireEvidence(s.goldOrder?.length === 299 && !s.goldOrder.includes(ARTCRAFT_HN_ID) && s.a3Excluded?.length === 1 && s.a3Excluded[0] === ARTCRAFT_HN_ID && s.secondModel?.length === 100 && s.recall?.length === 10 && s.audit?.length === 50, "subset-sizes-incomplete");
      for (const list of [s.goldOrder, s.secondModel, s.recall]) requireEvidence(new Set(list.map(String)).size === list.length && list.every((id: unknown) => ids.includes(String(id))), "subset-outside-sample");
      const { prismaCounts } = await import("../select/draw.ts"); const counts = prismaCounts(readJson(path.join(dataDir, "pipeline", "sample-screening-log.json")).log);
      requireEvidence(counts.included + counts["included-insufficient-text"] === 300, "sampling-log-mismatch"); log(`PRISMA: ${JSON.stringify(counts)}`); return true;
    } },
    { id: "C2", run: async () => {
      const entries = sample(); const rows = await db.selectFrom("pipeline_project_results").select("project_n").where("project_n", "in", entries.map(e => e.n)).execute();
      requireEvidence(rows.filter(row => fs.existsSync(path.join(dataDir, "pipeline", "manifests", `${row.project_n}.json`))).length >= 290, "coding-coverage-insufficient");
      const secondary = await db.selectFrom("pipeline_second_coder_states").select("project_n").distinct().where("project_n", "in", entries.map(e => e.n)).execute(); const allowed = new Set(subsets().secondModel.map(String)); const hn = new Map(entries.map(e => [e.n, String(e.hn_id)]));
      requireEvidence(secondary.length <= 100 && secondary.every(row => allowed.has(hn.get(row.project_n)!)), "second-coder-outside-seeded-subset"); return true;
    } },
    { id: "C3", run: async () => {
      const approval = await verifyGoldApproval({ proofPath: approvalPaths.priorApprovalProofPath, expectedA7Digest: a7Digest }, { loadProof: inheritedProof, legacySigned: () => a7Signed({ protocolPath, signoffPath }) }); log(`GOLD_APPROVAL: ${JSON.stringify(approval)}`);
      const rows = await db.selectFrom("pipeline_gold_outcomes").selectAll().where("codebook_version", "=", codebook.codebookVersion).execute(); const labels = await db.selectFrom("pipeline_gold_labels").select(["project_n", "labeller_id", "labeller_kind", "provider", "input_digest", "model_id", "check_id"]).where("codebook_version", "=", codebook.codebookVersion).execute(); let counted = 0; let labelled = 0; let noGold = 0; let excludedA3 = 0;
      for (const e of sample()) {
        if (!fs.existsSync(path.join(dataDir, "pipeline", "manifests", `${e.n}.json`))) continue;
        counted++; const excluded = String(e.hn_id) === ARTCRAFT_HN_ID; const digest = spansDigest(excluded ? [] : projectSpans(dataDir, e.n));
        const outcome = rows.find(row => row.project_n === e.n && row.input_digest === digest && (excluded ? ["excluded-a3", "no-gold"] : ["labelled", "no-gold"]).includes(row.outcome) && String(row.labeller_id).replace(/:cloud$/, "") === `agent:${ROLE_CONFIG.gold.provider}:${ROLE_CONFIG.gold.model.replace(/:cloud$/, "")}`);
        requireEvidence(outcome, "gold-outcome-missing");
        const currentLabels = labels.filter(row => row.project_n === e.n && row.input_digest === digest && row.labeller_id === outcome.labeller_id);
        assertGoldOutcome(outcome, currentLabels, Object.keys(codebook.checks), excluded);
        requireEvidence(currentLabels.every(row => row.labeller_kind === "agent" && row.provider === ROLE_CONFIG.gold.provider && String(row.model_id).replace(/:cloud$/, "") === ROLE_CONFIG.gold.model.replace(/:cloud$/, "")), "gold-role-mismatch");
        if (outcome.outcome === "labelled") labelled++; else if (outcome.outcome === "no-gold") noGold++; else excludedA3++;
      }
      requireEvidence(counted > 0, "gold-projects-empty"); log(`GOLD: ${JSON.stringify({ projects: counted, labelled, noGold, excludedA3, complete: true })}`); return true;
    } },
    { id: "C4", run: async () => {
      const entries = sample(); const review = readJson(path.join(validation, "confirmation-spike-review.json")); const lines: string[] = []; let requests = 0;
      const { runApprovedConfirmation } = await import("./approved-confirm.ts");
      const result = await runApprovedConfirmation({ db, dataDir, codebook, entries, model: review.model, reasoning: review.selectedSetting, goldOrder: sortPilotCandidates(entries.map(e => ({ id: String(e.hn_id) })), GOLD_SEED).map(e => e.id), client: { dollarBudget: new DollarBudget(APPROVED_CAPS["full-confirm"]), request: async () => { requests++; throw new Error("offline-acceptance-refuses-model-call"); } }, log: line => lines.push(line) });
      for (const line of lines) log(line); assertCachedConfirmation(result, requests);
      const { loadProbeInput, projectProbe, assertProbeApproval } = await import("./live-probe.ts");
      const p = loadProbeInput(dataDir, path.join(validation, "irrelevant-citation-probe-input.json")); const plan = projectProbe(codebook, p); const approval = readJson(path.join(validation, "irrelevant-citation-cost-plan.json")); assertProbeApproval(plan, approval);
      const retained = readJson(path.join(validation, "irrelevant-citation-probe.json")); const probeLog = fs.readFileSync(path.join(validation, "approved-irrelevant-probe.log"), "utf8"); const ledger = readJson(path.join(validation, "approved-budget-2026-10-23.json")).stages?.["irrelevant-probe"];
      requireEvidence(retained.requestDigest === plan.requestDigest && retained.complete === true && retained.genuine === true && retained.ownSource === true && retained.decision === "rejected" && retained.spentUsd >= 0 && retained.spentUsd <= 1 && ledger?.spent === retained.spentUsd && ledger.reserved <= 1e-9 && ledger.cap === 1, "probe-evidence-missing");
      requireEvidence(printed(probeLog, "PROBE: ").some(row => row.decision === "rejected" && row.genuine === true && row.ownSource === true && row.complete === true) && printed(probeLog, "ACCOUNTING: ").some(row => row.stage === "irrelevant-probe" && row.total === 1 && row.valid === 1 && row.failed === 0 && row.complete === true) && printed(probeLog, "BUDGET: ").some(row => row.cap === 1 && row.spent === retained.spentUsd), "printed-probe-evidence-missing");
      log(`PROBE: ${JSON.stringify({ decision: "rejected", genuine: true, ownSource: true, cached: true, complete: true, requestDigest: plan.requestDigest })}`); return true;
    } },
    { id: "C5", run: async () => { tests(["tests/pipeline/review-trail.test.mjs", "tests/review-route.test.mjs"]); return true; } },
    { id: "C6", run: async () => {
      const audit = readJson(path.join(validation, "screening-audit.json")); const { gate } = await signedGate();
      requireEvidence(gate.screeningAudit?.figure?.errorRate === audit.errorRate && gate.screeningAudit.figure.n === audit.n && gate.screeningAudit.figure.assessable === audit.assessable, "gate-audit-figure-changed");
      const evidence = assertScreeningAudit({ ...audit, action: audit.action ?? gate.screeningAudit?.action, publicationStatus: gate.screeningAudit?.status }, subsets().audit);
      log(`AUDIT: ${JSON.stringify({ ...evidence, errors: audit.errors, errorRate: audit.errorRate, withinThreshold: audit.withinThreshold, action: gate.screeningAudit?.action?.kind ?? audit.action?.kind })}`); return true;
    } },
    { id: "C7", run: async () => { const recall = readJson(path.join(validation, "recall.json")); assertRecall(recall); const { gate } = await signedGate(); requireEvidence(gate.collectionRecall?.figure?.recall === recall.figure.recall, "gate-recall-figure-changed"); log(`RECALL: ${JSON.stringify({ projects: recall.figure.projects, contributing: recall.figure.contributing, recall: recall.figure.recall, action: recall.action.kind })}`); return true; } },
    { id: "C8", run: async () => {
      const { mod, gate } = await signedGate(); const ids = Object.keys(codebook.checks);
      requireEvidence(Array.isArray(gate.checks) && gate.checks.length === 24 && new Set(gate.checks.map((c: any) => c.checkId)).size === 24 && ids.every(id => gate.checks.some((c: any) => c.checkId === id)) && ["secondModel", "screeningAudit", "collectionRecall", "injection", "collection"].every(key => gate[key]), "gate-record-incomplete");
      let publishable = 0; let withheld = 0;
      for (const check of gate.checks) { requireEvidence(check.status !== "missed", "gate-still-missed"); let released = true; try { mod.assertPublishable(gate, check.checkId); } catch { released = false; } if (check.status === "withheld") { requireEvidence(!released, "withheld-check-publishable"); withheld++; } else { requireEvidence(released, "released-check-refused"); publishable++; } }
      log(`GATE: ${JSON.stringify({ publishable, withheld, signed: true })}`); return true;
    } },
    { id: "C9", run: async () => {
      const { exportLabelled } = await import("./export-labelled.ts"); const result = await exportLabelled({ db, dataDir, sampleNs: sample().map(e => e.n), codebookVersion: codebook.codebookVersion });
      const { default: Ajv2020 } = await import("ajv/dist/2020.js"); const { default: addFormats } = await import("ajv-formats"); const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv); const validate = ajv.compile(readJson(path.join(repoRoot, "protocol", "labelled-dataset.schema.json")));
      const rows = fs.readFileSync(result.path, "utf8").split("\n").filter(Boolean); requireEvidence(rows.length > 0 && rows.length === result.confirmation + result.gold + result.edit && (fs.statSync(result.path).mode & 0o777) === 0o600, "labelled-export-not-valid");
      const ns = new Set(sample().map(e => e.n)); const spans = new Map<number, Map<string, string>>();
      for (const line of rows) { const record = JSON.parse(line); const schemaValid = Boolean(validate(record)); requireEvidence(schemaValid && ns.has(record.projectN), "labelled-export-not-valid"); if (!spans.has(record.projectN)) spans.set(record.projectN, new Map(projectSpans(dataDir, record.projectN).map(s => [s.id, s.text]))); assertExportQuotes(record, spans.get(record.projectN)!); }
      log(`EXPORT: ${JSON.stringify(result)}`); return true;
    } },
    { id: "C10", run: async () => {
      const protocol = await import("../../../scripts/check-protocol-order.mjs"); const book = await import("../../../scripts/check-codebook-order.mjs"); const names = await import("../../../scripts/check-agent-names.mjs"); const paths = await import("../../../scripts/check-forbidden-paths.mjs"); const spikes = await import("../../../scripts/check-spike-records.mjs");
      for (const guard of [protocol, book]) { const result = guard.checkOrder({ requireTag: true }); requireEvidence(result.problems.length === 0 && result.tagPending === false, "ordering-guard-failed"); }
      requireEvidence(names.scanTrackedFiles().length === 0 && names.scanCommits().length === 0 && names.scanTags().length === 0 && paths.checkPaths(paths.trackedPaths()).length === 0 && spikes.lintDir(path.join(repoRoot, "spikes")).length === 0, "repository-guard-failed"); log("GUARDS: all required structured results are clean"); return true;
    } },
    { id: "C11", run: async () => { tests(["tests/**/*.test.mjs"]); return true; } },
  ];
  try { const result = await runAcceptanceChecks(checks, log); log(result.ok ? "ACCEPTANCE-OK" : "ACCEPTANCE-FAILED"); return result; }
  finally { await db.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  globalThis.fetch = async () => { throw new Error("offline acceptance prohibits network calls"); };
  try { const { resolveDataDir } = await import("../../app/server/db.ts"); const args = process.argv.slice(2); const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; requireEvidence(args[i + 1], "missing-acceptance-option"); return args[i + 1]; }; const result = await runPhase4Acceptance({ dataDir: resolveDataDir(), priorApprovalProofPath: option("--prior-approval-proof"), signoffPath: option("--signoff") }); process.exitCode = result.ok ? 0 : 1; }
  catch { for (let i = 1; i <= 11; i++) console.log(`FAIL C${i}`); console.log("ACCEPTANCE-FAILED"); process.exitCode = 1; }
}
