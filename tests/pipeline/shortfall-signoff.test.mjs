import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { batchShortfallReview } from "../../src/pipeline/validate/shortfall-signoff.ts";

test("oversized packets preserve all complete examples across guarded batches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-batch-"));
  try {
    const header = "# Existing rule and observed metrics\n";
    const blocks = Array.from({ length: 3 }, (_, i) => `\n## Example ${i + 1}: project ${i + 1}\n` + String(i).repeat(35000));
    const documentPath = path.join(dir, "full.md"); fs.writeFileSync(documentPath, header + blocks.join("\n"));
    const caseDocuments = blocks.map((block, i) => { const documentPath = path.join(dir, `${i}.md`); fs.writeFileSync(documentPath, header + block); return { documentPath }; });
    const jobs = batchShortfallReview({ checkId: "example", item: "Review example", context: "Existing rules", documentPath, tooLarge: true, examples: 3, caseDocuments });
    assert.ok(jobs.length > 1); assert.ok(jobs.every(j => j.plan.inputTokens < 20000 && j.plan.upperBoundUsd < .5));
    for (const block of blocks) assert.equal(jobs.filter(j => j.doc.includes(block)).length, 1);
    fs.writeFileSync(caseDocuments[0].documentPath, header + "\n## Example 1: project 1\n" + "x".repeat(100000));
    assert.throws(() => batchShortfallReview({ checkId: "example", item: "Review example", context: "Existing rules", documentPath, tooLarge: true, examples: 3, caseDocuments }), /specific request exception/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
