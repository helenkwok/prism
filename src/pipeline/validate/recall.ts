// VAL-06 / D-47 / A7.11: independent collection-recall gatherer (own sources only).

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "../../app/server/db.ts";
import { withStageCache, defaultCacheDir } from "../cache/stage-cache.ts";
import { checkPromptText, loadCodebook, type Codebook } from "../coding/codebook-prompt.ts";
import { loadGateFile, resolveGatesPath } from "../coding/contract.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../coding/nebius-client.ts";
import { projectSpans } from "../confirm/confirm.ts";
import {
  followRedirects,
  isAllowed,
  parseRobots,
  withinBoundary,
  type Boundary,
  type RobotsGroup,
} from "../evidence/boundary.ts";
import { createGithubClient, fetchRepoEvidence, type FetchImpl as GithubFetchImpl } from "../evidence/github.ts";
import { collectOwnSitePages, extractLinks, pageText } from "../evidence/own-site.ts";
import { redactText } from "../evidence/redact.ts";
import { githubRepoLinks, isOwnRepo } from "../evidence/site-repos.ts";
import { wilson } from "./agreement.ts";
import { assertIndependent, roleClient, ROLE_CONFIG, type RoleSpec } from "./providers.ts";

export const RECALL_BAR = 0.7;
const PAGE_CAP = 15;
const THIN_CHARS = 500;
const CHUNK_CHARS = 40_000;
const USER_AGENT = "PRISM-research/0.1 (+https://github.com/helenkwok/prism)";
/** D-66 free-collector stand-in for A7.11 widened map/extract (no Tavily). */
export const WIDENED_OWN_SITE_PAGE_CAP = 40;

export type GatherPage = {
  url: string;
  text: string;
  fetchedAt: string;
  rendered: boolean;
};

export type RecallItem = {
  checkId: string;
  url: string;
  quote: string;
  state: "pass" | "claimed";
};

export type VerifiedItem = RecallItem & { pageUrl: string };

export type MatchedItem = VerifiedItem & {
  found: boolean;
  missKind: "missedPage" | "changedText" | null;
};

export type ProjectRecall = {
  hnId: string;
  projectN: number;
  items: number;
  found: number;
  droppedNonVerbatim: number;
};

export type RecallFigure = {
  projects: number;
  items: number;
  found: number;
  recall: number;
  wilson95: [number, number];
  bar: number;
  withinThreshold: boolean;
  droppedNonVerbatim: number;
  perProject: ProjectRecall[];
};

export type SampleEntry = {
  n: number;
  hn_id: string;
  title?: string;
  entry_url: string;
  final_url: string;
  boundary: Boundary;
  type_class?: string;
};

type FetchImpl = typeof fetch;

