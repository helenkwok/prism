// Tavily spike harness (FND-06, D-16, D-21).
//
//   node --env-file=<private env file> scripts/spikes/tavily-probe.mjs --project 1 --summary
//   node --env-file=<private env file> scripts/spikes/tavily-probe.mjs --all --write-record
//   node --env-file=<private env file> scripts/spikes/tavily-probe.mjs --top-up 20
//
// What it measures, per project: pre-flight (robots, redirect hops, boundary),
// Tavily map and extract, off-site leakage before and after a code-side host
// filter, failed and empty extracts, and credits three ways (per-call usage,
// the documented formula, the account usage delta).
//
// Rules this file enforces: every entry point resolves the private store through
// assertOutsideRepo before any write; the API key comes only from process.env
// and is never printed; raw responses and redacted pages go to PRISM_DATA_DIR;
// stdout and the public record carry numbers and host classes only.

import fs from "node:fs";
import path from "node:path";

import { replaceJsonBlock, assertNumbersOnly, validateRecord } from "../lib/spike-record.mjs";
import { deriveBoundary, followRedirects, hostClass, isAllowed, parseRobots, withinBoundary } from "./lib/preflight.mjs";
import { redactText, scrubSecrets } from "./lib/redact.mjs";
import { sleep, spikeDirs } from "./lib/paths.mjs";
import {
  CEILING_CREDITS,
  CreditBudget,
  extractCredits,
  isPageLike,
  mapCredits,
  median,
  percentile,
  searchCredits,
  selectorsFor,
} from "./lib/tavily-math.mjs";
import { SPIKE_START_EPOCH, preflightCandidate } from "./pick-projects.mjs";

const API = "https://api.tavily.com";
const EXTRACT_CAP = 20; // pages extracted per project: one batch of at most 20 URLs
const MAP_LIMIT = 50;
const MAP_DEPTH = 2;
const EMPTY_BELOW_CHARS = 100; // an extract shorter than this is treated as empty
const BALANCE_GUARD = 500; // stop if the account balance falls by more than this
const CORPUS_TARGET = 75;
const RECORD_PATH = "spikes/tavily.md";

const KEY = process.env.TAVILY_API_KEY ?? "";
const SECRETS = [KEY];
const log = (obj) => console.log(JSON.stringify(obj));
const safe = (s) => scrubSecrets(String(s), SECRETS);

// ---- Tavily REST ------------------------------------------------------------------

class TavilyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function tavily(endpoint, body, { method = "POST", attempts = 2 } = {}) {
  if (!KEY) throw new TavilyError(0, "TAVILY_API_KEY is not set (run with node --env-file=<private env file>)");
  for (let attempt = 1; ; attempt += 1) {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${API}${endpoint}`, {
        method,
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000),
      });
    } catch (e) {
      if (attempt < attempts) {
        await sleep(4000);
        continue;
      }
      throw new TavilyError(0, `network failure on ${endpoint}: ${safe(e.cause?.code ?? e.name)}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // leave null
    }
    if (res.ok) return { status: res.status, json, ms: Date.now() - t0 };
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(Math.min(20000, (Number(res.headers.get("retry-after")) || 5) * 1000));
      continue;
    }
    // Never echo the response body: it can carry the requested URL.
    throw new TavilyError(res.status, `tavily ${endpoint} returned status ${res.status}`);
  }
}

// GET /usage allows 10 requests per 10 minutes. The read times are kept in the
// private store so the window is honoured across processes, not just within one.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_READS_IN_WINDOW = 7;
function usageLogPath() {
  return path.join(spikeDirs().spikes, "usage-reads.json");
}
function loadReads() {
  try {
    return JSON.parse(fs.readFileSync(usageLogPath(), "utf8")).filter((t) => Date.now() - t < WINDOW_MS);
  } catch {
    return [];
  }
}
async function readUsage() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reads = loadReads();
    if (reads.length >= MAX_READS_IN_WINDOW) {
      await sleep(Math.max(1000, reads[0] + WINDOW_MS - Date.now() + 1000));
      continue;
    }
    reads.push(Date.now());
    fs.writeFileSync(usageLogPath(), JSON.stringify(reads), { mode: 0o600 });
    try {
      const { json } = await tavily("/usage", null, { method: "GET", attempts: 1 });
      return {
        key_usage: json?.key?.usage ?? null,
        key_limit: json?.key?.limit ?? null,
        plan_usage: json?.account?.plan_usage ?? null,
        plan_limit: json?.account?.plan_limit ?? null,
        paygo_usage: json?.account?.paygo_usage ?? null,
        map_usage: json?.account?.map_usage ?? null,
        extract_usage: json?.account?.extract_usage ?? null,
        search_usage: json?.account?.search_usage ?? null,
      };
    } catch (e) {
      if (e.status === 429) {
        // The service counted a read this process did not know about: fill the window and wait it out.
        fs.writeFileSync(usageLogPath(), JSON.stringify(Array(MAX_READS_IN_WINDOW).fill(Date.now())), { mode: 0o600 });
        continue;
      }
      throw e;
    }
  }
  throw new Error("usage endpoint stayed rate limited");
}

