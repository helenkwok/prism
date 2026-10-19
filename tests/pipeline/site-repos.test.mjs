// A site-first launch's own GitHub repositories: linked from its pages AND tied back to the site.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveBoundary } from "../../src/pipeline/evidence/boundary.ts";
import { findSiteRepos, githubRepoLinks, isOwnRepo, MAX_SITE_REPOS } from "../../src/pipeline/evidence/site-repos.ts";

describe("githubRepoLinks", () => {
  test("first-seen order, deduplicated case-insensitively, .git stripped, non-repo paths skipped", () => {
    const t = "see https://github.com/Acme/App.git and github.com/acme/app, github.com/sponsors/acme, [x](https://github.com/acme/sdk).";
    assert.deepEqual(githubRepoLinks(t), [{ owner: "Acme", repo: "App" }, { owner: "acme", repo: "sdk" }]);
  });
});

describe("isOwnRepo", () => {
  const stackmark = deriveBoundary("https://stackmark.tech/");
  test("a declared homepage inside the site's boundary ties it", () => {
    assert.equal(isOwnRepo({ owner: "grazulex", repo: "stackmark" }, { homepage: "https://stackmark.tech" }, stackmark), true);
    assert.equal(isOwnRepo({ owner: "grazulex", repo: "x" }, { homepage: "stackmark.tech/docs" }, stackmark), true);
  });
  test("an owner or name equal to the domain name ties it, hyphens ignored", () => {
    assert.equal(isOwnRepo({ owner: "m-quark", repo: "feedback" }, { homepage: null }, deriveBoundary("https://app.mquark.com/start")), true);
    assert.equal(isOwnRepo({ owner: "splice-cad", repo: "splice-py" }, { homepage: "" }, deriveBoundary("https://splice-cad.com/")), true);
  });
  test("an unrelated linked repo, a fork, or a missing repo does not count", () => {
    assert.equal(isOwnRepo({ owner: "stefjow", repo: "tropomi-timelapse" }, { homepage: null }, deriveBoundary("https://no2.libmap.org/")), false);
    assert.equal(isOwnRepo({ owner: "facebook", repo: "react" }, { homepage: "https://react.dev" }, stackmark), false);
    assert.equal(isOwnRepo({ owner: "grazulex", repo: "stackmark" }, { homepage: "https://stackmark.tech", fork: true }, stackmark), false);
    assert.equal(isOwnRepo({ owner: "grazulex", repo: "stackmark" }, null, stackmark), false);
  });
});

describe("findSiteRepos", () => {
  test("collects at most MAX_SITE_REPOS own repos and skips the rest", async () => {
    const requested = [];
    const client = {
      request: async (path) => {
        requested.push(path);
        if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { status: 200, json: { homepage: path.includes("/acme/") ? "https://acme.dev" : null } };
        return { status: 404, json: null };
      },
    };
    const text = ["github.com/other/lib", ...[1, 2, 3, 4].map((i) => `github.com/acme/r${i}`)].join(" ");
    const own = await findSiteRepos({ pageTexts: [text], boundary: deriveBoundary("https://acme.dev/"), client });
    assert.deepEqual(own.map((r) => r.repo), ["r1", "r2", "r3"].slice(0, MAX_SITE_REPOS));
    assert.ok(!requested.includes("/repos/acme/r4"), "stops once the cap is reached");
  });
});
