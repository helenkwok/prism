import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertTapSuccess, assertCachedConfirmation, assertScreeningAudit, assertRecall, assertExportQuotes, assertGoldOutcome, assertGoldSubset, acceptanceApprovalPaths, acceptanceCorrectionProof, assertInheritedGoldApproval, verifyGoldApproval, runAcceptanceChecks } from "../../src/pipeline/validate/phase4-acceptance.ts";

test("gold scheduling excludes the registered project only when it is actually in the sample", () => {
  assert.doesNotThrow(() => assertGoldSubset(["a", "b"], { goldOrder: ["b", "a"], a3Excluded: [] }, "excluded"));
  assert.doesNotThrow(() => assertGoldSubset(["a", "excluded"], { goldOrder: ["a"], a3Excluded: ["excluded"] }, "excluded"));
  assert.throws(() => assertGoldSubset(["a", "b"], { goldOrder: ["a"], a3Excluded: ["excluded"] }, "excluded"));
  assert.throws(() => assertGoldSubset(["a", "b"], { goldOrder: ["a", "a"], a3Excluded: [] }, "excluded"));
});

test("an empty successful process is not proof that tests passed", () => {
  for (const text of ["", "exit 0", "# pass 0\n# fail 0", "# pass 12\n# fail 1", "not ok 1 - fixture\n# pass 12\n# fail 0"]) assert.throws(() => assertTapSuccess(text));
  assert.doesNotThrow(() => assertTapSuccess("TAP version 13\n# tests 12\n# pass 12\n# fail 0\n"));
});

test("cached confirmation requires current successful decisions and zero model attempts", () => {
  const result = { stage: "full-confirm", total: 2, valid: 2, accounted: 2, cached: 2, attempted: 0, failed: 0, awaitingGold: 0, remaining: 0, stopped: 0, complete: true, ok: true };
  assert.doesNotThrow(() => assertCachedConfirmation(result, 0));
  for (const patch of [{ total: 0, valid: 0 }, { valid: 1 }, { attempted: 1 }, { failed: 1 }, { awaitingGold: 1 }, { complete: false }]) assert.throws(() => assertCachedConfirmation({ ...result, ...patch }, 0));
  assert.throws(() => assertCachedConfirmation(result, 1));
});

test("a durable no-gold outcome is accounted separately and never masquerades as a label", () => {
  assert.doesNotThrow(() => assertGoldOutcome({ outcome: "no-gold", reason: "retry-exhausted" }, [], ["fixture"]));
  assert.doesNotThrow(() => assertGoldOutcome({ outcome: "excluded-a3", reason: "artcraft" }, [], ["fixture"], true));
  assert.throws(() => assertGoldOutcome({ outcome: "no-gold", reason: "retry-exhausted" }, [{ check_id: "fixture" }], ["fixture"]));
  assert.throws(() => assertGoldOutcome(undefined, [], ["fixture"]));
  assert.throws(() => assertGoldOutcome({ outcome: "labelled" }, [], ["fixture"]));
});

const inheritedProof = { a7Digest: "a".repeat(64), proofDigest: "b".repeat(64), recoveryCutoff: Date.parse("2026-10-23T12:00:00Z"), auditApproval: { item: "Screening audit action (A7.10)", decision: "approved", docDigest: "c".repeat(64), decidedAt: "2026-10-21T12:00:00Z", source: "user-verified-signature" } };
test("inherited approval refuses stale and incomplete proof and names its inherited basis", () => {
  const result = assertInheritedGoldApproval(inheritedProof, "a".repeat(64));
  assert.equal(result.basis, "inherited-prior-bulk-verification"); assert.equal(result.proofDigest, inheritedProof.proofDigest);
  for (const patch of [{ a7Digest: "d".repeat(64) }, { proofDigest: "" }, { recoveryCutoff: undefined }, { auditApproval: undefined }, { auditApproval: { ...inheritedProof.auditApproval, decision: "rejected" } }]) assert.throws(() => assertInheritedGoldApproval({ ...inheritedProof, ...patch }, "a".repeat(64)));
});

test("detached approval uses its proof loader and never invokes the legacy signature reader", async () => {
  let loaded = 0; let legacy = 0;
  const dependencies = { loadProof: async () => { loaded++; return inheritedProof; }, legacySigned: async () => { legacy++; throw new Error("legacy signature reader must not run"); } };
  const result = await verifyGoldApproval({ proofPath: "/synthetic/release-approvals.json", expectedA7Digest: "a".repeat(64) }, dependencies);
  assert.equal(result.basis, "inherited-prior-bulk-verification"); assert.equal(loaded, 1); assert.equal(legacy, 0);
  await assert.rejects(verifyGoldApproval({ proofPath: "/synthetic/stale.json", expectedA7Digest: "d".repeat(64) }, dependencies)); assert.equal(legacy, 0);
  await assert.rejects(verifyGoldApproval({ expectedA7Digest: "a".repeat(64) }, { loadProof: dependencies.loadProof, legacySigned: async () => false }), /a7-not-signed/);
});