function decodeGithubText(info: { content: string | null; encoding: string | null } | { failed: true } | null): string | null {
  if (!info || "failed" in info) return null;
  if (info.content === null) return null;
  if (info.encoding === "base64") {
    return Buffer.from(info.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return info.content;
}

/** Lowercase, collapse whitespace, strip punctuation. */
export function normalise(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Resolver = (hostname: string) => Promise<string[]>;

async function robotsGroups(
  origin: string,
  fetchImpl: FetchImpl,
  requested: string[],
  resolver?: Resolver,
): Promise<RobotsGroup[] | "missing"> {
  const robotsUrl = `${origin}/robots.txt`;
  requested.push(robotsUrl);
  try {
    const r = await followRedirects(robotsUrl, {
      readBody: 200_000,
      maxHops: 5,
      fetchImpl,
      resolver,
      userAgent: USER_AGENT,
    });
    if (r.status === 404 || r.status === 410 || r.status >= 400) return "missing";
    return parseRobots(r.body);
  } catch {
    return "missing";
  }
}

function pathAllowed(groups: RobotsGroup[] | "missing", url: string): boolean {
  if (groups === "missing") return true;
  try {
    const u = new URL(url);
    return isAllowed(groups, u.pathname + u.search, ["*", "PRISM-research"]);
  } catch {
    return false;
  }
}

/**
 * Gather own-site (+ own-repo README) evidence for one sample row.
 * Robots first; same-boundary links depth 1, cap 15; thin pages via renderImpl.
 * Never calls the collector / Tavily (D-47, D-60).
 */
export async function gatherOwnSources({
  entry,
  fetchImpl = fetch,
  renderImpl,
  githubToken,
  githubFetchImpl,
  resolver,
}: {
  entry: SampleEntry;
  fetchImpl?: FetchImpl;
  renderImpl: (url: string) => Promise<string>;
  githubToken?: string;
  githubFetchImpl?: GithubFetchImpl;
  /** Injected DNS resolver for tests (production uses followRedirects default). */
  resolver?: Resolver;
}): Promise<GatherPage[]> {
  const boundary = entry.boundary;
  const startUrl = entry.final_url || entry.entry_url;
  if (!String(startUrl).startsWith("https://")) throw new Error(`gatherOwnSources: https only (${startUrl})`);

  const pages: GatherPage[] = [];
  const seen = new Set<string>();
  const requested: string[] = [];
  let startHtml = "";

  let origin: string;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    return pages;
  }

  const groups = await robotsGroups(origin, fetchImpl, requested, resolver);

  const fetchPage = async (url: string, keepHtml = false): Promise<GatherPage | null> => {
    if (!url.startsWith("https://")) return null;
    if (!withinBoundary(url, boundary)) return null;
    if (!pathAllowed(groups, url)) return null;
    const key = url.split("#")[0]!;
    if (seen.has(key)) return null;
    seen.add(key);
    requested.push(url);
    try {
      const r = await followRedirects(url, {
        readBody: 500_000,
        maxHops: 5,
        fetchImpl,
        resolver,
        boundary,
        userAgent: USER_AGENT,
      });
      if (r.status >= 400 || !r.boundaryOk) return null;
      if (keepHtml) startHtml = r.body;
      let text = pageText(r.body);
      let rendered = false;
      if (text.length < THIN_CHARS) {
        try {
          const rt = await renderImpl(r.finalUrl);
          if (rt && rt.length > text.length) {
            text = rt;
            rendered = true;
          }
        } catch {
          // keep HTML text when render fails
        }
      }
      return { url: r.finalUrl, text, fetchedAt: new Date().toISOString(), rendered };
    } catch {
      return null;
    }
  };

  const start = await fetchPage(startUrl, true);
  if (start) pages.push(start);

  const candidates = extractLinks(startHtml, start?.url ?? startUrl).filter(
    (u) => u.startsWith("https://") && withinBoundary(u, boundary) && pathAllowed(groups, u) && !seen.has(u.split("#")[0]!),
  );

  for (const link of candidates) {
    if (pages.length >= PAGE_CAP) break;
    const p = await fetchPage(link);
    if (p) pages.push(p);
  }

  // Own repos: repo-only entry, or repos linked from gathered pages that pass the two-signal rule.
  if (githubToken) {
    const client = createGithubClient({ token: githubToken, fetchImpl: githubFetchImpl ?? fetchImpl });
    const pageTexts = pages.map((p) => p.text);
    const links =
      entry.type_class === "repo-only" && boundary.host === "github.com" && boundary.pathPrefix
        ? (() => {
            const segs = boundary.pathPrefix.replace(/^\//, "").split("/");
            return segs.length >= 2 ? [{ owner: segs[0]!, repo: segs[1]! }] : [];
          })()
        : githubRepoLinks(pageTexts.join("\n")).slice(0, 10);

    for (const link of links) {
      if (pages.length >= PAGE_CAP) break;
      const apiPath = `/repos/${link.owner}/${link.repo}`;
      requested.push(`https://api.github.com${apiPath}`);
      const res = await client.request(apiPath);
      if (res.status !== 200) continue;
      if (entry.type_class !== "repo-only" && !isOwnRepo(link, res.json as any, boundary)) continue;
      const evidence = await fetchRepoEvidence({ ...link, client });
      const readme = decodeGithubText(evidence.readme as any);
      if (!readme) continue;
      pages.push({
        url: `https://github.com/${link.owner}/${link.repo}`,
        text: readme,
        fetchedAt: new Date().toISOString(),
        rendered: false,
      });
    }
  }

  (gatherOwnSources as any)._lastRequested = requested;
  return pages;
}

function itemsSchema(checkIds: string[]) {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            checkId: { type: "string", enum: checkIds },
            url: { type: "string" },
            quote: { type: "string" },
            state: { type: "string", enum: ["pass", "claimed"] },
          },
          required: ["checkId", "url", "quote", "state"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

export function recallListMessages(codebook: Codebook, checkIds: string[], pages: GatherPage[]) {
  const rules = checkIds.map((id) => `### ${id}\n${checkPromptText(codebook, id)}`).join("\n\n");
  const pageBlock = pages.map((p, i) => `--- page ${i + 1}: ${p.url} ---\n${p.text}`).join("\n\n");
  const system =
    "You gather evidence items for a systematic review from the project's own pages only. " +
    "List every clear pass or claimed instance you can quote verbatim from the page texts. " +
    "Each item needs checkId (from the enum), the page url, a short verbatim quote from that page, and state pass or claimed. " +
    "Do not invent quotes. Use only the page texts in the user message. Never invent pipeline states.\n\n" +
    "Codebook rules:\n" +
    rules;
  return [
    { role: "system", content: system },
    { role: "user", content: pageBlock || "(no pages)" },
  ];
}

function chunkPages(pages: GatherPage[], maxChars: number): GatherPage[][] {
  const chunks: GatherPage[][] = [];
  let cur: GatherPage[] = [];
  let size = 0;
  for (const p of pages) {
    const n = p.text.length + p.url.length + 40;
    if (cur.length && size + n > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  if (chunks.length === 0) chunks.push([]);
  return chunks;
}

function parseItems(raw: string, checkIds: Set<string>): RecallItem[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: RecallItem[] = [];
  for (const it of items) {
    if (!checkIds.has(it?.checkId)) continue;
    if (it.state !== "pass" && it.state !== "claimed") continue;
    if (typeof it.url !== "string" || typeof it.quote !== "string") continue;
    if (!it.quote.trim()) continue;
    out.push({ checkId: it.checkId, url: it.url, quote: it.quote, state: it.state });
  }
  return out;
}

/** List evidence items via the gatherer role. Prompt holds codebook + gathered pages only (D-47). */
export async function listItems({
  client,
  role,
  codebook,
  checkIds,
  pages,
  cacheDir,
  projectId,
}: {
  client: { request: (p: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; json: unknown; text?: string }> };
  role: RoleSpec;
  codebook: Codebook;
  checkIds: string[];
  pages: GatherPage[];
  cacheDir?: string;
  projectId?: string;
}): Promise<RecallItem[]> {
  assertIndependent("gatherer", role.model);
  const schema = itemsSchema(checkIds);
  const idSet = new Set(checkIds);
  const chunks = chunkPages(pages, CHUNK_CHARS);
  const all: RecallItem[] = [];
  const cache = cacheDir ?? defaultCacheDir();
  const pid = projectId ?? "recall";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const messages = recallListMessages(codebook, checkIds, chunk);
    const body = buildChatBody({
      model: role.model,
      messages,
      mode: "json_schema",
      schema: { name: "recall_items", schema, strict: true },
      thinking: role.reasoning === true,
      ...(typeof role.reasoning === "string" ? { reasoningEffort: role.reasoning } : {}),
      maxTokens: 8192,
    });
    const req = { provider: role.provider, model: role.model, req: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    const { value } = await withStageCache(cache, pid, "recall-items", req, async () => {
      const res = await client.request("/chat/completions", { method: "POST", body });
      if (isQuotaResponse(res)) throw new QuotaStop(res.status, `quota stop status ${res.status}`);
      if (!res.ok) throw new Error(`recall listItems status ${res.status}`);
      const content = (res.json as any)?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("recall listItems missing content");
      return content;
    });
    all.push(...parseItems(value, idSet));
  }
  return all;
}

/** Drop items whose normalised quote is not in the matching page's text. */
export function verifyItems(
  items: RecallItem[],
  pages: GatherPage[],
): { kept: VerifiedItem[]; droppedNonVerbatim: number } {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  let droppedNonVerbatim = 0;
  const kept: VerifiedItem[] = [];
  for (const it of items) {
    const page =
      byUrl.get(it.url) ??
      pages.find((p) => normalise(p.text).includes(normalise(it.quote))) ??
      null;
    if (!page || !normalise(page.text).includes(normalise(it.quote))) {
      droppedNonVerbatim += 1;
      continue;
    }
    kept.push({ ...it, pageUrl: page.url });
  }
  return { kept, droppedNonVerbatim };
}

/** Match verified items against the collector's redacted snapshot corpus. */
export function matchItems(
  items: VerifiedItem[],
  { collectedText, snapshotUrls }: { collectedText: string; snapshotUrls: string[] },
): MatchedItem[] {
  const corpus = normalise(collectedText);
  const urlSet = new Set(snapshotUrls);
  return items.map((it) => {
    const redactedQuote = redactText(it.quote).text;
    const needle = normalise(redactedQuote);
    const found = needle.length > 0 && corpus.includes(needle);
    let missKind: "missedPage" | "changedText" | null = null;
    if (!found) {
      missKind = urlSet.has(it.url) || urlSet.has(it.pageUrl) ? "changedText" : "missedPage";
    }
    return { ...it, found, missKind };
  });
}

export function recallFigure(perProject: ProjectRecall[]): RecallFigure {
  const items = perProject.reduce((s, p) => s + p.items, 0);
  const found = perProject.reduce((s, p) => s + p.found, 0);
  const droppedNonVerbatim = perProject.reduce((s, p) => s + p.droppedNonVerbatim, 0);
  const recall = items === 0 ? 0 : found / items;
  return {
    projects: perProject.length,
    items,
    found,
    recall,
    wilson95: wilson(found, items),
    bar: RECALL_BAR,
    withinThreshold: recall >= RECALL_BAR,
    droppedNonVerbatim,
    perProject,
  };
}

/** Load collector corpus for a project (redacted snapshot text + URLs + dates). */
export function collectorCorpus(
  dataDir: string,
  projectN: number,
): { collectedText: string; snapshotUrls: string[]; collectorFetchedAt: string | null } {
  const manPath = path.join(dataDir, "pipeline", "manifests", `${projectN}.json`);
  const m = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const snapshotUrls: string[] = (m.snapshots ?? []).map((s: { url: string }) => s.url);
  const texts: string[] = [];
  let collectorFetchedAt: string | null = null;
  for (const h of m.snapshotHashesInCollectionOrder ?? []) {
    const snap = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "snapshots", `${h}.json`), "utf8"));
    texts.push(snap.redactedText ?? "");
    if (!collectorFetchedAt && snap.retrievedAt) collectorFetchedAt = snap.retrievedAt;
  }
  // Spans path also covers empty-hash edge cases.
  if (texts.length === 0) {
    for (const s of projectSpans(dataDir, projectN)) texts.push(s.text);
  }
  return { collectedText: texts.join("\n"), snapshotUrls, collectorFetchedAt };
}

export type RecallAction =
  | { kind: "none" }
  | {
      kind: "widened-remeasure";
      settings: { collector: string; pageCap: number };
      remeasured: { recall: number; wilson95: [number, number] };
      creditsSpent: number;
      decision?: "apply-to-sample" | "wording-only";
    };

function writeRecallJson(dataDir: string, payload: unknown): void {
  const dir = path.join(dataDir, "validation");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "recall.json"), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function githubTokenFromEnv(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A7.11 widened re-measure using the free own-site collector (D-66: no Tavily).
 * Writes only under validation/recall-widened/.
 */
export async function widenedRemeasure({
  dataDir,
  entries,
  verifiedByHn,
  pageCap = WIDENED_OWN_SITE_PAGE_CAP,
  fetchImpl = fetch,
  renderImpl,
  resolver,
}: {
  dataDir: string;
  entries: SampleEntry[];
  verifiedByHn: Map<string, VerifiedItem[]>;
  pageCap?: number;
  fetchImpl?: FetchImpl;
  renderImpl?: (url: string) => Promise<string>;
  resolver?: Resolver;
}): Promise<{
  action: Extract<RecallAction, { kind: "widened-remeasure" }>;
  outDir: string;
}> {
  const outDir = path.join(dataDir, "validation", "recall-widened");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const perProject: ProjectRecall[] = [];

  for (const entry of entries) {
    const projectDir = path.join(outDir, String(entry.n));
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const collected = await collectOwnSitePages({
      boundary: entry.boundary,
      startUrl: entry.final_url || entry.entry_url,
      fetchImpl,
      pageCap,
      resolver,
    });
    const pages = collected.pages ?? [];
    const redactedParts: string[] = [];
    const urls: string[] = [];
    for (const p of pages) {
      let text = p.rawText ?? "";
      if (renderImpl && text.length < THIN_CHARS) {
        const rt = await renderImpl(p.url);
        if (rt && rt.length > text.length) text = rt;
      }
      const red = redactText(text).text;
      redactedParts.push(red);
      urls.push(p.url);
      fs.writeFileSync(
        path.join(projectDir, `${crypto.createHash("sha256").update(p.url).digest("hex").slice(0, 16)}.json`),
        JSON.stringify({ url: p.url, redactedText: red }),
        { mode: 0o600 },
      );
    }
    const items = verifiedByHn.get(entry.hn_id) ?? [];
    const matched = matchItems(items, { collectedText: redactedParts.join("\n"), snapshotUrls: urls });
    perProject.push({
      hnId: entry.hn_id,
      projectN: entry.n,
      items: matched.length,
      found: matched.filter((m) => m.found).length,
      droppedNonVerbatim: 0,
    });
  }

  const fig = recallFigure(perProject);
  const action: Extract<RecallAction, { kind: "widened-remeasure" }> = {
    kind: "widened-remeasure",
    settings: { collector: "own-site-v1-widened", pageCap },
    remeasured: { recall: fig.recall, wilson95: fig.wilson95 },
    creditsSpent: 0,
    decision: fig.withinThreshold ? "apply-to-sample" : "wording-only",
  };
  fs.writeFileSync(path.join(outDir, "remeasure.json"), JSON.stringify({ figure: fig, action }, null, 2), {
    mode: 0o600,
  });
  return { action, outDir };
}

export async function runRecallCli(argv = process.argv.slice(2)): Promise<void> {
  const dataDir = resolveDataDir();
  const cacheDir = defaultCacheDir();
  const recallPath = path.join(dataDir, "validation", "recall.json");
  const widened = argv.includes("--widened");

  if (widened) {
    if (!fs.existsSync(recallPath)) throw new Error(`missing ${recallPath}; run recall first`);
    const payload = JSON.parse(fs.readFileSync(recallPath, "utf8"));
    if (payload.figure?.withinThreshold) {
      payload.action = { kind: "none" } satisfies RecallAction;
      payload.wording = null;
      writeRecallJson(dataDir, payload);
      console.log(`RECALL-ACTION ${payload.action.kind} ${payload.wording}`);
      return;
    }
    const subsets = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-subsets.json"), "utf8"));
    const sample: SampleEntry[] = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), "utf8"));
    const byHn = new Map(sample.map((r) => [r.hn_id, r]));
    const entries = (subsets.recall as string[]).map((id) => {
      const e = byHn.get(id);
      if (!e) throw new Error(`recall id ${id} missing from sample`);
      return e;
    });
    const verifiedByHn = new Map<string, VerifiedItem[]>();
    for (const rec of payload.records ?? []) {
      verifiedByHn.set(rec.hnId, (rec.items ?? []).filter((it: MatchedItem) => it.quote));
    }
    // Prefer free-collector widened rematch (D-66); never call Tavily here.
    const { renderTextAsync } = await import("../evidence/render.ts");
    const { action } = await widenedRemeasure({
      dataDir,
      entries,
      verifiedByHn,
      renderImpl: renderTextAsync,
    });
    payload.action = action;
    payload.wording =
      action.decision === "apply-to-sample" ? null : "not found by the collector";
    writeRecallJson(dataDir, payload);

    const decisionsDir = path.join(dataDir, "decisions");
    fs.mkdirSync(decisionsDir, { recursive: true, mode: 0o700 });
    const docPath = path.join(decisionsDir, "collection-recall-action-a7.11.md");
    const doc = [
      "# Collection recall action (A7.11)",
      "",
      `Initial recall: ${payload.figure.recall} (wilson ${JSON.stringify(payload.figure.wilson95)})`,
      `withinThreshold: ${payload.figure.withinThreshold}`,
      "",
      `Action: ${action.kind}`,
      `Settings: ${JSON.stringify(action.settings)}`,
      `Remeasured recall: ${action.remeasured.recall}`,
      `creditsSpent: ${action.creditsSpent}`,
      `decision: ${action.decision}`,
      `wording: ${payload.wording}`,
      "",
      "D-66: widened rematch used free own-site collector (pageCap raised); no Tavily credits spent.",
      "",
    ].join("\n");
    fs.writeFileSync(docPath, doc, { mode: 0o600 });
    // Sign via subprocess so the CLI path matches production.
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/pipeline/signoff/signoff.ts",
        "--doc",
        docPath,
        "--context",
        "protocol/PROTOCOL.md",
        "--item",
        "Collection recall action (A7.11)",
      ],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    console.log(`RECALL-ACTION ${payload.action.kind} ${payload.wording}`);
    return;
  }

  // Primary path: gather then list BEFORE reading collector corpus into the model prompt.
  const subsets = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-subsets.json"), "utf8"));
  const sample: SampleEntry[] = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), "utf8"));
  const byHn = new Map(sample.map((r) => [r.hn_id, r]));
  const role = ROLE_CONFIG.gatherer;
  assertIndependent("gatherer", role.model);
  const client = roleClient("gatherer");
  const codebook = loadCodebook(path.join(process.cwd(), "codebook.md"));
  const checkIds = loadGateFile(resolveGatesPath()).checkIds;

  const { renderTextAsync } = await import("../evidence/render.ts");
  const ghToken = githubTokenFromEnv();
  const records: any[] = [];
  const perProject: ProjectRecall[] = [];
  let stopped = false;

  for (const hnId of subsets.recall as string[]) {
    const entry = byHn.get(hnId);
    if (!entry) throw new Error(`recall id ${hnId} missing from sample`);
    try {
      const pages = await gatherOwnSources({
        entry,
        renderImpl: renderTextAsync,
        githubToken: ghToken,
      });
      const listed = await listItems({
        client: client as any,
        role,
        codebook,
        checkIds,
        pages,
        cacheDir,
        projectId: hnId,
      });
      const { kept, droppedNonVerbatim } = verifyItems(listed, pages);
      // Collector corpus AFTER gather/list — never fed to the gatherer prompt.
      const corpus = collectorCorpus(dataDir, entry.n);
      const matched = matchItems(kept, {
        collectedText: corpus.collectedText,
        snapshotUrls: corpus.snapshotUrls,
      });
      records.push({
        hnId,
        projectN: entry.n,
        provider: role.provider,
        model: role.model,
        gatherFetchedAt: pages[0]?.fetchedAt ?? null,
        collectorFetchedAt: corpus.collectorFetchedAt,
        pages: pages.map((p) => ({ url: p.url, chars: p.text.length, rendered: p.rendered, fetchedAt: p.fetchedAt })),
        items: matched,
        droppedNonVerbatim,
      });
      perProject.push({
        hnId,
        projectN: entry.n,
        items: matched.length,
        found: matched.filter((m) => m.found).length,
        droppedNonVerbatim,
      });
    } catch (e) {
      if (e instanceof QuotaStop) {
        stopped = true;
        console.error(`QuotaStop: ${e.message}`);
        break;
      }
      throw e;
    }
  }

  const figure = recallFigure(perProject);
  const payload = {
    provider: role.provider,
    model: role.model,
    seed: subsets.seeds?.collectionRecall ?? subsets.seeds?.recall ?? "cc45c03dd0094b92",
    recallIds: subsets.recall,
    figure,
    records,
    stopped,
    action: undefined as RecallAction | undefined,
    wording: undefined as string | null | undefined,
  };

  // If already within threshold, record action none here so Task 3 is a no-op.
  if (figure.withinThreshold) {
    payload.action = { kind: "none" };
    payload.wording = null;
  }

  writeRecallJson(dataDir, payload);
  console.log(
    `RECALL: ${JSON.stringify({
      projects: figure.projects,
      items: figure.items,
      found: figure.found,
      recall: figure.recall,
      wilson95: figure.wilson95,
      withinThreshold: figure.withinThreshold,
      droppedNonVerbatim: figure.droppedNonVerbatim,
      provider: role.provider,
      model: role.model,
    })}`,
  );
  if (stopped) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runRecallCli().catch((err) => {
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  });
}
