// Pick the five spike projects (FND-06) from real public Show HN posts.
//
//   node scripts/spikes/pick-projects.mjs            fetch candidates, pre-flight, write projects.json
//   node scripts/spikes/pick-projects.mjs --fetch-only
//
// Inputs come from the HN Algolia search_by_date endpoint, restricted to posts
// created on or after 2026-09-01T00:00:00Z so they sit outside the D-08 sampling
// frame by construction (research Pitfall 9). The author field is dropped at
// ingest. Output goes to PRISM_DATA_DIR/spikes only; nothing printed carries a URL.

import fs from "node:fs";

import {
  PreflightError,
  deriveBoundary,
  followRedirects,
  hostClass,
  isAllowed,
  parseRobots,
  withinBoundary,
} from "./lib/preflight.mjs";
import { sleep, spikeDirs } from "./lib/paths.mjs";

export const SPIKE_START_EPOCH = 1788220800; // 2026-09-01T00:00:00Z
const ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";
const AI_TITLE = /\b(ai|a\.i\.|llm|llms|agent|agents|agentic|rag|chatbot|neural|diffusion|embedding|embeddings|transformer|inference|prompt|prompts|assistant|ml|gen ?ai|generative)\b/i;

export async function fetchCandidates(nowEpoch = Math.floor(Date.now() / 1000)) {
  const out = new Map();
  const week = 7 * 24 * 3600;
  for (let t0 = SPIKE_START_EPOCH; t0 < nowEpoch; t0 += week) {
    const t1 = Math.min(t0 + week, nowEpoch + 1);
    const u = new URL(ALGOLIA);
    u.searchParams.set("tags", "story,show_hn");
    u.searchParams.set("numericFilters", `created_at_i>=${t0},created_at_i<${t1}`);
    u.searchParams.set("hitsPerPage", "1000");
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`algolia request failed with status ${res.status}`);
    const json = await res.json();
    for (const h of json.hits ?? []) {
      if (!h.url || !h.created_at_i || h.created_at_i < SPIKE_START_EPOCH) continue;
      // author is dropped here and never stored (no founder personal data)
      out.set(h.objectID, {
        id: h.objectID,
        title: h.title,
        url: h.url,
        points: h.points ?? 0,
        created_at: new Date(h.created_at_i * 1000).toISOString(),
      });
    }
    await sleep(1100); // at most one request per second
  }
  return [...out.values()];
}

const SPA_MARKERS = /<div[^>]+id=["'](?:root|app|__next|__nuxt|___gatsby)["']/i;

function visibleTextLength(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

export function looksLikeSpa(html) {
  return SPA_MARKERS.test(html) && visibleTextLength(html) < 600 && (html.match(/<script/gi) ?? []).length >= 1;
}

async function fetchRobots(finalUrl) {
  const u = new URL(finalUrl);
  const robotsUrl = `${u.origin}/robots.txt`;
  try {
    const r = await followRedirects(robotsUrl, { readBody: 200000, maxHops: 5 });
    if (r.status === 404 || r.status === 410) return { status: r.status, allowed: true };
    if (r.status >= 500) return { status: r.status, allowed: false };
    if (r.status >= 400) return { status: r.status, allowed: true };
    const groups = parseRobots(r.body);
    return { status: r.status, allowed: isAllowed(groups, u.pathname + u.search, ["*"]), groups };
  } catch (e) {
    return { status: 0, allowed: false, error: e instanceof PreflightError ? e.code : "network" };
  }
}

/** Pre-flight one candidate. Returns a classification or null when unusable. */
export async function preflightCandidate(c) {
  let entry;
  try {
    entry = new URL(c.url);
  } catch {
    return null;
  }
  if (entry.protocol !== "https:") return null;
  let boundary = deriveBoundary(entry.toString());
  let r;
  try {
    r = await followRedirects(entry.toString(), { boundary, readBody: 300000 });
  } catch {
    return null;
  }
  if (r.status < 200 || r.status >= 300) return null;
  const finalUrl = r.finalUrl;
  const redirectedOffBoundary = !withinBoundary(finalUrl, boundary);
  // The operative boundary follows the FINAL url (research Pitfall 8): the entry
  // link was the requested url, the site it leads to is the project's own site.
  const operative = redirectedOffBoundary ? deriveBoundary(finalUrl) : boundary;
  const robots = await fetchRobots(finalUrl);

  let type;
  const startHostClass = hostClass(entry.hostname);
  if (redirectedOffBoundary) type = "redirect";
  else if (startHostClass === "shared-path-host") type = entry.hostname.replace(/^www\./, "") === "github.com" ? "repo-only" : "shared-host";
  else if (startHostClass === "shared-suffix-host") type = "shared-host";
  else if (looksLikeSpa(r.body)) type = "spa";
  else type = "own-domain";

  return {
    n: 0,
    type_class: type,
    hn_id: c.id,
    title: c.title,
    created_at: c.created_at,
    entry_url: entry.toString(),
    final_url: finalUrl,
    boundary: operative,
    requested_boundary: boundary,
    preflight: {
      robots_blocked: !robots.allowed,
      robots_status: robots.status,
      redirect_hops: r.hops.length - 1,
      boundary_ok: !redirectedOffBoundary,
    },
  };
}

const CLASSES = ["own-domain", "shared-host", "repo-only", "spa", "redirect"];

async function main() {
  const dirs = spikeDirs();
  const fetchOnly = process.argv.includes("--fetch-only");
  let candidates;
  if (fs.existsSync(dirs.candidates) && process.argv.includes("--reuse")) {
    candidates = JSON.parse(fs.readFileSync(dirs.candidates, "utf8"));
  } else {
    candidates = await fetchCandidates();
    fs.writeFileSync(dirs.candidates, JSON.stringify(candidates, null, 2), { mode: 0o600 });
  }
  const ai = candidates.filter((c) => AI_TITLE.test(c.title ?? ""));
  console.log(JSON.stringify({ candidates: candidates.length, ai_titled: ai.length, since_epoch: SPIKE_START_EPOCH }));
  if (fetchOnly) return;

  // Highest-points first: established projects have real sites to map.
  ai.sort((a, b) => b.points - a.points);
  const chosen = new Map();
  const stats = { preflighted: 0, unusable: 0, robots_blocked: 0, by_class: {} };
  for (const c of ai) {
    if (chosen.size === CLASSES.length) break;
    if (stats.preflighted >= 250) break;
    stats.preflighted += 1;
    const p = await preflightCandidate(c);
    await sleep(400);
    if (!p) {
      stats.unusable += 1;
      continue;
    }
    stats.by_class[p.type_class] = (stats.by_class[p.type_class] ?? 0) + 1;
    if (p.preflight.robots_blocked) {
      stats.robots_blocked += 1;
      continue;
    }
    if (!chosen.has(p.type_class)) chosen.set(p.type_class, p);
  }
  const projects = CLASSES.filter((k) => chosen.has(k)).map((k, i) => ({ ...chosen.get(k), n: i + 1 }));
  fs.writeFileSync(dirs.projects, JSON.stringify(projects, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      ...stats,
      chosen_classes: projects.map((p) => p.type_class),
      missing_classes: CLASSES.filter((k) => !chosen.has(k)),
    }),
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href) {
  main().catch((e) => {
    console.error(`pick-projects failed: ${e.message}`);
    process.exit(1);
  });
}
