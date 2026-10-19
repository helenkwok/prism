// A repository-first launch's declared homepage is collected as a second own source.
import assert from "node:assert/strict";
import { test } from "node:test";

import { homepageToFollow } from "../../src/pipeline/run.ts";

const ev = (homepage) => ({ repo: { license: null, topics: [], pushedAt: null, stargazersCount: 0, homepage } });

test("a separate http(s) homepage is followed", () => {
  assert.equal(homepageToFollow(ev("https://getartcraft.com")), "https://getartcraft.com/");
});

test("a scheme-less homepage is read as https", () => {
  assert.equal(homepageToFollow(ev("example.org/app")), "https://example.org/app");
});

test("no homepage, a GitHub homepage, a non-http scheme, rate-limited or absent repo info: nothing to follow", () => {
  assert.equal(homepageToFollow(ev(null)), null);
  assert.equal(homepageToFollow(ev("https://github.com/storytold/artcraft")), null);
  assert.equal(homepageToFollow(ev("ftp://example.org")), null);
  assert.equal(homepageToFollow({ repo: { rateLimited: true } }), null);
  assert.equal(homepageToFollow(null), null);
});