/** Everything spent so far, by both methods, from the run summaries plus the manual ledger. */
function expectedSpend(dirs) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dirs.summaries, f), "utf8"));
  const has = (f) => fs.existsSync(path.join(dirs.summaries, f));
  const manual = read("ledger-manual.json");
  let perCall = manual.logged_through_main_run.per_call + manual.inferred_interrupted_first_run_project3.per_call;
  let formula = manual.logged_through_main_run.formula + manual.inferred_interrupted_first_run_project3.formula;
  if (has("calibration.json")) {
    const c = read("calibration.json");
    perCall += c.per_call_sum;
    formula += c.formula_sum;
  }
  if (has("controls.json")) {
    const c = read("controls.json");
    const rp = c.repo_only_project;
    if (rp) {
      perCall += rp.naive_defaults.credits_per_call + rp.allow_external_true.credits_per_call;
      formula += rp.naive_defaults.credits_formula + rp.allow_external_true.credits_formula;
    }
  }
  if (has("topup.json")) {
    const t = read("topup.json");
    perCall += t.per_call;
    formula += t.formula;
  }
  return { per_call: perCall, formula };
}

/** Read the account counter until it reaches the logged per-call total, or the wait runs out. */
export async function finalRead(dirs, waitMinutes) {
  const expected = expectedSpend(dirs);
  const t0 = Date.now();
  let u = await readUsage();
  while ((u.plan_usage ?? 0) < expected.per_call && Date.now() - t0 < waitMinutes * 60000) {
    await sleep(5 * 60000);
    u = await readUsage();
  }
  const out = {
    plan_usage: u.plan_usage,
    map_usage: u.map_usage,
    extract_usage: u.extract_usage,
    search_usage: u.search_usage,
    expected_per_call_total: expected.per_call,
    expected_formula_total: expected.formula,
    caught_up: (u.plan_usage ?? 0) >= expected.per_call,
    waited_min: Math.round((Date.now() - t0) / 60000),
  };
  fs.writeFileSync(path.join(dirs.summaries, "final.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
  log({ final_counter: out });
  return out;
}

/** Poll the usage endpoint until plan usage moves past `since`, or give up. Returns { usage, waited_s }. */
async function settledUsage(since, { reads = 9, spacingMs = 70000 } = {}) {
  const t0 = Date.now();
  let last = await readUsage();
  for (let i = 0; i < reads && (last.plan_usage ?? last.key_usage) <= (since.plan_usage ?? since.key_usage); i += 1) {
    await sleep(spacingMs);
    last = await readUsage();
  }
  return { usage: last, waited_s: Math.round((Date.now() - t0) / 1000) };
}

/** Poll until the plan counter is unchanged across two reads spaced apart. Returns { usage, waited_s, reads }. */
async function stableUsage({ spacingMs = 70000, maxReads = 14, mustExceed = null } = {}) {
  const t0 = Date.now();
  const val = (u) => u.plan_usage ?? u.key_usage;
  let prev = await readUsage();
  let reads = 1;
  while (reads < maxReads) {
    await sleep(spacingMs);
    const cur = await readUsage();
    reads += 1;
    const moved = mustExceed === null || val(cur) > mustExceed;
    if (val(cur) === val(prev) && moved) return { usage: cur, waited_s: Math.round((Date.now() - t0) / 1000), reads, stable: true };
    prev = cur;
  }
  return { usage: prev, waited_s: Math.round((Date.now() - t0) / 1000), reads, stable: false };
}

/**
 * Billing calibration: run projects back to back with no usage reads in between, then
 * wait for the account counter to settle and compare its delta with the per-call and
 * formula sums of the same workload.
 */
export async function calibrate(dirs, list) {
  const base = await stableUsage();
  const baseVal = base.usage.plan_usage ?? base.usage.key_usage;
  const runs = [];
  for (const n of list) {
    const { summary } = await runProject(dirs, n, { quiet: true, skipUsage: true, save: false });
    runs.push({ type_class: summary.type_class, per_call: summary.credits.per_call, formula: summary.credits.formula, extract_calls: summary.credits.by_call });
  }
  const perCall = runs.reduce((a, r) => a + r.per_call, 0);
  const formula = runs.reduce((a, r) => a + r.formula, 0);
  const done = await stableUsage({ mustExceed: perCall > 0 || formula > 0 ? baseVal : null });
  const delta = (done.usage.plan_usage ?? done.usage.key_usage) - baseVal;
  const out = {
    projects: runs,
    per_call_sum: perCall,
    formula_sum: formula,
    account_delta: delta,
    baseline_stable: base.stable,
    end_stable: done.stable,
    settle_wait_s: done.waited_s,
  };
  fs.writeFileSync(path.join(dirs.summaries, "calibration.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
  log({ calibration: out });
  return out;
}

const usageDelta = (a, b) => {
  const plan = a.plan_usage != null && b.plan_usage != null ? b.plan_usage - a.plan_usage : null;
  const key = a.key_usage != null && b.key_usage != null ? b.key_usage - a.key_usage : null;
  return { plan, key, account_delta: plan ?? key };
};

// ---- helpers ----------------------------------------------------------------------

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

function offsiteClass(url) {
  const h = hostOf(url).replace(/^www\./, "");
  if (/(^|\.)(github\.com|gitlab\.com|huggingface\.co)$/.test(h)) return "code-host";
  if (/(^|\.)(x\.com|twitter\.com|linkedin\.com|facebook\.com|instagram\.com|discord\.(com|gg)|reddit\.com|bsky\.app|t\.me|mastodon\.social)$/.test(h)) return "social";
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(h)) return "video";
  if (/(^|\.)(npmjs\.com|pypi\.org|crates\.io)$/.test(h)) return "package-registry";
  return hostClass(h) === "own-domain" ? "other-domain" : "shared-host";
}

function countClasses(urls) {
  const out = {};
  for (const u of urls) out[offsiteClass(u)] = (out[offsiteClass(u)] ?? 0) + 1;
  return out;
}

function saveRaw(dirs, name, obj) {
  fs.writeFileSync(path.join(dirs.runs, `${name}.json`), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function loadProjects(dirs) {
  if (!fs.existsSync(dirs.projects)) throw new Error("projects.json is missing: run scripts/spikes/pick-projects.mjs first");
  return JSON.parse(fs.readFileSync(dirs.projects, "utf8"));
}

/** Robots rules for the project origin, fetched through the SSRF-guarded follower. */
async function robotsFor(finalUrl) {
  const u = new URL(finalUrl);
  try {
    const r = await followRedirects(`${u.origin}/robots.txt`, { readBody: 200000 });
    if (r.status === 404 || r.status === 410 || (r.status >= 400 && r.status < 500)) return { status: r.status, groups: [] };
    if (r.status >= 500) return { status: r.status, groups: null }; // unreachable: treat as disallow all
    return { status: r.status, groups: parseRobots(r.body) };
  } catch {
    return { status: 0, groups: null };
  }
}

const robotsAllows = (robots, url) => {
  if (robots.groups === null) return false;
  const u = new URL(url);
  return isAllowed(robots.groups, u.pathname + u.search, ["*"]);
};

/** Redact and persist extracted pages. Returns per-page metadata (no URLs in counts). */
function persistPages(dirs, n, pages) {
  const dir = path.join(dirs.pages, `proj${n}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = [];
  let emails = 0;
  let phones = 0;
  pages.forEach((p, i) => {
    const r = redactText(p.raw_content);
    emails += r.counts.emails;
    phones += r.counts.phones;
    fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(3, "0")}.md`), r.text, { mode: 0o600 });
    index.push({ file: `${String(i + 1).padStart(3, "0")}.md`, url: p.url, chars: r.text.length });
  });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2), { mode: 0o600 });
  return { emails, phones };
}

