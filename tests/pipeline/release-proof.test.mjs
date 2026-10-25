import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadReleaseProof } from "../../src/pipeline/validate/release-proof.ts";
import { a7Section } from "../../src/pipeline/validate/gold.ts";
import { a9Section, A9_ITEMS } from "../../src/pipeline/signoff/a9.ts";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const cutoff = "2026-10-23T02:00:30.401Z";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-release-proof-"));
  for (const dir of ["validation", "decisions"]) fs.mkdirSync(path.join(dataDir, dir));
  const protocolPath = path.join(dataDir, "PROTOCOL.md");
  const protocol = "# Synthetic protocol\n\n## Addendum 2026-10-20 (A7)\n\nSynthetic rules.\n\n## Addendum 2026-10-21 (A9)\n\nSynthetic recovery rules.\n";
  fs.writeFileSync(protocolPath, protocol);
  const a7 = a7Section(protocol); const a9Digest = sha(a9Section(protocol));
  const a7Path = "decisions/a7.md"; fs.writeFileSync(path.join(dataDir, a7Path), a7);
  const logPath = "validation/approved-signoff.log";
  const log = A9_ITEMS.map(item => `SIGNOFF: ${JSON.stringify({ item, decision: "approved", digest: a9Digest })}`).join("\n") + '\nACCOUNTING: {"stage":"signoff","total":6,"success":6,"ok":true,"complete":true}\n';
  fs.writeFileSync(path.join(dataDir, logPath), log); fs.utimesSync(path.join(dataDir, logPath), new Date(cutoff), new Date(cutoff));
  const bulkPath = "validation/04-05b-final-verification.json";
  const bulk = { priorStages: [
    { stage: "signoff", total: 6, success: 6, ok: true, complete: true },
    { stage: "recode", total: 300, accounted: 300, success: 300, failed: 0, stopped: 0, ok: true, complete: true },
    { stage: "gold", total: 300, accounted: 300, success: 299, labelled: 299, noGold: 1, failed: 1, stopped: 0, ok: true, complete: true, allDecisionsValid: false },
  ], fullConfirmation: { total: 1700, accounted: 1700, valid: 1700, failed: 0, remaining: 0, stopped: 0, complete: true, verifiedLedger: true, verifiedPrintedLines: true, stageSpent: 6, stageCap: 7.5, stageReserved: 0, hostSpent: 10, hostCap: 13.25, hostReserved: 0 } };
  fs.writeFileSync(path.join(dataDir, bulkPath), JSON.stringify(bulk));
  const auditPath = "decisions/screening-audit-action.md"; const audit = "Synthetic retained selection-limitation action.\n"; fs.writeFileSync(path.join(dataDir, auditPath), audit);
  const proof = { version: 1, basis: "retained-completion-and-user-attestation", a7: { documentPath: a7Path, docDigest: sha(a7), attestedItem: "A7.10 Screening audit", decision: "approved", decidedAt: "2026-10-20T09:03:55.710Z" }, a9: { logPath, logDigest: sha(log), cutoffUpperBound: cutoff }, priorBulk: { filePath: bulkPath, fileDigest: sha(JSON.stringify(bulk)) }, screeningAudit: { documentPath: auditPath, docDigest: sha(audit), item: "Screening audit action (A7.10)", decision: "approved", decidedAt: "2026-10-21T01:16:15.407Z", source: "user-verified-signature" } };
  const proofPath = path.join(dataDir, "validation/release-proof.json");
  const save = () => fs.writeFileSync(proofPath, JSON.stringify(proof)); save();
  const updateLog = text => { fs.writeFileSync(path.join(dataDir, logPath), text); fs.utimesSync(path.join(dataDir, logPath), new Date(cutoff), new Date(cutoff)); proof.a9.logDigest = sha(text); save(); };
  const updateBulk = () => { const text = JSON.stringify(bulk); fs.writeFileSync(path.join(dataDir, bulkPath), text); proof.priorBulk.fileDigest = sha(text); save(); };
  return { dataDir, proofPath, protocolPath, proof, bulk, log, save, updateLog, updateBulk };
}

test("detached completion proof returns bound metadata without an old ledger", () => {
  const f = fixture(); const r = loadReleaseProof(f.proofPath, f.protocolPath);
  assert.equal(r.a7Digest, f.proof.a7.docDigest); assert.equal(r.recoveryCutoff, Date.parse(cutoff));
  assert.equal(r.auditApproval.decision, "approved"); assert.equal(r.auditApproval.source, "user-verified-signature"); assert.equal(r.proofDigest, sha(fs.readFileSync(f.proofPath, "utf8")));
  assert.equal(fs.existsSync(path.join(f.dataDir, "decisions/signoff.jsonl")), false);
  assert.equal(JSON.stringify(r).includes("Synthetic retained"), false);
});

