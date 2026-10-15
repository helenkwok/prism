// GitHub repo evidence collection (EVD-03). Hand-rolled client, modeled on
// nebius-client.ts's shape: bearer auth passed in (never read from
// process.env inside this module), a rate-limit signal mapped to a
// non-throwing result, scrubSecrets() wrapping any thrown network-failure
// message.
//
// Every endpoint is read through an EXPLICIT per-endpoint field allow-list
// (never a drop-list), built field by field with no object spread anywhere,
// so contributor/commit-author personal data (repos.owner,
// releases[].author, etc.) structurally cannot reach the returned evidence
// object even when the real API response includes it.

import { scrubSecrets } from "./redact.ts";

export type FetchImpl = typeof fetch;

export interface GithubRequestResult {
  status: number;
  json: unknown;
  rateLimited?: true;
  resetAt?: string | null;
}

export interface GithubClient {
  request(path: string): Promise<GithubRequestResult>;
}

/**
 * client.request(path) -> { status, json, rateLimited?, resetAt? }
 *
 * - GET only.
 * - A 403 whose `x-ratelimit-remaining` header reads "0" returns
 *   `{ status: 403, rateLimited: true, resetAt }` rather than throwing.
 * - Any other non-2xx returns `{ status, json: null }` — never throws for an
 *   ordinary HTTP error.
 * - Only a genuine network failure (fetchImpl itself rejecting) throws, with
 *   the token scrubbed from the thrown message first.
 */
export function createGithubClient({
  token,
  fetchImpl = fetch,
  baseUrl = "https://api.github.com",
}: {
  token: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}): GithubClient {
  async function request(path: string): Promise<GithubRequestResult> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (e: any) {
      const msg = scrubSecrets(`network failure on GET ${path}: ${e?.message ?? e?.name ?? "error"}`, [token]);
      throw new Error(msg);
    }
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      return { status: 403, json: null, rateLimited: true, resetAt: res.headers.get("x-ratelimit-reset") };
    }
    if (!res.ok) {
      return { status: res.status, json: null };
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  return { request };
}

export interface RateLimitedEndpoint {
  failed: true;
  reason: "rate-limited";
}

const RATE_LIMITED: RateLimitedEndpoint = { failed: true, reason: "rate-limited" };

export interface RepoLicence {
  key: string;
  name: string;
}

export interface RepoInfo {
  license: RepoLicence | null;
  topics: string[];
  pushedAt: string | null;
  stargazersCount: number | null;
}

export interface ReadmeInfo {
  content: string | null;
  encoding: string | null;
}

export interface CommunityProfileInfo {
  license: { key: string } | null;
  codeOfConduct: boolean;
  contributing: boolean;
}

export interface SecurityMdInfo {
  content: string | null;
  encoding: string | null;
  path: string | null;
}

export interface ReleaseInfo {
  tagName: string | null;
  publishedAt: string | null;
  body: string | null;
}

export interface RepoEvidence {
  repo: RepoInfo | RateLimitedEndpoint | null;
  readme: ReadmeInfo | RateLimitedEndpoint | null;
  communityProfile: CommunityProfileInfo | RateLimitedEndpoint | null;
  securityMd: SecurityMdInfo | RateLimitedEndpoint | null;
  releases: ReleaseInfo[] | RateLimitedEndpoint;
}

async function fetchSecurityMd(client: GithubClient, owner: string, repo: string): Promise<SecurityMdInfo | RateLimitedEndpoint | null> {
  const first = await client.request(`/repos/${owner}/${repo}/contents/SECURITY.md`);
  if (first.rateLimited) return RATE_LIMITED;
  if (first.status === 200 && first.json) {
    const j = first.json as any;
    return { content: j.content ?? null, encoding: j.encoding ?? null, path: j.path ?? null };
  }
  // community/profile does not report SECURITY.md (CLAUDE.md) — the dotfile
  // path is the only way to learn whether a repo has it there instead.
  const second = await client.request(`/repos/${owner}/${repo}/contents/.github/SECURITY.md`);
  if (second.rateLimited) return RATE_LIMITED;
  if (second.status === 200 && second.json) {
    const j = second.json as any;
    return { content: j.content ?? null, encoding: j.encoding ?? null, path: j.path ?? null };
  }
  return null;
}

/**
 * Five calls, each applying its own explicit keep-list. A single endpoint's
 * rate-limit hit is recorded as `{failed:true, reason:"rate-limited"}` for
 * that endpoint only — the function keeps going and still returns the other
 * endpoints' real results rather than aborting the whole project.
 */
export async function fetchRepoEvidence({
  owner,
  repo,
  client,
}: {
  owner: string;
  repo: string;
  client: GithubClient;
}): Promise<RepoEvidence> {
  const repoRes = await client.request(`/repos/${owner}/${repo}`);
  const repoInfo: RepoInfo | RateLimitedEndpoint | null = repoRes.rateLimited
    ? RATE_LIMITED
    : repoRes.json
      ? (() => {
          const j = repoRes.json as any;
          return {
            license: j.license ? { key: j.license.key, name: j.license.name } : null,
            topics: j.topics ?? [],
            pushedAt: j.pushed_at ?? null,
            stargazersCount: j.stargazers_count ?? null,
          };
        })()
      : null;

  const readmeRes = await client.request(`/repos/${owner}/${repo}/readme`);
  const readme: ReadmeInfo | RateLimitedEndpoint | null = readmeRes.rateLimited
    ? RATE_LIMITED
    : readmeRes.status === 200 && readmeRes.json
      ? (() => {
          const j = readmeRes.json as any;
          return { content: j.content ?? null, encoding: j.encoding ?? null };
        })()
      : null;

  const communityRes = await client.request(`/repos/${owner}/${repo}/community/profile`);
  const communityProfile: CommunityProfileInfo | RateLimitedEndpoint | null = communityRes.rateLimited
    ? RATE_LIMITED
    : communityRes.json
      ? (() => {
          const j = communityRes.json as any;
          return {
            license: j.files?.license ? { key: j.files.license.key } : null,
            codeOfConduct: Boolean(j.files?.code_of_conduct),
            contributing: Boolean(j.files?.contributing),
          };
        })()
      : null;

  const securityMd = await fetchSecurityMd(client, owner, repo);

  const releasesRes = await client.request(`/repos/${owner}/${repo}/releases?per_page=5`);
  const releases: ReleaseInfo[] | RateLimitedEndpoint = releasesRes.rateLimited
    ? RATE_LIMITED
    : Array.isArray(releasesRes.json)
      ? (releasesRes.json as any[]).map((r) => ({
          tagName: r.tag_name ?? null,
          publishedAt: r.published_at ?? null,
          body: r.body ?? null,
        }))
      : [];

  return { repo: repoInfo, readme, communityProfile, securityMd, releases };
}