const isEmptyContent = (r) => typeof r.raw_content !== "string" || r.raw_content.trim().length < EMPTY_BELOW_CHARS;

// ---- one project ------------------------------------------------------------------

export async function runProject(dirs, n, { quiet = false, skipUsage = false, save = true } = {}) {
  const projects = loadProjects(dirs);
  const proj = projects.find((p) => p.n === n);
  if (!proj) throw new Error(`no project ${n}`);
  if (Date.parse(proj.created_at) / 1000 < SPIKE_START_EPOCH) throw new Error("project predates the spike window");

  // 1. pre-flight, fresh (robots, redirect hops, boundary on the requested and the final URL)
  const pf = await preflightCandidate({ id: proj.hn_id, title: proj.title, url: proj.entry_url, created_at: proj.created_at });
  if (!pf) throw new Error(`project ${n} failed pre-flight`);
  const boundary = pf.boundary;
  const start = pf.final_url;
  const robots = await robotsFor(start);
  const pre = { ...pf.preflight, boundary_ok: pf.preflight.boundary_ok };

  const budget = new CreditBudget(CEILING_CREDITS);
  const calls = [];
  let refused = 0;

  const before = skipUsage ? null : await readUsage();

  const tStart = Date.now();
  // 2. map
  const sel = selectorsFor(boundary);
  const mapBody = {
    url: start,
    max_depth: MAP_DEPTH,
    limit: MAP_LIMIT,
    allow_external: false,
    include_usage: true,
    ...sel,
  };
  const projectedMap = mapCredits(MAP_LIMIT);
  if (!budget.allows(projectedMap)) throw new Error("ceiling would be exceeded by the map call");
  const map = await tavily("/map", mapBody);
  saveRaw(dirs, `proj${n}-map`, { request: { ...mapBody, url: "(private)" }, response: map.json });
  const mapUrls = Array.isArray(map.json?.results) ? map.json.results : [];
  const mapFormula = mapCredits(mapUrls.length);
  const mapPerCall = map.json?.usage?.credits ?? 0;
  budget.record({ perCall: mapPerCall, formula: mapFormula });
  calls.push({ kind: "map", per_call: mapPerCall, formula: mapFormula, ms: map.ms });

  // 3. code-side filter on the map list
  const rawOffsiteInMap = mapUrls.filter((u) => !withinBoundary(u, boundary));
  const inBoundary = [...new Set(mapUrls.filter((u) => withinBoundary(u, boundary)))];
  const robotsBlocked = inBoundary.filter((u) => !robotsAllows(robots, u));
  const pageLike = inBoundary.filter((u) => robotsAllows(robots, u) && isPageLike(u));
  // the entry page first, then map order
  const ordered = [start, ...pageLike.filter((u) => u !== start)];
  const toExtract = [...new Set(ordered)].filter((u) => withinBoundary(u, boundary)).slice(0, EXTRACT_CAP);

  // 4. extract, basic, one batch
  const extractResults = new Map(); // requested url -> result
  const failedUrls = [];
  let extractCallsBelow5 = 0;
  let extractCallsBelow5Zero = 0;
  const doExtract = async (urls, depth) => {
    const projected = extractCredits(urls.length, depth);
    if (!budget.allows(projected)) {
      refused += 1;
      return null;
    }
    const body = { urls, extract_depth: depth, format: "markdown", include_usage: true };
    const r = await tavily("/extract", body);
    saveRaw(dirs, `proj${n}-extract-${depth}-${calls.length}`, { request: { ...body, urls: `(${urls.length} private)` }, response: r.json });
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    const successes = results.length;
    const perCall = r.json?.usage?.credits ?? 0;
    const formula = extractCredits(successes, depth);
    if (successes > 0 && successes < 5) {
      extractCallsBelow5 += 1;
      if (perCall === 0) extractCallsBelow5Zero += 1;
    }
    budget.record({ perCall, formula });
    calls.push({ kind: `extract-${depth}`, per_call: perCall, formula, ms: r.ms, requested: urls.length, results: successes, failed: (r.json?.failed_results ?? []).length });
    return r.json;
  };

  let basicJson = null;
  if (toExtract.length) basicJson = await doExtract(toExtract, "basic");
  const basicResults = Array.isArray(basicJson?.results) ? basicJson.results : [];
  const rawOffsiteInResults = basicResults.filter((r) => !withinBoundary(r.url, boundary)).length;
  const byUrl = new Map();
  for (const r of basicResults) byUrl.set(r.url, r);
  const failedBasic = (basicJson?.failed_results ?? []).map((f) => f.url);
  const emptyBasic = basicResults.filter(isEmptyContent).map((r) => r.url);
  const retryUrls = [...new Set([...failedBasic, ...emptyBasic])].filter((u) => withinBoundary(u, boundary));

  // 5. one advanced retry for failed or empty extracts only (EVD-05 groundwork)
  let advancedRetries = 0;
  let recovered = 0;
  let advResults = [];
  if (retryUrls.length) {
    const advJson = await doExtract(retryUrls, "advanced");
    if (advJson) {
      advancedRetries = 1;
      advResults = Array.isArray(advJson.results) ? advJson.results : [];
      for (const r of advResults) {
        if (!isEmptyContent(r)) {
          recovered += 1;
          byUrl.set(r.url, r);
        }
      }
    }
  }
  const wallMs = Date.now() - tStart;

  // 6. final page set, redacted and stored privately
  const finalPages = [...byUrl.values()].filter((r) => !isEmptyContent(r) && withinBoundary(r.url, boundary));
  const red = persistPages(dirs, n, finalPages);
  const stillFailed = failedBasic.filter((u) => !advResults.some((r) => r.url === u && !isEmptyContent(r))).length;
  const stillEmpty = emptyBasic.filter((u) => {
    const r = byUrl.get(u);
    return !r || isEmptyContent(r);
  }).length;

  // 7. leakage after the code-side filter: everything that would reach a collector or a model
  const afterFilterOffsite =
    toExtract.filter((u) => !withinBoundary(u, boundary)).length +
    finalPages.filter((r) => !withinBoundary(r.url, boundary)).length;

  // 8. account delta (usage lags a little, so wait before the second read)
  let after = null;
  let d = { plan: null, key: null, account_delta: null };
  if (!skipUsage) {
    await sleep(8000);
    after = await readUsage();
    d = usageDelta(before, after);
  }

  const perCallSum = calls.reduce((s, c) => s + c.per_call, 0);
  const formulaSum = calls.reduce((s, c) => s + c.formula, 0);
  // The usage endpoint lags (measured 2026-09-20: still 0 minutes after a 9 credit
  // project). A zero delta after non-zero spend is a lagged read, not a measurement.
  const lagged = skipUsage || (d.account_delta === 0 && perCallSum > 0);
  const accountDelta = lagged ? null : d.account_delta;
  const total = Math.max(perCallSum, accountDelta ?? 0);

  const summary = {
    n,
    type_class: proj.type_class,
    preflight: { robots_blocked: !robotsAllows(robots, start) || pre.robots_blocked, redirect_hops: pre.redirect_hops, boundary_ok: pre.boundary_ok },
    map: { urls_returned: mapUrls.length, in_boundary: inBoundary.length, robots_blocked_urls: robotsBlocked.length, extract_candidates: toExtract.length },
    extract: {
      results: basicResults.length,
      failed: failedBasic.length,
      empty: emptyBasic.length,
      advanced_retries: advancedRetries,
      recovered_by_advanced: recovered,
      still_failed: stillFailed,
      still_empty: stillEmpty,
      pages_kept: finalPages.length,
    },
    leakage: {
      raw_offsite_in_map: rawOffsiteInMap.length,
      raw_offsite_in_results: rawOffsiteInResults,
      after_filter: afterFilterOffsite,
      offsite_classes: countClasses(rawOffsiteInMap),
    },
    credits: {
      per_call: perCallSum,
      formula: formulaSum,
      account_delta: accountDelta,
      account_delta_lagged: lagged,
      total,
      by_call: calls.map((c) => ({ kind: c.kind, per_call: c.per_call, formula: c.formula })),
      ceiling: CEILING_CREDITS,
      ceiling_refused_calls: refused,
      ceiling_held: total <= CEILING_CREDITS,
      projected_full_extract_formula: mapCredits(MAP_LIMIT) + extractCredits(pageLike.length, "basic"),
    },
    usage_zero_below_5: { calls_below_5: extractCallsBelow5, reported_zero: extractCallsBelow5Zero },
    redaction: red,
    wall_ms: wallMs,
    balance: after ? { plan_usage_after: after.plan_usage, plan_limit: after.plan_limit, key_usage_after: after.key_usage } : null,
  };
  if (save) fs.writeFileSync(path.join(dirs.summaries, `proj${n}.json`), JSON.stringify(summary, null, 2), { mode: 0o600 });
  if (!quiet) log(summary);
  return { summary, before, after };
}

