// PUB-04 wording lint and protocol section 7 trend lint over kind-tagged statements (research Pattern 5).
//   node src/publish/lint.ts <statements.json>
// Prints LINT: {"statements":N,"findings":F,"errors":E}, or one LINT FAIL <id> <rule> per error and exits 1.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { Statement } from "./statements.ts";

const EVALUATIVE = /\b(lack\w*|missing|fail\w*|non-compliant|blocked|compliant|certified|scor\w*)\b/i;
const TREND = /\b(improv\w*|worsen\w*|rising|falling|trend\w*|over time|grow\w*|declin\w*|(more|fewer) than last quarter)\b/i;

/** Check ids (backticks, <code>) and source titles (<cite>) are not wording. */
const strip = (text: string) => text.replace(/`[^`]*`/g, "").replace(/<code>.*?<\/code>|<cite>.*?<\/cite>/gis, "");

export function lintFinding(text: string): string[] {
  const t = strip(text);
  const errs: string[] = [];
  if (EVALUATIVE.test(t)) errs.push("evaluative-term");
  if (!/publicly evidence/i.test(t)) errs.push("missing-publicly-evidence");
  return errs;
}

export function lintTrend(text: string): string[] {
  return TREND.test(strip(text)) ? ["trend-wording"] : [];
}

/** Findings get both lints; cohort-prefixed statements get the trend lint; methods, definitions and limitations pass. */
export function lintStatements(list: Statement[]): { id: string; rule: string }[] {
  const out: { id: string; rule: string }[] = [];
  for (const s of list) {
    const rules = [...(s.kind === "finding" ? lintFinding(s.text) : []), ...(s.kind === "finding" || s.id.startsWith("cohort") ? lintTrend(s.text) : [])];
    for (const rule of rules) out.push({ id: s.id, rule });
  }
  return out;
}

function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error("usage: node src/publish/lint.ts <statements.json>");
    return 2;
  }
  const list = JSON.parse(fs.readFileSync(argv[0]!, "utf8")) as Statement[];
  const errors = lintStatements(list);
  for (const e of errors) console.log(`LINT FAIL ${e.id} ${e.rule}`);
  console.log(`LINT: ${JSON.stringify({ statements: list.length, findings: list.filter((s) => s.kind === "finding").length, errors: errors.length })}`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
