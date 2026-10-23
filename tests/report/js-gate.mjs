// Test-side gate: the vendored JS evaluator wrapped to run-gate.ts's GateResult
// shape, plus the corpus loaders the report tests share. CI-only, like core.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateClaim, loadBundledGates } from "../../vendor/ai-output-to-value/packages/mcp/src/core.mjs";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { gateCheckOrder } from "../../src/report/view.ts";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
export const corpusPath = path.join(root, "tests", "fixtures", "report", "synthetic-corpus.json");
export const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
export const codebook = loadCodebook(path.join(root, "codebook.md"));
export const order = gateCheckOrder(gatesPath);

export async function jsRunGate(record) {
  return { status: evaluateClaim(record, loadBundledGates()).status, raw: null, gateSha: "js-test" };
}
