// A site-first launch's own GitHub repositories. A repository counts as the site's own only when
// the site's own pages link to it AND one of two signals ties it back to the site:
//   - its declared homepage lies inside the site's boundary, or
//   - its owner or name equals the site's domain name (hyphens ignored: m-quark ~ mquark.com).
// Forks never count. Dependencies, examples and "built with" links fail both signals.

import { getDomainWithoutSuffix } from "tldts";

import { withinBoundary, type Boundary } from "./boundary.ts";
import { fetchRepoEvidence, type GithubClient, type RepoEvidence } from "./github.ts";

export const MAX_SITE_REPOS = 3;
/** Candidate links checked per site: each costs one GitHub request. */
const MAX_CANDIDATES = 10;

/** github.com/{owner}/{repo} links in page text, in first-seen order, deduplicated. */
export function githubRepoLinks(text: string): { owner: string; repo: string }[] {
  const out = new Map<string, { owner: string; repo: string }>();
  for (const m of text.matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, "").replace(/[.]+$/, "");
    if (!repo || ["sponsors", "orgs", "features", "settings", "marketplace", "topics"].includes(owner.toLowerCase())) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    if (!out.has(key)) out.set(key, { owner, repo });
  }
  return [...out.values()];
}

const squash = (s: string) => s.toLowerCase().replace(/[-_.]/g, "");

export function isOwnRepo(
  link: { owner: string; repo: string },
  repoJson: { homepage?: string | null; fork?: boolean } | null,
  boundary: Boundary,
): boolean {
  if (!repoJson || repoJson.fork) return false;
  const hp = typeof repoJson.homepage === "string" ? repoJson.homepage.trim() : "";
  if (hp) {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(hp) ? hp : `https://${hp}`;
    if (withinBoundary(url, boundary)) return true;
  }
  const label = getDomainWithoutSuffix(boundary.host);
  return !!label && (squash(link.owner) === squash(label) || squash(link.repo) === squash(label));
}

export async function findSiteRepos({
  pageTexts,
  boundary,
  client,
}: {
  pageTexts: string[];
  boundary: Boundary;
  client: GithubClient;
}): Promise<{ owner: string; repo: string; evidence: RepoEvidence }[]> {
  const own: { owner: string; repo: string; evidence: RepoEvidence }[] = [];
  for (const link of githubRepoLinks(pageTexts.join("\n")).slice(0, MAX_CANDIDATES)) {
    if (own.length === MAX_SITE_REPOS) break;
    const res = await client.request(`/repos/${link.owner}/${link.repo}`);
    if (res.status !== 200 || !isOwnRepo(link, res.json as any, boundary)) continue;
    own.push({ ...link, evidence: await fetchRepoEvidence({ ...link, client }) });
  }
  return own;
}
