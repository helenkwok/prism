// D-66: exploratory Tavily vs free-collector cross-check for the archived 142.
// Never feeds publishedStates / gate statistics. Archive is opened read-only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { resolveDataDir } from "../../app/server/db.ts";

export type PageSets = {
  intersection: string[];
  tavilyOnly: string[];
  freeOnly: string[];
  jaccard: number;
};

export type ProjectCrossCheck = {
  projectN: number;
  pages: PageSets;
  spanQuoteOverlap: { tavilyQuotes: number; freeQuotes: number; sharedNormalized: number };
  checks: {
    n: number;
    agree: number;
    pairs: { checkId: string; tavily: string; free: string; agree: boolean }[];
  };
};

export type CrossCheckReport = {
  exploratory: true;
  not_for_publication: true;
  archivePath: string;
  liveDataDir: string;
  generatedAt: string;
  n: number;
  meanPageJaccard: number;
  checkAgreementRate: number;
  projects: ProjectCrossCheck[];
};

/** Case- and whitespace-normalise a quote for presence compare (A7.11 style). */
export function normalizeQuote(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function pageSets(tavilyUrls: string[], freeUrls: string[]): PageSets {
  const t = new Set(tavilyUrls);
  const f = new Set(freeUrls);
  const intersection = [...t].filter((u) => f.has(u)).sort();
  const tavilyOnly = [...t].filter((u) => !f.has(u)).sort();
  const freeOnly = [...f].filter((u) => !t.has(u)).sort();
  return { intersection, tavilyOnly, freeOnly, jaccard: jaccard(t, f) };
}

function readManifestUrls(manifestPath: string): string[] {
  if (!fs.existsSync(manifestPath)) return [];
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    snapshots?: { url?: string }[];
  };
  const urls = (m.snapshots ?? []).map((s) => s.url).filter((u): u is string => typeof u === "string");
  return [...new Set(urls)];
}

