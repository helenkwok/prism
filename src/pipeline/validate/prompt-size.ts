// D-67: no-network preflight, using the production coding prompt and packing.
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../../app/server/db.ts";
import { loadCodebook } from "../coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../coding/contract.ts";
import { DEFAULT_TOKEN_CAP, estimateMessagesTokens } from "../coding/spend-guards.ts";
import { projectSpans } from "../confirm/confirm.ts";
import { buildCodingMessages, chunkSpans } from "../run.ts";

export function summarizePromptSizes(tokens: number[], cap = DEFAULT_TOKEN_CAP) {
  const sorted = [...tokens].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
  return { p50: percentile(.5), p90: percentile(.9), max: sorted.at(-1) ?? 0, n: sorted.length, unit: "tokens" as const, cap, refused: sorted.filter(n => n >= cap).length };
}

export function measurePromptSizes({ projectsPath, dataDir = resolveDataDir() }: { projectsPath?: string; dataDir?: string } = {}) {
  const projects = JSON.parse(fs.readFileSync(projectsPath ?? path.join(dataDir, "pipeline", "sample-projects.json"), "utf8")) as { n: number }[];
  const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
  const contract = buildContract(loadGateFile(resolveGatesPath()).checkIds);
  const sizes: number[] = [];
  for (const project of projects) {
    const spans = projectSpans(dataDir, project.n);
    if (spans.some(s => s.text.length > 1500)) throw new Error("PROMPT_SIZE: resegmentation required");
    for (const chunk of chunkSpans(spans)) sizes.push(estimateMessagesTokens(buildCodingMessages(contract.checkIds, codebook, contract.jsonSchema, chunk)));
  }
  return { ...summarizePromptSizes(sizes), projects: projects.length, shape: "production-coding-chunks", measuredAt: new Date().toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const idx = process.argv.indexOf("--projects");
  const report = measurePromptSizes({ projectsPath: idx >= 0 ? process.argv[idx + 1] : undefined });
  const dir = path.join(resolveDataDir(), "validation");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "prompt-size-pre-recode.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`PROMPT_SIZE: ${JSON.stringify(report)}`);
  if (report.refused || !report.n) throw new Error("PROMPT_SIZE: preflight refused; adjust packing before any paid run");
}
