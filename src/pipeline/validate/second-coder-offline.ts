import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../../app/server/db.ts";
import { buildContract, isSchemaValid, loadGateFile, resolveGatesPath } from "../coding/contract.ts";
import { uniqueProjectSpans } from "../coding/span-packing.ts";
import { projectSpans } from "../confirm/confirm.ts";
import { chunkSpans } from "../run.ts";
import { splitLeadingThinkingBlock } from "./providers.ts";

export function inspectReplies(lines: string[], chunksFor: (n: number) => string[][], schema: Parameters<typeof isSchemaValid>[2]) {
  const report = { version: 1, stage: "second-coder", model: "nemotron-3-super:cloud", strictValidation: true, total: 0, envelopeCount: 0, envelopeJsonClean: 0, envelopeValid: 0, envelopeFailed: 0, valid: 0, failed: 0, failureCounts: { json_parse: 0, zod: 0, span_resolve: 0 }, complete: true, validationScope: "Unchanged strict contract and citation resolver against individual deduplicated 40k project chunks; no JSON repair or source changes." };
  const audits = [];
  for (const rawRecordLine of lines) {
    const row = JSON.parse(rawRecordLine);
    if (row.stage !== "second-coder") continue;
    if (typeof row.content !== "string" || !Number.isSafeInteger(row.projectN)) throw new Error("invalid stored reply metadata");
    report.total++;
    const envelope = splitLeadingThinkingBlock(row.content);
    const content = envelope?.content ?? row.content;
    if (envelope) {
      report.envelopeCount++;
      try { JSON.parse(content); report.envelopeJsonClean++; } catch {}
    }
    const chunks = chunksFor(row.projectN);
    if (!chunks.length) throw new Error("stored reply has no project chunks");
    const validations = chunks.map(ids => isSchemaValid(content, ids, schema));
    const validation = validations.find(v => v.valid) ?? validations[0];
    if (validation.valid) report.valid++;
    else { report.failed++; report.failureCounts[validation.stage as keyof typeof report.failureCounts]++; }
    if (envelope) { if (validation.valid) report.envelopeValid++; else report.envelopeFailed++; }
    audits.push({ rawRecordLine, rawContent: row.content, reasoningContent: envelope?.reasoning ?? null, content, separated: envelope !== null, validationStage: validation.stage, parsedResult: validation.valid ? JSON.parse(content) : null, projectN: row.projectN, requestDigest: row.requestDigest });
  }
  return { report, audits };
}

export function inspectStoredReplies(dataDir = resolveDataDir()) {
  const dir = path.join(dataDir, "validation");
  const lines = fs.readFileSync(path.join(dir, "coding-invalid-replies.jsonl"), "utf8").split("\n").filter(Boolean);
  const contract = buildContract(loadGateFile(resolveGatesPath()).checkIds);
  const chunks = new Map<number, string[][]>();
  const result = inspectReplies(lines, n => {
    if (!chunks.has(n)) chunks.set(n, chunkSpans(uniqueProjectSpans(projectSpans(dataDir, n))).map(c => c.map(s => s.id)));
    return chunks.get(n)!;
  }, contract.zodSchema);
  fs.writeFileSync(path.join(dir, "second-coder-envelope-offline.json"), JSON.stringify(result.report, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "second-coder-envelope-offline-audit.jsonl"), result.audits.map(a => JSON.stringify(a)).join("\n") + "\n", { mode: 0o600 });
  console.log(`OFFLINE_PARSE: ${JSON.stringify(result.report)}`);
  return result.report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) inspectStoredReplies();
