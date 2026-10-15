// DSC-01 coverage: exhaustiveness assertion, author-drop, atomic write.
// No network: fetchImpl is injected.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { REVIEW_WINDOW, buildFrame } from "../../src/pipeline/frame/hn-algolia.ts";

const created = [];
function tmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-frame-test-"));
  created.push(dir);
  return dir;
}

describe("buildFrame (DSC-01)", () => {
  let previousDataDir;

  before(() => {
    previousDataDir = process.env.PRISM_DATA_DIR;
  });

  beforeEach(() => {
    process.env.PRISM_DATA_DIR = tmpDataDir();
  });

  after(() => {
    if (previousDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = previousDataDir;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("REVIEW_WINDOW matches the frozen protocol window", () => {
    assert.equal(REVIEW_WINDOW.startEpoch, 1756684800);
    assert.equal(REVIEW_WINDOW.endEpochExclusive, 1788220800);
  });

  test("an exhaustive fetch over a short fake window writes frame.json with no author field", async () => {
    const start = REVIEW_WINDOW.startEpoch;
    const end = start + 2.5 * 7 * 24 * 3600; // 2-3 weeks, for test speed
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      const u = new URL(url);
      const [t0Str] = u.searchParams.get("numericFilters").match(/\d+/g);
      const t0 = Number(t0Str);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          exhaustive: { nbHits: true },
          hits: [
            {
              objectID: `hit-${t0}`,
              title: "Show HN: a fake AI thing",
              url: "https://example.com",
              points: 10,
              num_comments: 2,
              created_at_i: t0 + 10,
              story_id: `hit-${t0}`,
              _tags: ["story", "show_hn"],
              author: "someone-real", // must never be stored
            },
          ],
        }),
      };
    };

    const result = await buildFrame({ fetchImpl, startEpoch: start, endEpochExclusive: end, sleepMs: 0 });

    assert.ok(calls >= 3, "expected at least 3 weekly windows over a 2.5-week span");
    assert.equal(result.windowCount, calls);
    assert.equal(result.posts.length, calls);
    for (const post of result.posts) {
      assert.equal("author" in post, false, "frame post must never carry an author field");
    }

    const written = JSON.parse(
      fs.readFileSync(path.join(process.env.PRISM_DATA_DIR, "pipeline", "frame.json"), "utf8"),
    );
    assert.equal(written.posts.length, calls);
    assert.equal(JSON.stringify(written).includes("someone-real"), false);
    for (const post of written.posts) assert.equal("author" in post, false);
  });

  test("a non-exhaustive window makes buildFrame throw and writes no frame.json", async () => {
    const start = REVIEW_WINDOW.startEpoch;
    const end = start + 2 * 7 * 24 * 3600;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ exhaustive: { nbHits: false }, hits: [] }),
    });

    await assert.rejects(() => buildFrame({ fetchImpl, startEpoch: start, endEpochExclusive: end, sleepMs: 0 }));

    assert.equal(fs.existsSync(path.join(process.env.PRISM_DATA_DIR, "pipeline", "frame.json")), false);
  });
});