test("proof mode requires an explicit dedicated signature file without changing default paths", () => {
  const root = "/synthetic/private";
  assert.equal(acceptanceApprovalPaths(root, {}).signoffPath, `${root}/decisions/signoff.jsonl`);
  assert.throws(() => acceptanceApprovalPaths(root, { priorApprovalProofPath: `${root}/validation/release-approvals.json` }));
  assert.throws(() => acceptanceApprovalPaths(root, { priorApprovalProofPath: `${root}/validation/release-approvals.json`, signoffPath: `${root}/decisions/signoff.jsonl` }));
  assert.equal(acceptanceApprovalPaths(root, { priorApprovalProofPath: `${root}/validation/release-approvals.json`, signoffPath: `${root}/decisions/release-signoff.jsonl` }).signoffPath, `${root}/decisions/release-signoff.jsonl`);
});

test("screening audit preserves drawn and eligible denominators and rejects missing records/actions", () => {
  const audit = { n: 50, assessable: 41, notAssessable: 9, errors: 2, errorRate: 2 / 41, withinThreshold: true, stopped: false, auditIds: Array.from({ length: 50 }, (_, i) => String(i)), records: Array.from({ length: 50 }, (_, i) => ({ id: String(i), assessable: i < 41, auditorInclude: i < 2 })), action: { kind: "none" } };
  const drawn = Array.from({ length: 50 }, (_, i) => String(i));
  assert.deepEqual(assertScreeningAudit(audit, drawn), { drawn: 50, eligible: 41, assessable: 41, notAssessable: 9 });
  for (const patch of [{ action: undefined }, { records: [] }, { n: 41 }, { stopped: true }]) assert.throws(() => assertScreeningAudit({ ...audit, ...patch }, drawn));
  const missed = { ...audit, errors: 5, errorRate: 5 / 41, withinThreshold: false, records: audit.records.map((row, i) => ({ ...row, auditorInclude: i < 5 })), action: { kind: "tightened-rescreen", finalStatus: "within" } };
  assert.throws(() => assertScreeningAudit(missed, drawn));
  assert.doesNotThrow(() => assertScreeningAudit({ ...missed, publicationStatus: "selection-limitation" }, drawn));
});

test("schema-shaped export quotes still fail unless they match exact current span text", () => {
  const spans = new Map([["p1-s001", "Synthetic evidence."]]); const record = { spanIds: ["p1-s001"], quotes: [{ spanId: "p1-s001", text: "Synthetic evidence." }] };
  assert.doesNotThrow(() => assertExportQuotes(record, spans));
  for (const patch of [{ quotes: [{ spanId: "p1-s001", text: "Changed evidence." }] }, { spanIds: ["missing"] }, { quotes: [] }]) assert.throws(() => assertExportQuotes({ ...record, ...patch }, spans));
});

test("collection recall requires a complete measured figure and its applied action", () => {
  const recall = { figure: { projects: 10, contributing: 9, gatherFailed: 1, items: 20, found: 18, recall: .9, acceptanceMet: true, withinThreshold: true }, records: Array.from({ length: 10 }, (_, i) => ({ projectN: i + 1 })), action: { kind: "none" }, wording: null, stopped: false };
  assert.doesNotThrow(() => assertRecall(recall));
  for (const patch of [{ action: undefined }, { wording: undefined }, { stopped: true }, { figure: { ...recall.figure, contributing: 7, acceptanceMet: false } }]) assert.throws(() => assertRecall({ ...recall, ...patch }));
});

test("all eleven checks execute after failures and nothing implicitly counts as a pass", async () => {
  const called = []; const lines = [];
  const checks = Array.from({ length: 11 }, (_, i) => ({ id: `C${i + 1}`, run: async () => { called.push(i); if (i === 1) throw new Error("fixture failure"); return i !== 0; } }));
  const result = await runAcceptanceChecks(checks, line => lines.push(line));
  assert.equal(called.length, 11); assert.equal(result.passed, 9); assert.equal(result.failed, 2); assert.equal(result.ok, false); assert.equal(lines.filter(line => line.startsWith("FAIL ")).length, 2);
  const undefinedRun = [...checks]; undefinedRun[0] = { id: "C1", run: async () => undefined };
  assert.equal((await runAcceptanceChecks(undefinedRun, () => {})).failed, 2);
});

test("cached confirmation forwards retained correction evidence only with detached approval", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-acceptance-proof-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "validation"));
  const protocol = path.join(dataDir, "PROTOCOL.md"), prior = path.join(dataDir, "validation/release-approvals.json");
  assert.equal(acceptanceCorrectionProof(dataDir, protocol, prior), undefined);
  const config = path.join(dataDir, "validation/revalidation-proof.json");
  fs.writeFileSync(config, "invalid retained configuration");
  assert.throws(() => acceptanceCorrectionProof(dataDir, protocol), /detached-prior-approval/);
  assert.deepEqual(acceptanceCorrectionProof(dataDir, protocol, prior), { priorApprovalProofPath: prior, protocolPath: protocol, revalidationProofPath: config });
  fs.unlinkSync(config); fs.symlinkSync(path.join(dataDir, "absent.json"), config);
  assert.throws(() => acceptanceCorrectionProof(dataDir, protocol), /detached-prior-approval/);
});
