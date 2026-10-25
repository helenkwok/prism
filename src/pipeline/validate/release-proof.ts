// Detached metadata binds retained completion evidence and the specifically attested audit decision.
// It does not reconstruct an approval history or assert that every rule item was separately inspected.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { a7Section } from "./gold.ts";
import { a9Section, A9_ITEMS } from "../signoff/a9.ts";

const BASIS = "retained-completion-and-user-attestation";
const A7_TIME = "2026-10-20T09:03:55.710Z";
const AUDIT_TIME = "2026-10-21T01:16:15.407Z";
const RECOVERY_BOUND = "2026-10-23T02:00:30.401Z";
const AUDIT_ITEM = "Screening audit action (A7.10)";
const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => { throw new Error(`release proof: ${reason}`); };

export type ReleaseProof = {
  a7Digest: string;
  recoveryCutoff: number;
  auditApproval: { item: string; decision: "approved"; docDigest: string; decidedAt: string; source: "user-verified-signature" };
  proofDigest: string;
};

function permittedName(file: string): void {
  if (file.split(/[\\/]/).some(name => name.toLowerCase() === "signoff.jsonl" || /^\.env(?:\.|$)|^\.secrets$|^\.npmrc$|\.(?:key|pem|p12|pfx)$/i.test(name))) fail("forbidden source path");
}
function checkedDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid digest");
  return value as string;
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel.length > 0 && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
function printedRecords(log: string, prefix: string): any[] {
  return log.split(/\r?\n/).filter(line => line.startsWith(prefix)).map(line => {
    let row: unknown;
    try { row = JSON.parse(line.slice(prefix.length).trim()); } catch { return fail("invalid printed accounting or decision"); }
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("invalid printed accounting or decision");
    return row;
  });
}
function exactStage(stages: any[], name: string): any {
  const found = stages.filter(row => row?.stage === name);
  if (found.length !== 1) fail(`ambiguous retained ${name} completion`);
  return found[0];
}

