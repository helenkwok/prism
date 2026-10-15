// src/pipeline/coding/codebook-prompt.ts — loads codebook.md and builds the
// per-check prompt text the Nemotron system prompt includes (CDB-01, D-31).
// Re-implements the fenced-JSON parse inline rather than importing from
// scripts/: a TypeScript pipeline module must not import a path under
// scripts/, keeping the two trees independently deployable.

import fs from "node:fs";

const FENCE_RE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

export interface CrosswalkEdge {
  source_id: string;
  title: string;
  locator: string;
  source_version: string;
  relation_type: "addresses" | "supports" | "partial";
  qualification: string;
  informational?: boolean;
}

export interface CodebookCheck {
  decision: string;
  label: string;
  operationalDefinition: string;
  passRule: string;
  failRule: string;
  claimedRule: string;
  notApplicableNote: string;
  anchors: { positive: string[]; negative: string[] };
  crosswalk: Record<string, CrosswalkEdge[]>;
}

export interface Codebook {
  codebookVersion: string;
  relationTypes: string[];
  checks: Record<string, CodebookCheck>;
}

/** Read codebook.md and extract its one fenced json block. */
export function loadCodebook(codebookPath = "codebook.md"): Codebook {
  const md = fs.readFileSync(codebookPath, "utf8");
  const m = FENCE_RE.exec(md);
  if (!m) throw new Error(`${codebookPath}: no fenced json block found`);
  return JSON.parse(m[1]);
}

/** One check's label/operationalDefinition/passRule/failRule/claimedRule, each on its own prefixed line. */
export function checkPromptText(codebook: Codebook, checkId: string): string {
  const check = codebook.checks[checkId];
  if (!check) throw new Error(`codebook has no check "${checkId}"`);
  return [
    `Label: ${check.label}`,
    `Definition: ${check.operationalDefinition}`,
    `Pass: ${check.passRule}`,
    `Fail: ${check.failRule}`,
    `Claimed: ${check.claimedRule}`,
  ].join("\n");
}