test("changed proof sources and malformed digest values are refused", () => {
  const f = fixture(); fs.appendFileSync(path.join(f.dataDir, f.proof.screeningAudit.documentPath), "changed");
  assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /digest/);
  const g = fixture(); g.proof.a7.docDigest = "not-a-digest"; g.save(); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /digest/);
});

test("both retained rule sections must match the current public protocol", () => {
  const f = fixture(); fs.appendFileSync(f.protocolPath, "changed recovery text"); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /A9/);
  const g = fixture(); fs.writeFileSync(g.protocolPath, fs.readFileSync(g.protocolPath, "utf8").replace("Synthetic rules.", "Changed rules.")); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /A7/);
});

test("every recovery item requires an approved printed decision on the current digest", () => {
  const f = fixture(); f.updateLog(f.log.replace('"decision":"approved"', '"decision":"rejected"'));
  assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /A9/);
  const g = fixture(); g.updateLog(g.log.split("\n").slice(1).join("\n")); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /A9/);
});

test("last accounting must report all six successful completed sign-off items", () => {
  const f = fixture(); f.updateLog(f.log + 'ACCOUNTING: {"stage":"signoff","total":6,"success":5,"ok":false,"complete":false}\n');
  assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /accounting/);
});

test("mtime is only the exact recorded recovery upper bound", () => {
  const f = fixture(); fs.utimesSync(path.join(f.dataDir, f.proof.a9.logPath), new Date(cutoff), new Date(Date.parse(cutoff) + 1000)); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /mtime/);
  const g = fixture(); g.proof.a9.cutoffUpperBound = "2026-10-24T02:00:30.401Z"; g.save(); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /upper bound/);
});

test("retained gold completion preserves its one no-gold outcome", () => {
  const f = fixture(); f.bulk.priorStages[2].labelled = 300; f.bulk.priorStages[2].noGold = 0; f.updateBulk(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /gold/);
  const g = fixture(); g.bulk.priorStages[2].allDecisionsValid = true; g.updateBulk(); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /gold/);
});

test("all current confirmations and verified ledger completion are mandatory", () => {
  for (const field of ["valid", "remaining", "verifiedLedger", "verifiedPrintedLines"]) {
    const f = fixture(); f.bulk.fullConfirmation[field] = field === "valid" ? 1699 : field === "remaining" ? 1 : false; f.updateBulk(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /confirmation/);
  }
});

test("closed reservation arithmetic tolerates floating dust without permitting a material hold", () => {
  const f = fixture(); f.bulk.fullConfirmation.stageReserved = 1.0755285551056204e-16; f.bulk.fullConfirmation.hostReserved = 2.706168622523819e-16; f.updateBulk();
  assert.doesNotThrow(() => loadReleaseProof(f.proofPath, f.protocolPath));
  f.bulk.fullConfirmation.stageReserved = 1e-6; f.updateBulk(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /ledger bounds/);
  f.bulk.fullConfirmation.stageReserved = 0; f.bulk.fullConfirmation.stageSpent = f.bulk.fullConfirmation.stageCap + .001; f.updateBulk(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /ledger bounds/);
});

test("old-ledger names are refused for proof, public protocol, listed files and aliases", () => {
  const f = fixture(); f.proof.a7.documentPath = "decisions/signoff.jsonl"; f.save(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /forbidden/);
  assert.throws(() => loadReleaseProof(path.join(f.dataDir, "validation/signoff.jsonl"), f.protocolPath), /forbidden/);
  assert.throws(() => loadReleaseProof(f.proofPath, path.join(f.dataDir, "signoff.jsonl")), /forbidden/);
  const g = fixture(); const ledger = path.join(g.dataDir, "decisions/signoff.jsonl"); fs.writeFileSync(ledger, "MUST_NOT_READ"); fs.symlinkSync(ledger, path.join(g.dataDir, "decisions/alias.md")); g.proof.a7.documentPath = "decisions/alias.md"; g.save(); assert.throws(() => loadReleaseProof(g.proofPath, g.protocolPath), /forbidden/);
});

test("paths cannot escape the data root or designate a credential", () => {
  for (const name of ["../outside.md", "/tmp/outside.md", "decisions/.env", "decisions/token.key"]) {
    const f = fixture(); f.proof.a7.documentPath = name; f.save(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /path|forbidden/);
  }
  const f = fixture(); fs.symlinkSync(f.protocolPath, path.join(f.dataDir, "decisions/linked.md")); f.proof.a7.documentPath = "decisions/linked.md"; f.save(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /A7|digest/);
});

test("attestation provenance and the two specifically verified items cannot be substituted", () => {
  for (const [section, key, value] of [["a7", "attestedItem", "all A7 items"], ["screeningAudit", "source", "inferred"], ["screeningAudit", "decidedAt", "2026-10-22T01:16:15.407Z"], ["screeningAudit", "decision", "rejected"]]) {
    const f = fixture(); f.proof[section][key] = value; f.save(); assert.throws(() => loadReleaseProof(f.proofPath, f.protocolPath), /attestation/);
  }
});