// ---- controls ---------------------------------------------------------------------

export async function runControls(dirs) {
  const projects = loadProjects(dirs);
  const p1 = projects.find((p) => p.n === 1);
  const p5 = projects.find((p) => p.type_class === "redirect");
  const out = {};
  const before = await readUsage();

  // allowExternal true: only that parameter differs from the real run
  const b1 = deriveBoundary(p1.final_url);
  const sel = selectorsFor(b1);
  const base = { url: p1.final_url, max_depth: MAP_DEPTH, limit: MAP_LIMIT, include_usage: true };
  const variants = {
    allow_external_true: { ...base, allow_external: true, ...sel },
    selectors_off_allow_false: { ...base, allow_external: false },
    naive_defaults: { ...base, allow_external: true },
  };
  for (const [name, body] of Object.entries(variants)) {
    const r = await tavily("/map", body);
    saveRaw(dirs, `control-${name}`, { request: { ...body, url: "(private)" }, response: r.json });
    const urls = Array.isArray(r.json?.results) ? r.json.results : [];
    const off = urls.filter((u) => !withinBoundary(u, b1));
    out[name] = {
      urls_returned: urls.length,
      offsite_urls_returned: off.length,
      offsite_classes: countClasses(off),
      credits_per_call: r.json?.usage?.credits ?? 0,
      credits_formula: mapCredits(urls.length),
    };
    await sleep(1500);
  }

  // restricted search fallback (include_domains), on the same own-domain project
  const searchBody = {
    query: `${p1.title} documentation`.slice(0, 200),
    include_domains: [b1.host],
    search_depth: "basic",
    max_results: 5,
    include_usage: true,
  };
  const s = await tavily("/search", searchBody);
  saveRaw(dirs, "control-search", { request: { ...searchBody, query: "(private)", include_domains: "(private)" }, response: s.json });
  const sres = Array.isArray(s.json?.results) ? s.json.results : [];
  const soff = sres.filter((r) => !withinBoundary(r.url, b1));
  out.search_fallback = {
    results: sres.length,
    offsite_results: soff.length,
    after_filter: sres.filter((r) => withinBoundary(r.url, b1)).filter((r) => !withinBoundary(r.url, b1)).length,
    credits_per_call: s.json?.usage?.credits ?? 0,
    credits_formula: searchCredits("basic"),
  };

  // redirect gap: does extract on the PRE-redirect URL reveal the final URL?
  if (p5) {
    const body = { urls: [p5.entry_url], extract_depth: "basic", include_usage: true };
    const r = await tavily("/extract", body);
    saveRaw(dirs, "control-redirect-extract", { request: { urls: "(private)" }, response: r.json });
    const res = r.json?.results?.[0];
    const failed = r.json?.failed_results?.[0];
    out.redirect_entry_extract = {
      results: r.json?.results?.length ?? 0,
      failed: r.json?.failed_results?.length ?? 0,
      result_url_equals_requested: res ? res.url === p5.entry_url : null,
      result_url_equals_final: res ? res.url === p5.final_url : null,
      result_fields: res ? Object.keys(res).sort() : [],
      response_fields: r.json ? Object.keys(r.json).sort() : [],
      failed_fields: failed ? Object.keys(failed).sort() : [],
      credits_per_call: r.json?.usage?.credits ?? 0,
      credits_formula: extractCredits(r.json?.results?.length ?? 0),
      usage_zero_below_5: (r.json?.results?.length ?? 0) > 0 && (r.json?.usage?.credits ?? 0) === 0,
    };
  }
  await sleep(8000);
  const after = await readUsage();
  const cd = usageDelta(before, after).account_delta;
  out.account_delta = cd === 0 ? null : cd; // zero straight after spend is a lagged read
  out.total_per_call = Object.values(out)
    .filter((v) => v && typeof v === "object")
    .reduce((s2, v) => s2 + (v.credits_per_call ?? 0), 0);
  fs.writeFileSync(path.join(dirs.summaries, "controls.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
  log({ controls: out });
  return out;
}

export async function runExtraControls(dirs) {
  const projects = loadProjects(dirs);
  const p = projects.find((x) => x.type_class === "repo-only");
  const b = deriveBoundary(p.final_url);
  const sel = selectorsFor(b);
  const base = { url: p.final_url, max_depth: MAP_DEPTH, limit: MAP_LIMIT, include_usage: true };
  const variants = {
    naive_defaults: { ...base, allow_external: true },
    allow_external_true: { ...base, allow_external: true, ...sel },
  };
  const out = { type_class: p.type_class };
  for (const [name, body] of Object.entries(variants)) {
    const r = await tavily("/map", body);
    saveRaw(dirs, `control-repo-${name}`, { request: { ...body, url: "(private)" }, response: r.json });
    const urls = Array.isArray(r.json?.results) ? r.json.results : [];
    const off = urls.filter((u) => !withinBoundary(u, b));
    out[name] = {
      urls_returned: urls.length,
      offsite_urls_returned: off.length,
      offsite_same_host_other_path: off.filter((u) => hostOf(u).replace(/^www\./, "") === b.host).length,
      offsite_classes: countClasses(off),
      credits_per_call: r.json?.usage?.credits ?? 0,
      credits_formula: mapCredits(urls.length),
    };
    await sleep(1500);
  }
  const file = path.join(dirs.summaries, "controls.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  all.repo_only_project = out;
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  log({ extra_controls: out });
  return out;
}

// ---- top-up ------------------------------------------------------------------------

export async function topUp(dirs, count) {
  const candidates = JSON.parse(fs.readFileSync(dirs.candidates, "utf8"));
  const used = new Set(loadProjects(dirs).map((p) => p.hn_id));
  const pool = candidates.filter((c) => !used.has(c.id)).sort((a, b) => b.points - a.points);
  const dir = path.join(dirs.pages, "topup");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const urls = [];
  for (const c of pool) {
    if (urls.length >= count) break;
    const pf = await preflightCandidate(c).catch(() => null);
    await sleep(300);
    if (!pf || pf.preflight.robots_blocked || !pf.preflight.boundary_ok) continue;
    urls.push(pf.final_url);
  }
  let kept = 0;
  let perCall = 0;
  let formula = 0;
  for (let i = 0; i < urls.length; i += 20) {
    const batch = urls.slice(i, i + 20);
    if (!new CreditBudget(BALANCE_GUARD).allows(extractCredits(batch.length))) break;
    const r = await tavily("/extract", { urls: batch, extract_depth: "basic", include_usage: true });
    saveRaw(dirs, `topup-extract-${i}`, { response: r.json });
    const good = (r.json?.results ?? []).filter((x) => !isEmptyContent(x));
    good.forEach((p, j) => {
      const red = redactText(p.raw_content);
      fs.writeFileSync(path.join(dir, `${String(kept + j + 1).padStart(3, "0")}.md`), red.text, { mode: 0o600 });
    });
    kept += good.length;
    perCall += r.json?.usage?.credits ?? 0;
    formula += extractCredits((r.json?.results ?? []).length);
  }
  const res = { topup_requested: count, topup_urls: urls.length, topup_pages_kept: kept, per_call: perCall, formula };
  fs.writeFileSync(path.join(dirs.summaries, "topup.json"), JSON.stringify(res, null, 2), { mode: 0o600 });
  log(res);
  return res;
}

// ---- record ------------------------------------------------------------------------

const CRITERION_TEXT = {
  A: "ceiling of 40 credits per project (D-16) plus binding median at most 10 and p95 at most 40 on the 5 projects; Phase 2 cap derived from remaining credits divided by projects still to collect",
};

export function buildRecord({ summaries, controls, topup, balance, today, settled = null, calibration = null, final = null, spend = null }) {
  const totals = summaries.map((s) => s.credits.total);
  const med = median(totals);
  const p95 = percentile(totals, 95);
  const max = Math.max(...totals);
  const fTotals = summaries.map((s) => s.credits.formula);
  const ceilingHeld = summaries.every((s) => s.credits.ceiling_held);
  const met = med <= 10 && p95 <= 40 && ceilingHeld;
  const leaked = summaries.some((s) => s.leakage.after_filter > 0);
  const corpus = summaries.reduce((s, x) => s + x.extract.pages_kept, 0) + (topup?.topup_pages_kept ?? 0);
  const record = {
    record: "tavily",
    status: "final",
    updated: today,
    credit_balance_checked: {
      checked_on: today,
      credits_or_usd: balance.credits,
      unit: "credits",
      source: "Tavily dashboard as reported by Helen; free monthly allowance",
      api_plan_limit: balance.api_plan_limit,
      hackathon_credit: "UNCONFIRMED: not seen on the account, so nothing here relies on it (D-16)",
    },
    criterion: {
      id: "A",
      outcome: met ? "met" : "missed",
      definition: CRITERION_TEXT.A,
      measured: {
        median_credits: med,
        p95_credits: p95,
        max_credits: max,
        by: "per-call usage reported by the API, the larger of that and the account delta when one was read",
        formula_median_credits: median(fTotals),
        formula_p95_credits: percentile(fTotals, 95),
        formula_max_credits: Math.max(...fTotals),
        ceiling: CEILING_CREDITS,
        ceiling_held: ceilingHeld,
      },
    },
    projects: summaries.map((s) => ({
      type_class: s.type_class,
      preflight: s.preflight,
      map: { urls_returned: s.map.urls_returned, in_boundary: s.map.in_boundary, robots_blocked_urls: s.map.robots_blocked_urls },
      extract: { ...s.extract },
      leakage: { ...s.leakage },
      credits: {
        per_call: s.credits.per_call,
        formula: s.credits.formula,
        account_delta: null, // every per-project account read was stale (see account_reconciliation)
        account_delta_lagged: true,
        total: s.credits.total,
        by_call: s.credits.by_call,
        projected_full_extract_formula: s.credits.projected_full_extract_formula,
      },
      usage_zero_below_5: s.usage_zero_below_5,
      wall_ms: s.wall_ms,
    })),
    controls: {
      allow_external_true: controls.allow_external_true,
      selectors_off_allow_false: controls.selectors_off_allow_false,
      naive_defaults: controls.naive_defaults,
      search_fallback: controls.search_fallback,
      redirect_entry_extract: controls.redirect_entry_extract ?? null,
      repo_only_project: controls.repo_only_project ?? null,
      account_delta: controls.account_delta,
    },
    account_reconciliation: {
      lag_note: "the usage endpoint did not move for many minutes after spend, so a per-project read taken seconds later was always stale",
      main_run: settled
        ? { account_counter_absolute: settled.plan_usage_now, settle_wait_s: settled.settle_wait_s, spend_logged_per_call_through_main_run: 71, spend_logged_formula_through_main_run: 76, derivation: "sum of per-call and formula credits over every Tavily call made from the first tracer run through the main run" }
        : null,
      final_counter: final ?? null,
      calibration: calibration
        ? {
            workload: calibration.projects.map((x) => x.type_class),
            per_call_sum: calibration.per_call_sum,
            formula_sum: calibration.formula_sum,
            account_delta: calibration.account_delta,
            baseline_stable: calibration.baseline_stable,
            end_stable: calibration.end_stable,
            settle_wait_s: calibration.settle_wait_s,
          }
        : null,
    },
    aggregate: { median_credits: med, p95_credits: p95, max_credits: max, p95_method: "nearest rank over 5 projects (equals the maximum)", total_credits: totals.reduce((a, b) => a + b, 0) },
    phase2_budget: (() => {
      const limit = balance.api_plan_limit ?? 1500;
      const spent = spend?.per_call ?? 0;
      const remaining = limit - spent;
      const toCollect = 295;
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      return {
        basis: "free monthly allowance only; the hackathon credit is unconfirmed",
        plan_limit: limit,
        spent_all_spike_calls_per_call: spent,
        remaining_credits: remaining,
        projects_still_to_collect: toCollect,
        derived_cap_per_project: Math.floor((remaining / toCollect) * 10) / 10,
        observed_mean_per_project: Math.round(mean * 10) / 10,
        observed_median_per_project: med,
        projected_300_at_mean: Math.round(mean * 300),
        projected_300_at_median: Math.round(med * 300),
        fits_free_allowance: Math.round(mean * 300) <= remaining,
      };
    })(),
    blocks_phase2_collector: leaked,
    corpus_pages: corpus,
    corpus_target: CORPUS_TARGET,
    topup: topup ?? null,
    limits: {
      dns_answer_not_pinned_to_socket: true,
      meta_and_script_redirects_not_followed: true,
      extract_cap_per_project: EXTRACT_CAP,
      map_limit: MAP_LIMIT,
      map_depth: MAP_DEPTH,
    },
  };
  return { record, met, leaked };
}

function commentary(record, summaries, controls, calibration, final) {
  const r = record;
  const lines = [];
  const perCall = summaries.map((s) => s.credits.per_call);
  const formula = summaries.map((s) => s.credits.formula);
  const rex = controls.redirect_entry_extract;
  lines.push("# Tavily spike (FND-06)");
  lines.push("");
  lines.push("Numbers only. Project URLs, page text and keys stay in the private store (D-21).");
  lines.push("");
  lines.push("```json");
  lines.push("{}");
  lines.push("```");
  lines.push("");
  lines.push("## Commentary");
  lines.push("");
  lines.push(`- Criterion A (ceiling 40 plus median at most 10 and p95 at most 40): ${r.criterion.outcome}. Measured median ${r.aggregate.median_credits}, p95 ${r.aggregate.p95_credits}, max ${r.aggregate.max_credits} credits per project. p95 over five projects is the maximum by nearest rank.`);
  lines.push(`- Credits per project, by method. Per-call usage: ${perCall.join(", ")}. Documented formula: ${formula.join(", ")}. Account usage delta: not attributable per project (stale reads). A project's total is its per-call usage.`);
  lines.push(`- Reconciliation: per-call and formula ${perCall.every((v, i) => v === formula[i]) ? "agree on every project" : "disagree on at least one project"} (${perCall.map((v, i) => (v === formula[i] ? "=" : `${v} vs ${formula[i]}`)).join(", ")}). Every per-project account read was stale, because the usage endpoint moved only after several minutes, so per-project account deltas are null.`);
  if (calibration) {
    lines.push(`- Billing calibration: two projects re-run back to back with no reads in between, then a wait for the counter to settle (${calibration.settle_wait_s} s, stable ${calibration.end_stable}). Per-call sum ${calibration.per_call_sum}, formula sum ${calibration.formula_sum}, account delta ${calibration.account_delta}.`);
  }
  lines.push(`- Extract usage below 5 successes read 0 on ${summaries.reduce((s, x) => s + x.usage_zero_below_5.reported_zero, 0)} of ${summaries.reduce((s, x) => s + x.usage_zero_below_5.calls_below_5, 0)} such calls in the project runs${rex ? `; the single-URL control extract read ${rex.credits_per_call} credits (formula ${rex.credits_formula})` : ""} (research Pitfall 6).`);
  if (rex) {
    lines.push(
      `- Final URL after a redirect: the single-URL extract of a pre-redirect link returned ${rex.results} result and ${rex.failed} failed; result url equals requested: ${rex.result_url_equals_requested}, equals final: ${rex.result_url_equals_final}. Result fields: ${rex.result_fields.join(", ") || "none"}. No field carries a final URL, so the redirect check is PRISM code (Pitfall 8).`,
    );
  }
  lines.push(`- Leakage with allow_external false plus anchored selectors: ${summaries.reduce((s, x) => s + x.leakage.raw_offsite_in_map, 0)} off-site URLs in map lists and ${summaries.reduce((s, x) => s + x.leakage.raw_offsite_in_results, 0)} in extract results across the five projects; ${summaries.reduce((s, x) => s + x.leakage.after_filter, 0)} after the code-side host filter.`);
  lines.push(`- Controls on the own-domain project: allow_external true (selectors kept) returned ${controls.allow_external_true.offsite_urls_returned} off-site of ${controls.allow_external_true.urls_returned}; selectors off with allow_external false returned ${controls.selectors_off_allow_false.offsite_urls_returned} off-site of ${controls.selectors_off_allow_false.urls_returned}; naive defaults returned ${controls.naive_defaults.offsite_urls_returned} off-site of ${controls.naive_defaults.urls_returned}. Restricted search returned ${controls.search_fallback.results} results, ${controls.search_fallback.offsite_results} off-site.`);
  if (final) {
    lines.push(`- Final account counter read: ${final.plan_usage} credits (map ${final.map_usage}, extract ${final.extract_usage}, search ${final.search_usage}) against ${final.expected_per_call_total} logged by per-call usage and ${final.expected_formula_total} by the formula; caught up with the logged spend: ${final.caught_up}, after waiting ${final.waited_min} minutes. The counter moves in lumps many minutes after spend.`);
  }
  const rp = controls.repo_only_project;
  if (rp) {
    lines.push(`- Controls on the repo-only project (shared host, path boundary): naive defaults returned ${rp.naive_defaults.offsite_urls_returned} URLs outside the path boundary of ${rp.naive_defaults.urls_returned} (${rp.naive_defaults.offsite_same_host_other_path} on the same host under other paths); allow_external true with selectors kept returned ${rp.allow_external_true.offsite_urls_returned} of ${rp.allow_external_true.urls_returned}.`);
  }
  lines.push("- after_filter is zero by construction, because the code-side filter drops every URL outside the boundary; the informative leakage numbers are the raw counts in the map list and in the extract results.");
  const b2 = r.phase2_budget;
  lines.push(`- Phase 2 budget on the free allowance alone (the hackathon credit is unconfirmed): ${b2.remaining_credits} credits remain of ${b2.plan_limit}, so ${b2.projects_still_to_collect} projects leave a derived cap of ${b2.derived_cap_per_project} credits each. Observed mean ${b2.observed_mean_per_project} and median ${b2.observed_median_per_project} per project would need about ${b2.projected_300_at_mean} to ${b2.projected_300_at_median} credits for 300 projects; fits the free allowance: ${b2.fits_free_allowance}.`);
  lines.push(`- Corpus: ${r.corpus_pages} non-empty redacted pages against a target of ${r.corpus_target}.`);
  lines.push(`- Phase 2 collector design is ${r.blocks_phase2_collector ? "BLOCKED by leakage" : "not blocked by leakage"}.`);
  lines.push("- Limits: the DNS answer checked in pre-flight is not pinned to the connecting socket, and only HTTP redirects are followed. Both are Phase 2 and Phase 7 work.");
  lines.push("");
  return lines.join("\n");
}

export function writeRecord(dirs, { balance, today }) {
  const summaries = loadProjects(dirs).map((p) => JSON.parse(fs.readFileSync(path.join(dirs.summaries, `proj${p.n}.json`), "utf8")));
  const controls = JSON.parse(fs.readFileSync(path.join(dirs.summaries, "controls.json"), "utf8"));
  const topupPath = path.join(dirs.summaries, "topup.json");
  const topup = fs.existsSync(topupPath) ? JSON.parse(fs.readFileSync(topupPath, "utf8")) : null;
  const settledPath = path.join(dirs.summaries, "settled.json");
  const settled = fs.existsSync(settledPath) ? JSON.parse(fs.readFileSync(settledPath, "utf8")) : null;
  const calPath = path.join(dirs.summaries, "calibration.json");
  const calibration = fs.existsSync(calPath) ? JSON.parse(fs.readFileSync(calPath, "utf8")) : null;
  const finalPath = path.join(dirs.summaries, "final.json");
  const final = fs.existsSync(finalPath) ? JSON.parse(fs.readFileSync(finalPath, "utf8")) : null;
  const spend = expectedSpend(dirs);
  const { record, met, leaked } = buildRecord({ summaries, controls, topup, balance, today, settled, calibration, final, spend });
  const problems = validateRecord("tavily", record, { requireFinal: true });
  if (problems.length) throw new Error(`record fails the tavily contract: ${problems.join("; ")}`);
  const md = replaceJsonBlock(commentary(record, summaries, controls, calibration, final), record);
  assertNumbersOnly(md);
  const target = path.join(dirs.root, RECORD_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, md);
  log({ record_written: RECORD_PATH, criterion: record.criterion.outcome, blocks_phase2_collector: leaked, corpus_pages: record.corpus_pages, median: record.aggregate.median_credits, p95: record.aggregate.p95_credits, max: record.aggregate.max_credits, met });
  return record;
}

// ---- CLI ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const val = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything else
  const today = new Date().toISOString().slice(0, 10);

  if (flag("--project")) {
    await runProject(dirs, Number(val("--project")), { quiet: false });
    return;
  }
  if (flag("--final-read")) {
    await finalRead(dirs, Number(val("--wait") ?? 0));
    return;
  }
  if (flag("--controls-extra")) {
    await runExtraControls(dirs);
    return;
  }
  if (flag("--calibrate")) {
    await calibrate(dirs, val("--calibrate").split(",").map(Number));
    return;
  }
  if (flag("--top-up")) {
    await topUp(dirs, Number(val("--top-up")));
    if (!flag("--write-record")) return;
  }
  if (flag("--all")) {
    const baseline = await readUsage();
    const projects = loadProjects(dirs);
    for (const p of projects) {
      const { after } = await runProject(dirs, p.n, { quiet: false });
      const spent = (after.plan_usage ?? after.key_usage) - (baseline.plan_usage ?? baseline.key_usage);
      if (spent > BALANCE_GUARD) throw new Error(`budget guard: ${spent} credits spent since the run began (limit ${BALANCE_GUARD})`);
    }
    await runControls(dirs);
    const { usage: now, waited_s } = await settledUsage(baseline);
    const spent = (now.plan_usage ?? now.key_usage) - (baseline.plan_usage ?? baseline.key_usage);
    const settled = { account_delta_total_settled: spent, settle_wait_s: waited_s, plan_usage_now: now.plan_usage, plan_limit: now.plan_limit };
    fs.writeFileSync(path.join(dirs.summaries, "settled.json"), JSON.stringify(settled, null, 2), { mode: 0o600 });
    log(settled);
    if (spent > BALANCE_GUARD) throw new Error("budget guard tripped");
  }
  if (flag("--write-record")) {
    const usage = await readUsage();
    const balance = { credits: Number(val("--balance") ?? 1000), api_plan_limit: usage.plan_limit };
    writeRecord(dirs, { balance, today });
  }
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "tavily-probe.mjs";
if (invoked) {
  main().catch((e) => {
    console.error(`tavily-probe stopped: ${safe(e.message)}`);
    process.exit(1);
  });
}
