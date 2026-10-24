// Preserve every selected example when a review packet exceeds the request allowance.
import fs from "node:fs";
import { projectSignoff } from "../signoff/capped.ts";
import type { ShortfallReview } from "./shortfall-review.ts";

export type ReviewJob = { checkId: string; item: string; doc: string; context: string; plan: ReturnType<typeof projectSignoff> };
export function batchShortfallReview(row: ShortfallReview): ReviewJob[] {
  const doc = fs.readFileSync(row.documentPath, "utf8");
  if (!row.tooLarge) return [{ checkId: row.checkId, item: row.item, doc, context: row.context, plan: projectSignoff(doc, row.context, row.item) }];
  const chunks: string[][] = []; let current: string[] = []; let header = "";
  for (const example of row.caseDocuments) {
    const text = fs.readFileSync(example.documentPath, "utf8");
    const index = text.indexOf("\n## Example ");
    if (index < 0) throw new Error("review example heading missing");
    const prefix = text.slice(0, index);
    if (!header) header = prefix;
    else if (prefix !== header) throw new Error("review example headers differ");
    const block = text.slice(index);
    const fits = (blocks: string[]) => {
      try { return projectSignoff(header + blocks.join("\n"), row.context, row.item + " (batch 999 of 999)").inputTokens <= 19900; } catch { return false; }
    };
    if (!fits([block])) throw new Error("one complete example needs a specific request exception; no truncation permitted");
    if (current.length && !fits([...current, block])) { chunks.push(current); current = []; }
    current.push(block);
  }
  if (current.length) chunks.push(current);
  if (!chunks.length || chunks.reduce((n, c) => n + c.length, 0) !== row.examples) throw new Error("review batching lost examples");
  return chunks.map((blocks, i) => {
    const item = `${row.item} (batch ${i + 1} of ${chunks.length})`;
    const doc = header + blocks.join("\n");
    return { checkId: row.checkId, item, doc, context: row.context, plan: projectSignoff(doc, row.context, item) };
  });
}
