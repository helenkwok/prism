// src/pipeline/run.ts — the one-command orchestrator (COD-06, D-29, D-30).
// Wires plans 02-02..02-06's modules into one pipeline:
//   boundary -> evidence (tavily + github) -> redact -> segment -> code
//   (+retry) -> filter -> claims+gate -> record -> tally.
//
//   node src/pipeline/run.ts                          run all 10 projects (default slice-projects.json)
//   node src/pipeline/run.ts --project 3               run only project n=3
//   node src/pipeline/run.ts --slice <path>            run the project list at <path> instead of the default
//                                                       pipeline/slice-projects.json (03-09: the pilot draw)
//
// Node 24 strips this file's types natively.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pLimit from "p-limit";

import { resolveDataDir, getDb } from "../app/server/db.ts";
import { deriveBoundary, hostClass, type Boundary } from "./evidence/boundary.ts";
import { collectProjectPages, type FetchImpl as TavilyFetchImpl } from "./evidence/tavily.ts";
import { createGithubClient, fetchRepoEvidence, type FetchImpl as GithubFetchImpl, type RepoEvidence } from "./evidence/github.ts";
import { redactText } from "./evidence/redact.ts";
import { buildSnapshot } from "./evidence/segment.ts";
import { loadGateFile, resolveGatesPath, buildContract, type GateFile, type CheckEntry } from "./coding/contract.ts";
import { loadCodebook, checkPromptText, type Codebook } from "./coding/codebook-prompt.ts";
import { createClient, buildChatBody, PINNED_MODEL, PINNED_BASE_URL, type FetchImpl as NebiusFetchImpl } from "./coding/nebius-client.ts";
import { codeProjectWithRetry, allUnknownChecks, type CallOnce } from "./coding/retry.ts";
import { applyQuoteOrUnknownFilter } from "./coding/filter.ts";
import { detectInjection } from "./coding/injection-flag.ts";
import { buildClaimsForProject } from "./claims/build-claims.ts";
import { runGate, type SpawnImpl } from "./gate/run-gate.ts";
import { withStageCache, defaultCacheDir } from "./cache/stage-cache.ts";
import {
  ensurePipelineSchema,
  recordProjectResult,
  recordInjectionFlags,
  recordMissingData,
  type CheckStateRecord,
  type ClaimRecord as StoreClaimRecord,
} from "./store/results.ts";
import { printTally } from "./tally.ts";

const CODEBOOK_VERSION = "v0";

export interface SliceEntryLike {
  n: number;
  hn_id: string;
  title: string;
  final_url: string;
}

interface Overrides {
  tavilyFetchImpl?: TavilyFetchImpl;
  githubFetchImpl?: GithubFetchImpl;
  nebiusFetchImpl?: NebiusFetchImpl;
  gateSpawnImpl?: SpawnImpl;
  pythonPath?: string;
  gateScriptPath?: string;
}

interface Source {
  url: string;
  rawText: string;
}