/** Reads only the proof's listed, root-contained source files and the supplied public protocol. */
export function loadReleaseProof(proofPath: string, protocolPath: string): ReleaseProof {
  permittedName(proofPath); permittedName(protocolPath);
  if (path.basename(path.dirname(path.resolve(proofPath))) !== "validation" || path.extname(proofPath) !== ".json") fail("proof path must be a validation JSON document");
  const dataRoot = fs.realpathSync(path.resolve(path.dirname(proofPath), ".."));
  const realProof = fs.realpathSync(proofPath); permittedName(realProof);
  const realProtocol = fs.realpathSync(protocolPath); permittedName(realProtocol);
  if (!inside(dataRoot, realProof) || path.basename(realProtocol) !== "PROTOCOL.md") fail("invalid proof or public protocol path");
  const proofText = fs.readFileSync(realProof, "utf8");
  const proof = JSON.parse(proofText);
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || (proof.version !== undefined && proof.version !== 1) || proof.basis !== BASIS) fail("unsupported attestation basis or version");
  if (proof.a7?.attestedItem !== "A7.10 Screening audit" || proof.a7.decision !== "approved" || proof.a7.decidedAt !== A7_TIME ||
      proof.screeningAudit?.item !== AUDIT_ITEM || proof.screeningAudit.decision !== "approved" || proof.screeningAudit.decidedAt !== AUDIT_TIME || proof.screeningAudit.source !== "user-verified-signature") fail("invalid specific user attestation");
  if (proof.a9?.cutoffUpperBound !== RECOVERY_BOUND) fail("invalid recorded recovery upper bound");

  const readSource = (relative: unknown, expectedDigest: unknown, extension: string, basename?: string): { text: string; file: string; digest: string } => {
    const digest = checkedDigest(expectedDigest);
    if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) fail("source path must be relative and root-contained");
    permittedName(relative as string);
    if (path.extname(relative as string) !== extension || (basename && path.basename(relative as string) !== basename)) fail("invalid retained source path");
    const file = fs.realpathSync(path.resolve(dataRoot, relative as string)); permittedName(file);
    if (!inside(dataRoot, file)) fail("source path escapes data root");
    const text = fs.readFileSync(file, "utf8");
    if (sha(text) !== digest) fail("retained source digest mismatch");
    return { text, file, digest };
  };
  const protocol = fs.readFileSync(realProtocol, "utf8");
  const a7 = readSource(proof.a7.documentPath, proof.a7.docDigest, ".md");
  const section7 = a7Section(protocol);
  if (!section7 || a7.digest !== sha(section7)) fail("A7 no longer matches the current protocol");
  const a9 = readSource(proof.a9.logPath, proof.a9.logDigest, ".log", "approved-signoff.log");
  if (fs.statSync(a9.file).mtime.toISOString() !== proof.a9.cutoffUpperBound) fail("recovery log mtime differs from its recorded upper bound");
  const section9 = a9Section(protocol);
  if (!section9) fail("A9 section is missing");
  const a9Digest = sha(section9);
  const decisions = printedRecords(a9.text, "SIGNOFF:");
  for (const item of A9_ITEMS) {
    const matches = decisions.filter(row => row.item === item);
    if (!matches.length || matches.some(row => row.digest !== a9Digest || row.decision !== "approved")) fail("A9 printed approvals do not match the current section");
  }
  const accounting = printedRecords(a9.text, "ACCOUNTING:").at(-1);
  if (!accounting || accounting.stage !== "signoff" || accounting.total !== 6 || accounting.success !== 6 || accounting.ok !== true || accounting.complete !== true) fail("retained sign-off accounting is incomplete");
  const prior = readSource(proof.priorBulk?.filePath, proof.priorBulk?.fileDigest, ".json", "04-05b-final-verification.json");
  const bulk = JSON.parse(prior.text);
  if (!Array.isArray(bulk.priorStages)) fail("retained completion stages are missing");
  const signoff = exactStage(bulk.priorStages, "signoff");
  if (signoff.total !== 6 || signoff.success !== 6 || signoff.ok !== true || signoff.complete !== true) fail("retained sign-off completion is incomplete");
  const recode = exactStage(bulk.priorStages, "recode");
  if (recode.total !== 300 || recode.accounted !== 300 || recode.success !== 300 || recode.failed !== 0 || recode.stopped !== 0 || recode.ok !== true || recode.complete !== true) fail("retained recode completion is incomplete");
  const gold = exactStage(bulk.priorStages, "gold");
  if (gold.total !== 300 || gold.accounted !== 300 || gold.success !== 299 || gold.labelled !== 299 || gold.noGold !== 1 || gold.failed !== 1 || gold.stopped !== 0 || gold.ok !== true || gold.complete !== true || gold.allDecisionsValid !== false) fail("retained gold completion must preserve one no-gold outcome");
  const full = bulk.fullConfirmation;
  if (!full || full.total !== 1700 || full.accounted !== 1700 || full.valid !== 1700 || full.failed !== 0 || full.remaining !== 0 || full.stopped !== 0 || full.complete !== true || full.verifiedLedger !== true || full.verifiedPrintedLines !== true) fail("retained confirmation completion or ledger verification is incomplete");
  for (const prefix of ["stage", "host"]) {
    const spent = full[`${prefix}Spent`], cap = full[`${prefix}Cap`], reserved = full[`${prefix}Reserved`];
    if (![spent, cap, reserved].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) || cap <= 0 || reserved > 1e-9 || spent + reserved > cap + 1e-12) fail("retained confirmation ledger bounds are invalid");
  }
  const audit = readSource(proof.screeningAudit.documentPath, proof.screeningAudit.docDigest, ".md");
  return { a7Digest: a7.digest, recoveryCutoff: Date.parse(proof.a9.cutoffUpperBound), auditApproval: { item: AUDIT_ITEM, decision: "approved", docDigest: audit.digest, decidedAt: AUDIT_TIME, source: "user-verified-signature" }, proofDigest: sha(proofText) };
}
