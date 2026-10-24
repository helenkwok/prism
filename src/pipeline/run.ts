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
import { deriveBoundary, hostClass, withinBoundary, type Boundary } from "./evidence/boundary.ts";
import { collectProjectPages, type CollectProjectPagesResult, type FetchImpl as TavilyFetchImpl } from "./evidence/tavily.ts";
import { collectOwnSitePages, type FetchImpl as OwnSiteFetchImpl } from "./evidence/own-site.ts";
import { createGithubClient, fetchRepoEvidence, type FetchImpl as GithubFetchImpl, type RepoEvidence } from "./evidence/github.ts";
import { redactText } from "./evidence/redact.ts";
import { renderTextAsync, type RenderImplAsync } from "./evidence/render.ts";
import { findSiteRepos } from "./evidence/site-repos.ts";
import { assertA8Signed } from "./signoff/a8.ts";
import { assertA9Signed } from "./signoff/a9.ts";
import { buildSnapshot } from "./evidence/segment.ts";
import { loadGateFile, resolveGatesPath, buildContract, type GateFile, type CheckEntry } from "./coding/contract.ts";
import { loadCodebook, checkPromptText, type Codebook } from "./coding/codebook-prompt.ts";
import {
  createClient,
  buildChatBody,
  PINNED_MODEL,
  SECOND_CODER_MODEL,
  PINNED_BASE_URL,
  QuotaStop,
  isQuotaResponse,
  type FetchImpl as NebiusFetchImpl,
} from "./coding/nebius-client.ts";
import { requireTfBudget, DollarBudget } from "./coding/spend-guards.ts";
import { uniqueProjectSpans } from "./coding/span-packing.ts";
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
  recordSecondCoding,
  type CheckStateRecord,
  type ClaimRecord as StoreClaimRecord,
} from "./store/results.ts";
import { printTally } from "./tally.ts";

const CODEBOOK_VERSION = "v1.0";

export interface SliceEntryLike {
  n: number;
  hn_id: string;
  title: string;
  final_url: string;
}

interface Overrides {
  tavilyFetchImpl?: TavilyFetchImpl;
  /** D-66: inject fetch for the free own-site collector in tests. */
  ownSiteFetchImpl?: OwnSiteFetchImpl;
  githubFetchImpl?: GithubFetchImpl;
  nebiusFetchImpl?: NebiusFetchImpl;
  gateSpawnImpl?: SpawnImpl;
  pythonPath?: string;
  gateScriptPath?: string;
  /** D-55: inject a fake renderer in tests; production uses renderTextAsync. */
  renderImpl?: RenderImplAsync;
  /**
   * D-66: default is the free own-site collector (bulk COD-07).
   * Set true only for Phase-7 / single-project Tavily bonus path (--use-tavily).
   */
  useTavily?: boolean;
  /** D-67: Token Factory dollar cap; required for live TF (CLI --budget / PRISM_TF_BUDGET). */
  tfBudget?: number | DollarBudget;
  /** 07-13: live-run stage events (Collect, Code, Gate); absent → no behaviour change. */
  onStage?: (stage: "collect" | "code" | "gate", status: "running" | "done", message?: string | null) => void | Promise<void>;
  /** Provider swap: OpenAI-compatible base URL and model-id map for coding (default Token Factory). */
  nebiusBaseUrl?: string;
  modelMap?: Record<string, string>;
  /** 07-13: where the A9 guard reads sign-off records (the live run's scratch copy). */
  a9SignoffPath?: string;
}

/** One browser at a time across concurrent projects (D-55 / Pitfall 3). */
const renderLimit = pLimit(1);

/** Pages thinner than this get a headless render before redact (D-55). */
const THIN_PAGE_CHARS = 500;

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

// 4096 truncated replies on pages with many spans (finish_reason=length on the 20-project pilot).
export const CODING_MAX_TOKENS = 16384;