/** README/SECURITY.md content from github.ts: base64-decoded when so encoded, else passed through. */
function decodeGithubText(info: { content: string | null; encoding: string | null } | { failed: true } | null): string | null {
  if (!info || "failed" in info) return null;
  if (info.content === null) return null;
  if (info.encoding === "base64") {
    return Buffer.from(info.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return info.content;
}

function githubSecurityPath(info: { path: string | null } | { failed: true } | null): string {
  if (info && !("failed" in info) && info.path) return info.path;
  return "SECURITY.md";
}

/** Nebius coding prompt, modeled on scripts/spikes/nebius-matrix.mjs's buildCodingPrompt.
 * The per-check checklist text is sourced from codebook.md (CDB-01, D-31) via
 * checkPromptText — never a second hardcoded copy of the codebook's own field text. */
export function buildCodingMessages(checkIds: string[], codebook: Codebook, jsonSchema: unknown, spans: { id: string; text: string }[]) {
  const checklist = checkIds.map((id) => checkPromptText(codebook, id)).join("\n\n");
  const spanText = spans.map((s) => `${s.id}: ${s.text}`).join("\n\n");
  const system =
    "You are coding evidence for a fixed set of decision-gate checks, from a project's own pages and repository, " +
    "split into numbered spans. For EACH of the following checks, decide proposedState (one of: pass, fail, " +
    "unknown, claimed) using only the numbered spans below, and cite the span ids (from the list given) that " +
    "support your decision in spanIds. If no span supports a decision, use unknown and an empty spanIds array. " +
    "Never invent a span id that is not in the list below.\n\nChecks:\n" +
    checklist +
    "\n\nRespond with JSON only, matching this JSON Schema exactly:\n" +
    JSON.stringify(jsonSchema);
  const user = "Spans:\n\n" + (spanText || "(no spans — every check must be unknown)");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function makeNebiusCallOnce(codebook: Codebook, spansById: Map<string, string>, fetchImpl?: NebiusFetchImpl): CallOnce {
  return async (client: any, _cfg, jsonSchema, checkIds, spanIds) => {
    const spans = spanIds.map((id) => ({ id, text: spansById.get(id) ?? "" }));
    const body = buildChatBody({
      model: PINNED_MODEL,
      messages: buildCodingMessages(checkIds, codebook, jsonSchema, spans),
      mode: "json_schema",
      schema: { name: "gate_checks", schema: jsonSchema, strict: true },
      thinking: false,
    });
    const res = await client.request("/chat/completions", { method: "POST", body });
    if (!res.ok) throw new Error(`nebius chat/completions returned status ${res.status}`);
    const content = (res.json as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("nebius response is missing choices[0].message.content");
    return content;
  };
  // `fetchImpl` is threaded through the client the caller builds, not here —
  // kept as a parameter only for signature symmetry with the other call-once builders.
  void fetchImpl;
}

export interface ProjectOutcome {
  n: number;
  hnId: string;
  status: "ok" | "failed";
  error?: string;
  boundaryFromCache?: boolean;
  evidenceFromCache?: boolean;
  redactFromCache?: boolean;
  segmentFromCache?: boolean;
  injectionFromCache?: boolean;
  codeFromCache?: boolean;
  filterFromCache?: boolean;
  claimsFromCache?: boolean;
  recordFromCache?: boolean;
  tavilyCreditsSpent?: number;
}

export interface RunAccounting {
  ranProjects: number;
  succeeded: number;
  failed: number;
  evidenceComputed: number;
  evidenceFromCache: number;
  codeComputed: number;
  codeFromCache: number;
  approxTavilyCreditsSpent: number;
  outcomes: ProjectOutcome[];
}

/** One project through every stage, each wrapped in withStageCache for resumability (COD-06). */
async function processProject(
  project: SliceEntryLike,
  ctx: {
    apiKeys: { tavily: string; nebius: string; github: string };
    cacheDir: string;
    dataDir: string;
    db: ReturnType<typeof getDb>;
    gateFile: GateFile;
    contract: ReturnType<typeof buildContract>;
    codebook: Codebook;
    overrides: Overrides;
  },
): Promise<ProjectOutcome> {
  const { apiKeys, cacheDir, dataDir, db, gateFile, contract, codebook, overrides } = ctx;
  const projectId = String(project.hn_id);

  // 1. boundary — cheap, cached anyway for a uniform resume story.
  const boundaryStage = await withStageCache(cacheDir, projectId, "boundary", { finalUrl: project.final_url }, async () => deriveBoundary(project.final_url));
  const boundary: Boundary = boundaryStage.value;

  let githubOwnerRepo: { owner: string; repo: string } | null = null;
  const finalHost = new URL(project.final_url).hostname;
  if (hostClass(finalHost) === "shared-path-host" && boundary.host === "github.com" && boundary.pathPrefix) {
    const parts = boundary.pathPrefix.split("/").filter(Boolean);
    if (parts.length >= 2) githubOwnerRepo = { owner: parts[0], repo: parts[1] };
  }

  // 2. evidence — Tavily collection + (when GitHub-hosted) repo evidence.
  const evidenceStage = await withStageCache(
    cacheDir,
    projectId,
    "evidence",
    { finalUrl: project.final_url, boundary, githubOwnerRepo },
    async () => {
      const [tavilyResult, githubResult] = await Promise.all([
        collectProjectPages({ boundary, startUrl: project.final_url, apiKey: apiKeys.tavily, fetchImpl: overrides.tavilyFetchImpl }),
        githubOwnerRepo
          ? fetchRepoEvidence({
              owner: githubOwnerRepo.owner,
              repo: githubOwnerRepo.repo,
              client: createGithubClient({ token: apiKeys.github, fetchImpl: overrides.githubFetchImpl }),
            })
          : Promise.resolve(null as RepoEvidence | null),
      ]);
      return { tavily: tavilyResult, github: githubResult };
    },
  );
  const evidence = evidenceStage.value;

  // 3. redact — every third-party text, GitHub README/SECURITY.md base64-decoded first (EVD-07).
  const redactStage = await withStageCache(cacheDir, projectId, "redact", evidence, async () => {
    const sources: Source[] = evidence.tavily.pages.map((p) => ({ url: p.url, rawText: p.rawText }));
    const gh = evidence.github;
    if (gh && githubOwnerRepo) {
      const readmeText = decodeGithubText(gh.readme);
      if (readmeText) sources.push({ url: `https://github.com/${githubOwnerRepo.owner}/${githubOwnerRepo.repo}#readme`, rawText: readmeText });
      const securityText = decodeGithubText(gh.securityMd);
      if (securityText) {
        const p = githubSecurityPath(gh.securityMd);
        sources.push({ url: `https://github.com/${githubOwnerRepo.owner}/${githubOwnerRepo.repo}/blob/HEAD/${p}`, rawText: securityText });
      }
    }
    return { sources: sources.map((s) => ({ url: s.url, ...redactText(s.rawText) })) };
  });
  const redacted = redactStage.value;

  // 4. segment — one combined, page-index-prefixed span list for the whole project (EVD-04).
  //    Each snapshot is ALSO persisted content-addressed by its own hash
  //    (criterion 3: "every stored page is a content-addressed snapshot")
  //    so scripts/phase2-acceptance.sh can recompute sha256 over the stored,
  //    already-redacted text and compare it to the hash results.ts records.
  const snapshotsDir = path.join(dataDir, "pipeline", "snapshots");
  const segmentStage = await withStageCache(cacheDir, projectId, "segment", redacted, async () => {
    fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
    const retrievedAt = new Date().toISOString();
    const spanUrls: Record<string, string> = {};
    const spans: { id: string; text: string }[] = [];
    const snapshotHashesInCollectionOrder: string[] = [];
    let pageIndex = 0;
    for (const src of redacted.sources) {
      pageIndex += 1;
      const snapshot = buildSnapshot(src.url, retrievedAt, src.text);
      snapshotHashesInCollectionOrder.push(snapshot.snapshotHash);
      fs.writeFileSync(
        path.join(snapshotsDir, `${snapshot.snapshotHash}.json`),
        JSON.stringify({ ...snapshot, redactedText: src.text, redactionCounts: src.counts }),
        { mode: 0o600 },
      );
      for (const span of snapshot.spans) {
        const prefixed = `p${pageIndex}-${span.id}`;
        spanUrls[prefixed] = src.url;
        spans.push({ id: prefixed, text: span.text });
      }
    }
    return { spans, spanUrls, snapshotHashesInCollectionOrder };
  });
  const segmented = segmentStage.value;
  const spanIds = segmented.spans.map((s: { id: string }) => s.id);

  // EVD-06: injection-pattern detection — cached, metadata-only, never read by
  // any later stage (D-39/D-40/D-41). Must not influence codeChecks, filteredChecks or claims.
  const injectionStage = await withStageCache(cacheDir, projectId, "injection", { spans: segmented.spans }, async () =>
    detectInjection(segmented.spans),
  );
  const injectionResult = injectionStage.value;

  // 5. code — skip the live Nemotron call on a guaranteed-degenerate (zero-span) input (D-29/D-30).
  const codeStage = await withStageCache(cacheDir, projectId, "code", { spanIds, hasSpans: spanIds.length > 0 }, async () => {
    if (spanIds.length === 0) {
      return { valid: false as const, attempts: 0, allUnknown: true as const, checks: allUnknownChecks(contract.checkIds) };
    }
    const spansById = new Map<string, string>(segmented.spans.map((s: { id: string; text: string }) => [s.id, s.text]));
    const client = createClient({ baseUrl: PINNED_BASE_URL, apiKey: apiKeys.nebius, fetchImpl: overrides.nebiusFetchImpl });
    const callOnce = makeNebiusCallOnce(codebook, spansById);
    return codeProjectWithRetry({ client, cfg: {}, contract, spanIds, callOnce });
  });
  const codingResult: any = codeStage.value;
  const codeChecks: CheckEntry[] = codingResult.checks ?? codingResult.data?.checks ?? [];
  const codingAttempts: number = codingResult.attempts ?? 0;
  const codingAllUnknown: boolean = codingResult.allUnknown === true;

  // 6. filter — downgrade-only quote-or-unknown (COD-02).
  const filterStage = await withStageCache(cacheDir, projectId, "filter", { codeChecks, spanIds }, async () => applyQuoteOrUnknownFilter(codeChecks, spanIds));
  const filteredChecks: CheckEntry[] = filterStage.value;

  // 7. claims+gate — the 5 claim.json records, gated (COD-04, COD-05).
  const claimsStage = await withStageCache(cacheDir, projectId, "claims+gate", { filteredChecks, spanUrls: segmented.spanUrls }, async () =>
    buildClaimsForProject({
      project: project.title,
      filteredStates: filteredChecks,
      spanUrls: segmented.spanUrls,
      runGate: (record) => runGate(record, { spawnImpl: overrides.gateSpawnImpl, pythonPath: overrides.pythonPath, gateScriptPath: overrides.gateScriptPath }),
      gatesPath: gateFile.path,
    }),
  );
  const claims = claimsStage.value;

  // 8. record — the durable manifest + per-check + per-claim rows (COD-06).
  const recordStage = await withStageCache(cacheDir, projectId, "record", { filteredChecks, claimsKeys: Object.keys(claims) }, async () => {
    const byCodeId = new Map(codeChecks.map((c) => [c.checkId, c]));
    const checkStates: CheckStateRecord[] = filteredChecks.map((f) => ({
      checkId: f.checkId,
      proposedState: byCodeId.get(f.checkId)?.proposedState ?? f.proposedState,
      filteredState: f.proposedState,
      spanIds: f.spanIds,
    }));
    const storeClaims: StoreClaimRecord[] = Object.entries(claims).map(([decisionId, v]: [string, any]) => ({
      decisionId,
      claimJson: v.record,
      gateStatus: v.gateResult.status,
    }));
    const gateSha = (Object.values(claims)[0] as any).gateResult.gateSha;
    const promptHash = crypto.createHash("sha256").update(JSON.stringify(contract.jsonSchema)).digest("hex");

    await recordProjectResult(db, {
      projectN: project.n,
      hnId: projectId,
      modelId: PINNED_MODEL,
      promptHash,
      codebookVersion: CODEBOOK_VERSION,
      gateSha,
      snapshotHashesInCollectionOrder: segmented.snapshotHashesInCollectionOrder,
      codingAttempts,
      codingAllUnknown,
      checkStates,
      claims: storeClaims,
    });
    await recordInjectionFlags(db, project.n, injectionResult.spanIds.map((spanId) => ({ spanId })));
    await recordMissingData(db, project.n, evidence.tavily.pages.length === 0);

    // A small sidecar manifest (criteria 2/3): per-snapshot URL, redaction
    // counts and visibility. results.ts's schema (plan 02-06, not re-
    // architected here) stores only snapshot hashes, not URLs — this file is
    // what scripts/phase2-acceptance.sh re-checks withinBoundary against.
    const manifestDir = path.join(dataDir, "pipeline", "manifests");
    fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(manifestDir, `${project.n}.json`),
      JSON.stringify(
        {
          projectN: project.n,
          hnId: projectId,
          boundary,
          snapshots: redacted.sources.map((s: { url: string; counts: unknown }) => ({
            url: s.url,
            visibility: "provider-extracted",
            redactionCounts: s.counts,
          })),
          snapshotHashesInCollectionOrder: segmented.snapshotHashesInCollectionOrder,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    return { recorded: true };
  });

  return {
    n: project.n,
    hnId: projectId,
    status: "ok",
    boundaryFromCache: boundaryStage.fromCache,
    evidenceFromCache: evidenceStage.fromCache,
    redactFromCache: redactStage.fromCache,
    segmentFromCache: segmentStage.fromCache,
    injectionFromCache: injectionStage.fromCache,
    codeFromCache: codeStage.fromCache,
    filterFromCache: filterStage.fromCache,
    claimsFromCache: claimsStage.fromCache,
    recordFromCache: recordStage.fromCache,
    tavilyCreditsSpent: evidence.tavily.creditsSpent,
  };
}

export async function runPipeline({
  sliceProjectsPath,
  apiKeys,
  concurrency = 2,
  cacheDir,
  dataDir,
  db,
  gatesPath,
  projectFilter,
  overrides = {},
}: {
  sliceProjectsPath?: string;
  apiKeys: { tavily: string; nebius: string; github: string };
  concurrency?: number;
  cacheDir?: string;
  /** Where the per-project manifest sidecar is written; defaults to PRISM_DATA_DIR. Tests must override this. */
  dataDir?: string;
  db?: ReturnType<typeof getDb>;
  gatesPath?: string;
  projectFilter?: number;
  overrides?: Overrides;
}): Promise<RunAccounting> {
  const resolvedDataDir = dataDir ?? resolveDataDir();
  const resolvedSliceProjectsPath = sliceProjectsPath ?? path.join(resolvedDataDir, "pipeline", "slice-projects.json");
  const allProjects: SliceEntryLike[] = JSON.parse(fs.readFileSync(resolvedSliceProjectsPath, "utf8"));
  const projects = projectFilter === undefined ? allProjects : allProjects.filter((p) => p.n === projectFilter);

  const resolvedDb = db ?? getDb();
  await ensurePipelineSchema(resolvedDb);
  const gateFile = loadGateFile(resolveGatesPath(gatesPath));
  const contract = buildContract(gateFile.checkIds);
  const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
  const resolvedCacheDir = cacheDir ?? defaultCacheDir();

  const limit = pLimit(concurrency);
  const outcomes: ProjectOutcome[] = await Promise.all(
    projects.map((project) =>
      limit(async (): Promise<ProjectOutcome> => {
        try {
          return await processProject(project, {
            apiKeys,
            cacheDir: resolvedCacheDir,
            dataDir: resolvedDataDir,
            db: resolvedDb,
            gateFile,
            contract,
            codebook,
            overrides,
          });
        } catch (err) {
          return { n: project.n, hnId: String(project.hn_id), status: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );

  const accounting: RunAccounting = {
    ranProjects: outcomes.length,
    succeeded: outcomes.filter((o) => o.status === "ok").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    evidenceComputed: outcomes.filter((o) => o.evidenceFromCache === false).length,
    evidenceFromCache: outcomes.filter((o) => o.evidenceFromCache === true).length,
    codeComputed: outcomes.filter((o) => o.codeFromCache === false).length,
    codeFromCache: outcomes.filter((o) => o.codeFromCache === true).length,
    approxTavilyCreditsSpent: outcomes.reduce((sum, o) => sum + (o.evidenceFromCache === false ? (o.tavilyCreditsSpent ?? 0) : 0), 0),
    outcomes,
  };
  return accounting;
}

// ---- credentials -------------------------------------------------------------

/** Where the CLI's key files live: PRISM_KEY_DIR, else ~/Library/Application Support/prism. */
export function keyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRISM_KEY_DIR || path.join(os.homedir(), "Library", "Application Support", "prism");
}

/**
 * A credential from the environment, else from <keyDir>/<file> (mode 600, filled from the clipboard).
 * Returns undefined when neither exists. Errors name the file path only, never its content.
 */
export function readKey(envName: string, file: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[envName]) return env[envName];
  const p = path.join(keyDir(env), file);
  if (!fs.existsSync(p)) return undefined;
  if ((fs.statSync(p).mode & 0o077) !== 0) throw new Error(`${p}: readable by group or others; run chmod 600 on it`);
  const value = fs.readFileSync(p, "utf8").trim();
  return value || undefined;
}

// ---- CLI -------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "run.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  (async () => {
    const args = process.argv.slice(2);
    const projectIdx = args.indexOf("--project");
    const projectFilter = projectIdx >= 0 ? Number(args[projectIdx + 1]) : undefined;
    const sliceIdx = args.indexOf("--slice");
    const sliceProjectsPath = sliceIdx >= 0 ? args[sliceIdx + 1] : undefined;

    const tavily = readKey("TAVILY_API_KEY", "tavily.key");
    const nebius = readKey("NEBIUS_API_KEY", "nebius.key");
    // GITHUB_TOKEN in the environment wins when set; otherwise fall back to
    // the `gh` CLI's own stored auth (`gh auth token`) rather than requiring
    // a separate credential in .env — this machine's `gh` is already
    // authenticated with `repo` scope, which is all github.ts's read-only
    // evidence calls need.
    let github = process.env.GITHUB_TOKEN;
    if (!github) {
      try {
        github = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
      } catch {
        github = undefined;
      }
    }
    const missing = [
      !tavily ? `TAVILY_API_KEY (or ${path.join(keyDir(), "tavily.key")})` : null,
      !nebius ? `NEBIUS_API_KEY (or ${path.join(keyDir(), "nebius.key")})` : null,
      !github ? "GITHUB_TOKEN (and `gh auth token` also failed — run `gh auth login` or set GITHUB_TOKEN)" : null,
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      process.stderr.write(`run.ts: missing required env var(s): ${missing.join(", ")}\n`);
      process.exit(1);
    }

    const accounting = await runPipeline({ apiKeys: { tavily: tavily!, nebius: nebius!, github: github! }, projectFilter, sliceProjectsPath });
    for (const o of accounting.outcomes) {
      if (o.status === "failed") process.stderr.write(`project n=${o.n}: FAILED: ${o.error}\n`);
    }
    process.stdout.write(`ACCOUNTING: ${JSON.stringify({ ...accounting, outcomes: undefined })}\n`);
    await printTally();
  })().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
