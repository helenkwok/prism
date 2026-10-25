// A rejected correction stays unapplied; the original missed check is withheld explicitly.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SIGNOFF_MODEL } from "../signoff/signoff.ts";

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const fail = (reason: string): never => { throw new Error(`correction approval failure: ${reason}`); };
export type CorrectionApprovalFailure = { checkId: string; proposalPath: string; recordPath: string; signoffPath: string };
type Action = { checkId: string; action: string; applied?: boolean; basis?: string };

export function loadCorrectionApprovalFailures(failures: CorrectionApprovalFailure[], dataDir: string, checkIds: string[], actions: Action[], cutoff: number) {
  if (!Array.isArray(failures) || !failures.length || new Set(failures.map(f => f.checkId)).size !== failures.length) fail("invalid or duplicate failure scope");
  const root = fs.realpathSync(dataDir), validation = fs.realpathSync(path.join(root, "validation"));
  const expectedJournal = path.join(root, "decisions", "release-signoff.jsonl");
  const read = (file: unknown) => {
    if (typeof file !== "string" || path.extname(file) !== ".json") return fail("an explicit validation JSON document is required");
    const absolute = path.resolve(file), real = fs.realpathSync(absolute);
    if (path.dirname(real) !== validation || fs.lstatSync(absolute).isSymbolicLink()) fail("proposal or receipt path escapes validation");
    const text = fs.readFileSync(real, "utf8");
    return { text, value: JSON.parse(text) };
  };
  const result = failures.map(failure => {
    if (!failure || !checkIds.includes(failure.checkId)) return fail("unknown check");
    const proposal = read(failure.proposalPath), receipt = read(failure.recordPath);
    const job = proposal.value, record = receipt.value;
    if (!job || typeof job.doc !== "string" || !job.doc || typeof job.context !== "string" || !job.context || typeof job.item !== "string" || !job.item.includes(failure.checkId)) fail("proposal must bind the named check, document and context");
    const docDigest = sha(job.doc), inputDigest = sha(JSON.stringify({ doc: job.doc, context: job.context, item: job.item }));
    const validRecord = (row: any): boolean => row?.item === job.item && row.docDigest === docDigest && row.inputDigest === inputDigest && row.decision === "rejected" &&
      typeof row.decidedAt === "string" && Number.isFinite(Date.parse(row.decidedAt)) && Date.parse(row.decidedAt) >= cutoff && Date.parse(row.decidedAt) <= Date.now() + 60_000 &&
      row.reviewer?.kind === "agent" && row.reviewer.modelId === SIGNOFF_MODEL && row.reviewer.id === `agent:${SIGNOFF_MODEL}`;
    if (!validRecord(record)) fail("receipt is not the current independent rejection of the exact proposal");
    if (typeof failure.signoffPath !== "string" || path.basename(failure.signoffPath) !== "release-signoff.jsonl" || fs.realpathSync(failure.signoffPath) !== expectedJournal ||
        fs.lstatSync(failure.signoffPath).isSymbolicLink()) fail("only the explicit new release approval journal is permitted");
    const rows = fs.readFileSync(expectedJournal, "utf8").split(/\r?\n/).filter(Boolean).map((line, order) => ({ row: JSON.parse(line), order }))
      .filter(({ row }) => row.item === job.item && row.docDigest === docDigest);
    if (rows.some(({ row }) => !Number.isFinite(Date.parse(row.decidedAt)))) fail("invalid journal decision timestamp");
    rows.sort((a, b) => Date.parse(b.row.decidedAt) - Date.parse(a.row.decidedAt) || b.order - a.order);
    const latest = rows[0]?.row;
    if (!validRecord(latest) || !isDeepStrictEqual(latest, record)) fail("latest journal decision is not the retained rejection");
    const bound = { checkId: failure.checkId, proposalDigest: sha(proposal.text), recordDigest: sha(receipt.text), docDigest, inputDigest, decidedAt: record.decidedAt };
    return { ...bound, approvalFailureEvidenceDigest: sha(JSON.stringify(bound)) };
  });
  const selected = actions.filter(action => action.basis === "correction-approval-failed");
  if (selected.length !== result.length || new Set(selected.map(a => a.checkId)).size !== result.length || selected.some(action =>
    action.action !== "withhold" || action.applied !== true || !result.some(row => row.checkId === action.checkId) || actions.filter(a => a.checkId === action.checkId).length !== 1)) fail("explicit withholding actions must match every rejected correction");
  return result;
}