function makeNebiusCallOnce(codebook: Codebook, spansById: Map<string, string>, model: string = PINNED_MODEL): CallOnce {
  return async (client: any, _cfg, jsonSchema, checkIds, spanIds) => {
    const spans = spanIds.map((id) => ({ id, text: spansById.get(id) ?? "" }));
    const body = buildChatBody({
      model,
      messages: buildCodingMessages(checkIds, codebook, jsonSchema, spans),
      mode: "json_schema",
      schema: { name: "gate_checks", schema: jsonSchema, strict: true },
      thinking: false,
      maxTokens: CODING_MAX_TOKENS,
    });
    const res = await client.request("/chat/completions", { method: "POST", body });
    if (res.outcome === "too-large") {
      throw new Error(`too-large: prompt estimate refused before Token Factory HTTP`);
    }
    if (client.dollarBudget) process.stdout.write(`${client.dollarBudget.budgetLine()}\n`);
    if (isQuotaResponse(res) || res.status === 402) {
      throw new QuotaStop(res.status, `nebius quota stop status ${res.status}`);
    }
    if (!res.ok) throw new Error(`nebius chat/completions returned status ${res.status}`);
    const content = (res.json as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("nebius response is missing choices[0].message.content");
    return content;
  };
}

/** Tavily plan usage-limit statuses (docs: 432 Custom Forbidden / usage limit; 433 also listed). */
const TAVILY_USAGE_LIMIT_STATUSES = new Set([432, 433]);

function tavilyUsageLimitStatus(evidence: { tavily?: { calls?: { status?: number }[] } }): number | null {
  for (const call of evidence.tavily?.calls ?? []) {
    if (typeof call.status === "number" && TAVILY_USAGE_LIMIT_STATUSES.has(call.status)) return call.status;
  }
  return null;
}

export interface ProjectOutcome {
  n: number;
  hnId: string;
  status: "ok" | "failed" | "stopped";
  error?: string;
  boundaryFromCache?: boolean;
  evidenceFromCache?: boolean;
  redactFromCache?: boolean;
  segmentFromCache?: boolean;
  injectionFromCache?: boolean;
  codeFromCache?: boolean;
  code2FromCache?: boolean;
  filterFromCache?: boolean;
  claimsFromCache?: boolean;
  recordFromCache?: boolean;
  tavilyCreditsSpent?: number;
}

export interface RunAccounting {
  totalProjects: number;
  accountedProjects: number;
  /** Projects actually started; queued projects skipped after a stop do not count. */
  ranProjects: number;
  ok: boolean;
  status: "complete" | "failed" | "stopped" | "empty";
  succeeded: number;
  failed: number;
  stopped: number;
  stopReason?: string;
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
    /** D-48: when set, code2 runs only for hn ids in the set. */
    secondCoderIds?: Set<string>;
    /** D-51: notify the run that credit exhaustion requires a clean stop. */
    onStop?: (reason: string) => void;
  },
): Promise<ProjectOutcome> {
  const { apiKeys, cacheDir, dataDir, db, gateFile, contract, codebook, overrides, secondCoderIds, onStop } = ctx;
  const projectId = String(project.hn_id);

  const onStage = overrides.onStage ?? (() => {});
  await onStage("collect", "running");
  // 1. boundary — cheap, cached anyway for a uniform resume story.
  const boundaryStage = await withStageCache(cacheDir, projectId, "boundary", { finalUrl: project.final_url }, async () => deriveBoundary(project.final_url));
  const boundary: Boundary = boundaryStage.value;

  let githubOwnerRepo: { owner: string; repo: string } | null = null;
  const finalHost = new URL(project.final_url).hostname;
  if (hostClass(finalHost) === "shared-path-host" && boundary.host === "github.com" && boundary.pathPrefix) {
    const parts = boundary.pathPrefix.split("/").filter(Boolean);
    if (parts.length >= 2) githubOwnerRepo = { owner: parts[0], repo: parts[1] };
  }

  // 2. evidence — free own-site collector by default (D-66); Tavily only when useTavily.
  // D-51: never cache a result that hit a Tavily usage-limit status (resume must re-try the call).
  // collector key bumps cache so prior Tavily evidence is not reused after the collector switch.
  const useTavily = overrides.useTavily === true;
  const collectPages = async (b: Boundary, startUrl: string): Promise<CollectProjectPagesResult> => {
    if (useTavily) {
      return collectProjectPages({
        boundary: b,
        startUrl,
        apiKey: apiKeys.tavily,
        fetchImpl: overrides.tavilyFetchImpl,
      });
    }
    return collectOwnSitePages({ boundary: b, startUrl, fetchImpl: overrides.ownSiteFetchImpl });
  };
  const evidenceStage = await withStageCache(
    cacheDir,
    projectId,
    "evidence",
    // homepageFollow is set only for GitHub-entry projects, so other projects' cached evidence keeps its key.
    {
      finalUrl: project.final_url,
      boundary,
      githubOwnerRepo,
      collector: useTavily ? "tavily" : "own-site-v1",
      ...(githubOwnerRepo ? { homepageFollow: 1 } : {}),
    },
    async () => {
      const [tavilyResult, githubResult] = await Promise.all([
        collectPages(boundary, project.final_url),
        githubOwnerRepo
          ? fetchRepoEvidence({
              owner: githubOwnerRepo.owner,
              repo: githubOwnerRepo.repo,
              client: createGithubClient({ token: apiKeys.github, fetchImpl: overrides.githubFetchImpl }),
            })
          : Promise.resolve(null as RepoEvidence | null),
      ]);
      // A repository-first launch's own website is the homepage its repository declares: collect it
      // too, inside its own boundary, so "GitHub-only" means the repo really is the only own source.
      const homepage = homepageToFollow(githubResult);
      if (!homepage) return { tavily: tavilyResult, github: githubResult, homepage: null };
      const site = await collectPages(deriveBoundary(homepage), homepage);
      const seen = new Set(tavilyResult.pages.map((p) => p.url));
      return {
        tavily: {
          ...tavilyResult,
          pages: [...tavilyResult.pages, ...site.pages.filter((p) => !seen.has(p.url))],
          creditsSpent: tavilyResult.creditsSpent + site.creditsSpent,
          mapUrlCount: tavilyResult.mapUrlCount + site.mapUrlCount,
          offBoundaryCount: tavilyResult.offBoundaryCount + site.offBoundaryCount,
          calls: [...tavilyResult.calls, ...site.calls],
          missingUrls: [...tavilyResult.missingUrls, ...site.missingUrls],
        },
        github: githubResult,
        homepage,
      };
    },
    (result) => tavilyUsageLimitStatus(result) == null,
  );
  const evidence = evidenceStage.value;

  const usageLimit = tavilyUsageLimitStatus(evidence);
  if (usageLimit != null) {
    const reason = `tavily usage-limit status ${usageLimit}`;
    onStop?.(reason);
    return { n: project.n, hnId: projectId, status: "stopped", error: reason, evidenceFromCache: evidenceStage.fromCache };
  }

  // 2a. render — thin pages (<500 chars) and the start URL when Tavily returned nothing (D-55).
  const thinUrls: string[] = [];
  for (const p of evidence.tavily.pages as { url: string; rawText: string }[]) {
    if (p.rawText.length < THIN_PAGE_CHARS && withinBoundary(p.url, boundary)) thinUrls.push(p.url);
  }
  if (evidence.tavily.pages.length === 0 && withinBoundary(project.final_url, boundary)) {
    thinUrls.push(project.final_url);
  }
  const uniqueThinUrls = [...new Set(thinUrls)];
  const renderStage = await withStageCache(cacheDir, projectId, "render", { urls: uniqueThinUrls, v: 1 }, async () => {
    const rendered: Record<string, string> = {};
    const renderFn = overrides.renderImpl ?? renderTextAsync;
    await Promise.all(
      uniqueThinUrls.map((url) =>
        renderLimit(async () => {
          const text = await renderFn(url);
          const prior = (evidence.tavily.pages as { url: string; rawText: string }[]).find((p) => p.url === url)?.rawText.length ?? 0;
          if (text.length > prior) rendered[url] = text;
        }),
      ),
    );
    return { rendered };
  });
  const renderedMap: Record<string, string> = renderStage.value.rendered ?? {};
  const didRender = Object.keys(renderedMap).length > 0;
  const evidenceForRedact = didRender
    ? (() => {
        const pages = (evidence.tavily.pages as { url: string; rawText: string }[]).map((p) =>
          renderedMap[p.url] ? { ...p, rawText: renderedMap[p.url] } : p,
        );
        for (const [url, rawText] of Object.entries(renderedMap)) {
          if (!pages.some((p) => p.url === url)) pages.push({ url, rawText });
        }
        return { ...evidence, tavily: { ...evidence.tavily, pages } };
      })()
    : evidence;

  // 2b. site repos — a site-first launch's own GitHub repositories (evidence/site-repos.ts).
  const siteReposStage = githubOwnerRepo
    ? { value: [] as { owner: string; repo: string; evidence: RepoEvidence }[], fromCache: false }
    : await withStageCache(cacheDir, projectId, "site-repos", { pages: evidence.tavily.pages.map((p: { url: string }) => p.url), boundary, rule: 1 }, async () =>
        findSiteRepos({
          pageTexts: evidence.tavily.pages.map((p: { rawText: string }) => p.rawText),
          boundary,
          client: createGithubClient({ token: apiKeys.github, fetchImpl: overrides.githubFetchImpl }),
        }),
      );
  const siteRepos = siteReposStage.value;

  // 3. redact — every third-party text, GitHub README/SECURITY.md base64-decoded first (EVD-07).
  // Projects without site repos keep their earlier cache key; rendered pages bump the key (D-55).
  const redactKey = didRender
    ? siteRepos.length
      ? { evidence: evidenceForRedact, siteRepos, rendered: renderedMap }
      : { evidence: evidenceForRedact, rendered: renderedMap }
    : siteRepos.length
      ? { evidence, siteRepos }
      : evidence;
  const redactStage = await withStageCache(cacheDir, projectId, "redact", redactKey, async () => {
    const sources: Source[] = evidenceForRedact.tavily.pages.map((p: { url: string; rawText: string }) => ({ url: p.url, rawText: p.rawText }));
    const repos = [
      ...(evidenceForRedact.github && githubOwnerRepo ? [{ ...githubOwnerRepo, evidence: evidenceForRedact.github as RepoEvidence }] : []),
      ...siteRepos,
    ];
    for (const { owner, repo, evidence: gh } of repos) {
      const readmeText = decodeGithubText(gh.readme as any);
      if (readmeText) sources.push({ url: `https://github.com/${owner}/${repo}#readme`, rawText: readmeText });
      const securityText = decodeGithubText(gh.securityMd as any);
      if (securityText) {
        const p = githubSecurityPath(gh.securityMd as any);
        sources.push({ url: `https://github.com/${owner}/${repo}/blob/HEAD/${p}`, rawText: securityText });
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
  await onStage("collect", "done", `${redacted.sources.length} pages collected (robots.txt checked first).`);
  await onStage("code", "running");

  // EVD-06: injection-pattern detection — cached, metadata-only, never read by
  // any later stage (D-39/D-40/D-41). Must not influence codeChecks, filteredChecks or claims.
  const injectionStage = await withStageCache(cacheDir, projectId, "injection", { spans: segmented.spans }, async () =>
    detectInjection(segmented.spans),
  );
  const injectionResult = injectionStage.value;

  // 5. code — skip the live model call on a guaranteed-degenerate (zero-span) input (D-29/D-30).
  // The key covers everything the model sees (codebook text, schema, spans), the model and the
  // token cap, so a reworded codebook check is re-coded rather than served from cache.
  const chunks = chunkSpans(uniqueProjectSpans(segmented.spans as { id: string; text: string }[]));
  const codeWith = (model: string, stage: string) => {
    const codingRequestHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ model, maxTokens: CODING_MAX_TOKENS, chunks: chunks.map((c) => buildCodingMessages(contract.checkIds, codebook, contract.jsonSchema, c)) }))
      .digest("hex");
    return withStageCache(
      cacheDir,
      projectId,
      stage,
      { spanIds, hasSpans: spanIds.length > 0, codingRequestHash },
      async () => {
        if (spanIds.length === 0) {
          return { valid: false as const, attempts: 0, allUnknown: true as const, checks: allUnknownChecks(contract.checkIds), chunks: 0, failedChunks: 0 };
        }
        const spansById = new Map<string, string>(segmented.spans.map((s: { id: string; text: string }) => [s.id, s.text]));
        // D-67: TF coding requires explicit --budget / PRISM_TF_BUDGET (no silent spend).
        // Injected nebiusFetchImpl (unit tests) may skip the gate; live path never does.
        const client = createClient({
          baseUrl: overrides.nebiusBaseUrl ?? PINNED_BASE_URL,
          apiKey: apiKeys.nebius,
          fetchImpl: overrides.nebiusFetchImpl,
          modelMap: overrides.modelMap,
          ...(overrides.tfBudget != null
            ? { budget: overrides.tfBudget }
            : overrides.nebiusFetchImpl
              ? { skipBudgetGate: true }
              : { budget: requireTfBudget() }),
        });
        const callOnce = makeNebiusCallOnce(codebook, spansById, model);
        const results: any[] = [];
        for (const chunk of chunks) {
          results.push(await codeProjectWithRetry({ client, cfg: {}, contract, spanIds: chunk.map((s) => s.id), callOnce }));
        }
        const perChunk: CheckEntry[][] = results.map((r) => r.checks ?? r.data?.checks ?? []);
        const failedChunks = results.filter((r) => r.allUnknown === true).length;
        return {
          valid: failedChunks < results.length,
          attempts: results.reduce((a, r) => a + (r.attempts ?? 0), 0),
          allUnknown: failedChunks === results.length,
          checks: mergeChunkCodings(contract.checkIds, perChunk),
          chunks: results.length,
          failedChunks,
        };
      },
      // A coding with any retry-exhausted chunk is not cached, so the next run tries the project again.
      (result: any) => !(result.attempts > 0 && result.failedChunks > 0),
    );
  };
  const codeStage = await codeWith(PINNED_MODEL, "code");
  // 5b. second coder (NVIDIA, hackathon rule; VAL agreement figure). Recorded alongside, never
  // read by filter/claims/gate: the primary coding alone decides. D-48: only the seeded subset.
  const runCode2 = secondCoderIds === undefined || secondCoderIds.has(projectId);
  const code2Stage = runCode2
    ? await codeWith(SECOND_CODER_MODEL, "code2")
    : { value: null as any, fromCache: false };
  const second: any = code2Stage.value;
  const secondChecks: CheckEntry[] = second?.checks ?? [];
  const secondFiltered: CheckEntry[] = runCode2 ? applyQuoteOrUnknownFilter(secondChecks, spanIds) : [];
  const codingResult: any = codeStage.value;
  const codeChecks: CheckEntry[] = codingResult.checks ?? codingResult.data?.checks ?? [];
  const codingAttempts: number = codingResult.attempts ?? 0;
  const codingAllUnknown: boolean = codingResult.allUnknown === true;
  await onStage("code", "done", `${contract.checkIds.length} checks coded${codingAllUnknown && spanIds.length ? " (the coder gave no valid reply: all unknown)" : ""}.`);
  await onStage("gate", "running");

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
  await onStage("gate", "done", "Gate run on the filtered states.");

  // 8. record — the durable manifest + per-check + per-claim rows (COD-06). Never cached: the
  // cache knows nothing about which database it wrote to, so a cached record skipped writing to a
  // fresh or replaced database. The writes are idempotent replaces, so always doing them is safe.
  const recordStage = { fromCache: false, value: await (async () => {
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
    if (runCode2 && second) {
      const byCode2Id = new Map(secondChecks.map((c) => [c.checkId, c]));
      await recordSecondCoding(db, project.n, {
        modelId: SECOND_CODER_MODEL,
        allUnknown: second.allUnknown === true,
        checkStates: secondFiltered.map((f) => ({
          checkId: f.checkId,
          proposedState: byCode2Id.get(f.checkId)?.proposedState ?? f.proposedState,
          filteredState: f.proposedState,
          spanIds: f.spanIds,
        })),
      });
    }
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
          homepageBoundary: (evidence as any).homepage ? deriveBoundary((evidence as any).homepage) : null,
          // A site-first launch's own repositories, each its own boundary (evidence/site-repos.ts).
          repoBoundaries: siteRepos.map((r) => deriveBoundary(`https://github.com/${r.owner}/${r.repo}`)),
          snapshots: redacted.sources.map((s: { url: string; counts: unknown }) => ({
            url: s.url,
            visibility: renderedMap[s.url] ? "rendered" : "provider-extracted",
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
  })() };

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
    code2FromCache: code2Stage.fromCache,
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
  secondCoderIds,
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
  /** D-48 / VAL-02: when set, code2 runs only for these hn ids. */
  secondCoderIds?: Set<string>;
  overrides?: Overrides;
}): Promise<RunAccounting> {
  const resolvedDataDir = dataDir ?? resolveDataDir();
  if (!overrides.nebiusFetchImpl) assertA9Signed(overrides.a9SignoffPath ? { signoffPath: overrides.a9SignoffPath } : undefined);
  // One budget object is shared by every project/client in this run.
  if (overrides.tfBudget != null && !(overrides.tfBudget instanceof DollarBudget)) {
    overrides = { ...overrides, tfBudget: new DollarBudget(overrides.tfBudget) };
  } else if (!overrides.nebiusFetchImpl && overrides.tfBudget == null) {
    overrides = { ...overrides, tfBudget: new DollarBudget(requireTfBudget()) };
  }
  const resolvedSliceProjectsPath = sliceProjectsPath ?? path.join(resolvedDataDir, "pipeline", "slice-projects.json");
  const allProjects: SliceEntryLike[] = JSON.parse(fs.readFileSync(resolvedSliceProjectsPath, "utf8"));
  const projects = projectFilter === undefined ? allProjects : allProjects.filter((p) => p.n === projectFilter);

  const resolvedDb = db ?? getDb();
  await ensurePipelineSchema(resolvedDb);
  const gateFile = loadGateFile(resolveGatesPath(gatesPath));
  const contract = buildContract(gateFile.checkIds);
  const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
  const resolvedCacheDir = cacheDir ?? defaultCacheDir();

  let stopReason: string | undefined;
  let attemptedProjects = 0;
  const onStop = (reason: string) => {
    if (!stopReason) stopReason = reason;
  };

  const limit = pLimit(concurrency);
  const outcomes: ProjectOutcome[] = await Promise.all(
    projects.map((project) =>
      limit(async (): Promise<ProjectOutcome> => {
        if (stopReason) {
          return { n: project.n, hnId: String(project.hn_id), status: "stopped", error: stopReason };
        }
        attemptedProjects += 1;
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
            secondCoderIds,
            onStop,
          });
        } catch (err) {
          if (err instanceof QuotaStop || (err as Error)?.name === "QuotaStop" || (err as Error)?.name === "BudgetExceededError") {
            const reason = (err as QuotaStop).message || `nebius quota stop status ${(err as QuotaStop).status}`;
            onStop(reason);
            return { n: project.n, hnId: String(project.hn_id), status: "stopped", error: reason };
          }
          return { n: project.n, hnId: String(project.hn_id), status: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );

  const accounting: RunAccounting = {
    totalProjects: projects.length,
    accountedProjects: outcomes.length,
    ranProjects: attemptedProjects,
    ok: outcomes.length > 0 && outcomes.every(o => o.status === "ok"),
    status: outcomes.some(o => o.status === "failed") ? "failed" : outcomes.some(o => o.status === "stopped") ? "stopped" : outcomes.length ? "complete" : "empty",
    succeeded: outcomes.filter((o) => o.status === "ok").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    stopped: outcomes.filter((o) => o.status === "stopped").length,
    stopReason,
    evidenceComputed: outcomes.filter((o) => o.evidenceFromCache === false).length,
    evidenceFromCache: outcomes.filter((o) => o.evidenceFromCache === true).length,
    codeComputed: outcomes.filter((o) => o.codeFromCache === false).length,
    codeFromCache: outcomes.filter((o) => o.codeFromCache === true).length,
    approxTavilyCreditsSpent: outcomes.reduce((sum, o) => sum + (o.evidenceFromCache === false ? (o.tavilyCreditsSpent ?? 0) : 0), 0),
    outcomes,
  };
  return accounting;
}

/** Emit the authoritative result before any optional reporting can fail. */
export function reportRunAccounting(accounting: RunAccounting, {
  stdout = (line: string) => process.stdout.write(line),
  stderr = (line: string) => process.stderr.write(line),
  setExitCode = (code: number) => { process.exitCode = code; },
} = {}): void {
  for (const outcome of accounting.outcomes) {
    if (outcome.status !== "ok") stderr(`project n=${outcome.n}: ${outcome.status.toUpperCase()}: ${outcome.error}\n`);
  }
  stdout(`ACCOUNTING: ${JSON.stringify({ ...accounting, outcomes: undefined })}\n`);
  setExitCode(accounting.ok ? 0 : 1);
}

// ---- chunked coding ----------------------------------------------------------

/** About 10k tokens of span text per coding call: on a 41-page launch an ~82k-token prompt lost evidence
 * the same model found when given the relevant pages alone (ArtCraft, 2026-10-19). */
export const CODING_CHUNK_CHARS = 40_000;

/** Group spans into chunks of whole pages (span ids are `p<k>-...`), each under `limit` characters where a
 * page allows; a single page over the limit is split at span boundaries. */
export function chunkSpans<T extends { id: string; text: string }>(spans: T[], limit = CODING_CHUNK_CHARS): T[][] {
  const pages: T[][] = [];
  for (const s of spans) {
    const page = s.id.split("-")[0];
    const last = pages[pages.length - 1];
    if (last && last[0].id.split("-")[0] === page) last.push(s);
    else pages.push([s]);
  }
  const chunks: T[][] = [];
  let cur: T[] = [];
  let curChars = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    curChars = 0;
  };
  for (const page of pages) {
    const pageChars = page.reduce((a, s) => a + s.text.length, 0);
    if (curChars + pageChars <= limit) {
      cur.push(...page);
      curChars += pageChars;
      continue;
    }
    flush();
    for (const s of page) {
      if (curChars + s.text.length > limit) flush();
      cur.push(s);
      curChars += s.text.length;
    }
  }
  flush();
  return chunks;
}

const STATE_RANK: Record<string, number> = { pass: 3, claimed: 2, fail: 1, unknown: 0 };

/** Merge per-chunk codings: the strongest state across chunks wins (pass > claimed > fail > unknown), with the
 * union of the span ids every chunk cited for that winning state. */
export function mergeChunkCodings(checkIds: string[], perChunk: CheckEntry[][]): CheckEntry[] {
  return checkIds.map((checkId) => {
    let state: CheckEntry["proposedState"] = "unknown";
    let spans: string[] = [];
    for (const entries of perChunk) {
      const e = entries.find((c) => c.checkId === checkId);
      if (!e) continue;
      if (STATE_RANK[e.proposedState] > STATE_RANK[state]) {
        state = e.proposedState;
        spans = [...e.spanIds];
      } else if (e.proposedState === state) {
        spans.push(...e.spanIds);
      }
    }
    return { checkId, proposedState: state, spanIds: state === "unknown" ? [] : [...new Set(spans)] };
  });
}

/** The repository's declared homepage when it is a separate http(s) site, else null. */
export function homepageToFollow(github: RepoEvidence | null): string | null {
  const repo = github?.repo as { homepage?: string | null } | null | undefined;
  const raw = repo && typeof repo === "object" ? repo.homepage : null;
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return null;
  return u.toString();
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
    const concurrencyIdx = args.indexOf("--concurrency");
    const concurrency = concurrencyIdx >= 0 ? Number(args[concurrencyIdx + 1]) : 2;
    const subsetsIdx = args.indexOf("--subsets");
    let secondCoderIds: Set<string> | undefined;
    if (subsetsIdx >= 0) {
      const subsetsPath = args[subsetsIdx + 1];
      const subsets = JSON.parse(fs.readFileSync(subsetsPath, "utf8")) as { secondModel?: string[] };
      if (!Array.isArray(subsets.secondModel)) {
        process.stderr.write(`run.ts: --subsets file must contain a secondModel string array: ${subsetsPath}\n`);
        process.exit(1);
      }
      secondCoderIds = new Set(subsets.secondModel.map(String));
    }

    const useTavily = args.includes("--use-tavily");
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
      useTavily && !tavily ? `TAVILY_API_KEY (or ${path.join(keyDir(), "tavily.key")})` : null,
      !nebius ? `NEBIUS_API_KEY (or ${path.join(keyDir(), "nebius.key")})` : null,
      !github ? "GITHUB_TOKEN (and `gh auth token` also failed — run `gh auth login` or set GITHUB_TOKEN)" : null,
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      process.stderr.write(`run.ts: missing required env var(s): ${missing.join(", ")}\n`);
      process.exit(1);
    }

    // D-66: free-collector results must not count until A8 is signed (digest-bound).
    if (!useTavily) {
      assertA8Signed();
    }
    // D-67: post-fix coding/confirm counts require A9 (span fix + guards + hosts + archive).
    assertA9Signed();

    const accounting = await runPipeline({
      apiKeys: { tavily: tavily ?? "", nebius: nebius!, github: github! },
      projectFilter,
      sliceProjectsPath,
      concurrency,
      secondCoderIds,
      overrides: { useTavily },
    });
    reportRunAccounting(accounting);
    const projectNs = accounting.outcomes.filter((o) => o.status === "ok").map((o) => o.n);
    if (projectNs.length) await printTally({ projectNs });
  })().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