function loadQuotesFromSnapshots(
  dataRoot: string,
  hashes: string[],
): Set<string> {
  const out = new Set<string>();
  const snapDir = path.join(dataRoot, "pipeline", "snapshots");
  for (const h of hashes) {
    const p = path.join(snapDir, `${h}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8")) as { spans?: { text?: string }[] };
      for (const span of s.spans ?? []) {
        const n = normalizeQuote(span.text ?? "");
        if (n.length >= 20) out.add(n);
      }
    } catch {
      // skip corrupt
    }
  }
  return out;
}

function openReadonly(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) throw new Error(`database missing: ${dbPath}`);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export function compareProject({
  projectN,
  archiveRoot,
  liveRoot,
  archiveDb,
  liveDb,
}: {
  projectN: number;
  archiveRoot: string;
  liveRoot: string;
  archiveDb: Database.Database;
  liveDb: Database.Database;
}): ProjectCrossCheck {
  const tavilyUrls = readManifestUrls(path.join(archiveRoot, "pipeline", "manifests", `${projectN}.json`));
  const freeUrls = readManifestUrls(path.join(liveRoot, "pipeline", "manifests", `${projectN}.json`));
  const pages = pageSets(tavilyUrls, freeUrls);

  const archRow = archiveDb
    .prepare("SELECT snapshot_hashes_json FROM pipeline_project_results WHERE project_n = ?")
    .get(projectN) as { snapshot_hashes_json: string } | undefined;
  const liveRow = liveDb
    .prepare("SELECT snapshot_hashes_json FROM pipeline_project_results WHERE project_n = ?")
    .get(projectN) as { snapshot_hashes_json: string } | undefined;
  const archHashes: string[] = archRow ? JSON.parse(archRow.snapshot_hashes_json) : [];
  const liveHashes: string[] = liveRow ? JSON.parse(liveRow.snapshot_hashes_json) : [];
  const tQuotes = loadQuotesFromSnapshots(archiveRoot, archHashes);
  const fQuotes = loadQuotesFromSnapshots(liveRoot, liveHashes);
  let sharedNormalized = 0;
  for (const q of tQuotes) if (fQuotes.has(q)) sharedNormalized += 1;

  const archChecks = archiveDb
    .prepare("SELECT check_id, filtered_state FROM pipeline_check_states WHERE project_n = ? ORDER BY check_id")
    .all(projectN) as { check_id: string; filtered_state: string }[];
  const liveMap = new Map(
    (
      liveDb
        .prepare("SELECT check_id, filtered_state FROM pipeline_check_states WHERE project_n = ?")
        .all(projectN) as { check_id: string; filtered_state: string }[]
    ).map((r) => [r.check_id, r.filtered_state]),
  );
  const pairs = archChecks.map((r) => {
    const free = liveMap.get(r.check_id) ?? "missing";
    return {
      checkId: r.check_id,
      tavily: r.filtered_state,
      free,
      agree: r.filtered_state === free,
    };
  });
  const agree = pairs.filter((p) => p.agree).length;

  return {
    projectN,
    pages,
    spanQuoteOverlap: {
      tavilyQuotes: tQuotes.size,
      freeQuotes: fQuotes.size,
      sharedNormalized,
    },
    checks: { n: pairs.length, agree, pairs },
  };
}

export function runCrossCheck({
  archivePath,
  liveDataDir,
}: {
  archivePath: string;
  liveDataDir: string;
}): CrossCheckReport {
  const realArchive = fs.realpathSync.native(archivePath);
  if (path.basename(realArchive) !== "2026-10-21-tavily-142") {
    throw new Error(`refuse: archive basename must be 2026-10-21-tavily-142, got ${path.basename(realArchive)}`);
  }

  const archiveDb = openReadonly(path.join(realArchive, "prism.sqlite"));
  const liveDb = openReadonly(path.join(liveDataDir, "prism.sqlite"));
  try {
    const projectNs = (
      archiveDb.prepare("SELECT project_n FROM pipeline_project_results ORDER BY project_n").all() as {
        project_n: number;
      }[]
    ).map((r) => r.project_n);

    const projects = projectNs.map((projectN) =>
      compareProject({ projectN, archiveRoot: realArchive, liveRoot: liveDataDir, archiveDb, liveDb }),
    );

    const meanPageJaccard =
      projects.length === 0 ? 0 : projects.reduce((s, p) => s + p.pages.jaccard, 0) / projects.length;
    const checkTotal = projects.reduce((s, p) => s + p.checks.n, 0);
    const checkAgree = projects.reduce((s, p) => s + p.checks.agree, 0);
    const checkAgreementRate = checkTotal === 0 ? 0 : checkAgree / checkTotal;

    return {
      exploratory: true,
      not_for_publication: true,
      archivePath: realArchive,
      liveDataDir,
      generatedAt: new Date().toISOString(),
      n: projects.length,
      meanPageJaccard,
      checkAgreementRate,
      projects,
    };
  } finally {
    archiveDb.close();
    liveDb.close();
  }
}

export function writeReport(report: CrossCheckReport, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}

export function crosscheckLine(report: CrossCheckReport): string {
  return `CROSSCHECK: n=${report.n} mean_page_jaccard=${report.meanPageJaccard.toFixed(4)} check_agreement_rate=${report.checkAgreementRate.toFixed(4)} exploratory=true`;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "tavily-vs-free.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const i = process.argv.indexOf("--archive");
  if (i < 0 || !process.argv[i + 1]) {
    process.stderr.write(
      "usage: node src/pipeline/validate/tavily-vs-free.ts --archive ~/.prism-data/backups/2026-10-21-tavily-142 [--live <dataDir>] [--out <json>]\n",
    );
    process.exit(1);
  }
  const archivePath = process.argv[i + 1];
  const liveIdx = process.argv.indexOf("--live");
  const liveDataDir = liveIdx >= 0 ? process.argv[liveIdx + 1] : resolveDataDir();
  const outIdx = process.argv.indexOf("--out");
  const outPath =
    outIdx >= 0
      ? process.argv[outIdx + 1]
      : path.join(resolveDataDir(), "validation", "tavily-vs-free-142.json");

  const report = runCrossCheck({ archivePath, liveDataDir });
  writeReport(report, outPath);
  process.stdout.write(crosscheckLine(report) + "\n");
  process.stdout.write(`wrote ${outPath}\n`);
}
