// EVD-03 coverage for createGithubClient()/fetchRepoEvidence(): the
// explicit per-endpoint field allow-list structurally cannot leak
// contributor/commit-author personal data, absent items (404s) never
// throw, a single rate-limited endpoint is caught without aborting the
// rest of the collection, and releases keep the API's own returned order.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGithubClient, fetchRepoEvidence } from "../../src/pipeline/evidence/github.ts";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => "",
  };
}

function rateLimitedResponse() {
  return {
    ok: false,
    status: 403,
    headers: {
      get: (name) => (name === "x-ratelimit-remaining" ? "0" : name === "x-ratelimit-reset" ? "1700000000" : null),
    },
    text: async () => JSON.stringify({ message: "rate limited" }),
  };
}

/** Every object key anywhere in `value`, recursively — not just the known top-level keys. */
function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      found.add(key);
      allKeys(v, found);
    }
  }
  return found;
}

describe("createGithubClient / fetchRepoEvidence (EVD-03)", () => {
  test("an owner object on /repos and an author object on /releases never surface anywhere in the result", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/repos/acme/widget")) {
        return jsonResponse(200, {
          license: { key: "mit", name: "MIT License" },
          topics: ["ai", "productivity"],
          pushed_at: "2026-01-01T00:00:00Z",
          stargazers_count: 42,
          owner: { login: "acme", id: 1, avatar_url: "https://example.com/a.png" },
        });
      }
      if (url.endsWith("/readme")) {
        return jsonResponse(200, { content: "aGVsbG8=", encoding: "base64" });
      }
      if (url.endsWith("/community/profile")) {
        return jsonResponse(200, { files: { license: { key: "mit" }, code_of_conduct: { key: "coc" }, contributing: null } });
      }
      if (url.endsWith("/contents/SECURITY.md")) {
        return jsonResponse(200, { content: "c2VjdXJpdHk=", encoding: "base64", path: "SECURITY.md" });
      }
      if (url.includes("/releases")) {
        return jsonResponse(200, [
          { tag_name: "v3", published_at: "2026-03-01T00:00:00Z", body: "three", author: { login: "bob", id: 2, avatar_url: "x" } },
          { tag_name: "v2", published_at: "2026-02-01T00:00:00Z", body: "two", author: { login: "bob", id: 2, avatar_url: "x" } },
          { tag_name: "v1", published_at: "2026-01-01T00:00:00Z", body: "one", author: { login: "bob", id: 2, avatar_url: "x" } },
        ]);
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const client = createGithubClient({ token: "test-token", fetchImpl });
    const evidence = await fetchRepoEvidence({ owner: "acme", repo: "widget", client });

    const keys = allKeys(evidence);
    for (const disallowed of ["owner", "author", "login", "id", "avatar_url"]) {
      assert.ok(!keys.has(disallowed), `disallowed field "${disallowed}" leaked into the returned evidence`);
    }
    assert.deepEqual(
      evidence.releases.map((r) => r.tagName),
      ["v3", "v2", "v1"],
      "releases must come back in the API's own returned order, never re-sorted",
    );
    assert.equal(evidence.repo.stargazersCount, 42);
    assert.deepEqual(evidence.repo.license, { key: "mit", name: "MIT License" });
  });

  test("a fake 404 on both SECURITY.md paths yields securityMd: null, not a thrown error", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("SECURITY.md")) return notFoundResponse();
      if (url.endsWith("/repos/acme/widget")) return jsonResponse(200, {});
      if (url.endsWith("/readme")) return notFoundResponse();
      if (url.endsWith("/community/profile")) return jsonResponse(200, { files: {} });
      if (url.includes("/releases")) return jsonResponse(200, []);
      throw new Error(`unexpected URL ${url}`);
    };
    const client = createGithubClient({ token: "test-token", fetchImpl });
    const evidence = await fetchRepoEvidence({ owner: "acme", repo: "widget", client });
    assert.equal(evidence.securityMd, null);
  });

  test("a fake empty releases array yields releases: []", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/releases")) return jsonResponse(200, []);
      if (url.endsWith("/repos/acme/widget")) return jsonResponse(200, {});
      if (url.endsWith("/readme")) return notFoundResponse();
      if (url.endsWith("/community/profile")) return jsonResponse(200, { files: {} });
      if (url.includes("SECURITY.md")) return notFoundResponse();
      throw new Error(`unexpected URL ${url}`);
    };
    const client = createGithubClient({ token: "test-token", fetchImpl });
    const evidence = await fetchRepoEvidence({ owner: "acme", repo: "widget", client });
    assert.deepEqual(evidence.releases, []);
  });

  test("a fake 403 with x-ratelimit-remaining: 0 on one endpoint is caught for that endpoint only, and the function still returns the other real results", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/readme")) return rateLimitedResponse();
      if (url.endsWith("/repos/acme/widget")) {
        return jsonResponse(200, { license: null, topics: [], pushed_at: "2026-01-01T00:00:00Z", stargazers_count: 1 });
      }
      if (url.endsWith("/community/profile")) return jsonResponse(200, { files: {} });
      if (url.includes("SECURITY.md")) return notFoundResponse();
      if (url.includes("/releases")) return jsonResponse(200, []);
      throw new Error(`unexpected URL ${url}`);
    };
    const client = createGithubClient({ token: "test-token", fetchImpl });
    const evidence = await fetchRepoEvidence({ owner: "acme", repo: "widget", client });
    assert.deepEqual(evidence.readme, { failed: true, reason: "rate-limited" });
    assert.equal(evidence.repo.stargazersCount, 1);
    assert.deepEqual(evidence.releases, []);
  });
});
