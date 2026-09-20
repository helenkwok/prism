// Private-store paths for the spike harnesses. Every entry point calls
// spikeDirs() first, which runs assertOutsideRepo before anything is written.

import fs from "node:fs";
import path from "node:path";

import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "../../check-data-dir.mjs";

export function spikeDirs() {
  const root = resolveRepoRoot(process.cwd());
  const base = assertOutsideRepo(resolvePrivateDir(process.env, root), root);
  const spikes = path.join(base, "spikes");
  const dirs = {
    root,
    base,
    spikes,
    pages: path.join(spikes, "pages"),
    runs: path.join(spikes, "tavily-runs"),
    summaries: path.join(spikes, "tavily-summaries"),
    candidates: path.join(spikes, "candidates.json"),
    projects: path.join(spikes, "projects.json"),
  };
  for (const d of [dirs.spikes, dirs.pages, dirs.runs, dirs.summaries]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
