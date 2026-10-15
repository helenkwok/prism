// DSC-02 coverage: protocol/PROTOCOL.md section 2's inclusion rule and all
// seven reason codes, PRISMA-ready counts, duplicate-hostname resolution,
// the empty-frame default, and the no-personal-data invariant.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { screenFrame } from "../../src/pipeline/select/screen.ts";

const ALL_REASON_CODES = [
  "library-no-product-claim",
  "model-or-paper",
  "dataset",
  "ai-adjacent",
  "demo-no-site",
  "duplicate",
  "unreachable-at-screening",
];

function post(id, url, created_at, reason) {
  return { id, title: `post ${id}`, url, created_at, ...(reason ? { reason } : {}) };
}

describe("screenFrame (DSC-02)", () => {
  test("partitions a 10-post fixture covering every reason code at least once, plus 3 included", () => {
    const frame = {
      posts: [
        post("1", "https://lib1.example.com/", "2026-01-01T00:00:00.000Z", "library-no-product-claim"),
        post("2", "https://model1.example.com/", "2026-01-02T00:00:00.000Z", "model-or-paper"),
        post("3", "https://data1.example.com/", "2026-01-03T00:00:00.000Z", "dataset"),
        post("4", "https://adj1.example.com/", "2026-01-04T00:00:00.000Z", "ai-adjacent"),
        post("5", "https://demo1.example.com/", "2026-01-05T00:00:00.000Z", "demo-no-site"),
        post("6", "https://unreach1.example.com/", "2026-01-06T00:00:00.000Z", "unreachable-at-screening"),
        post("7", "https://good1.example.com/", "2026-01-07T00:00:00.000Z"),
        post("8", "https://good2.example.com/", "2026-01-08T00:00:00.000Z"),
        post("9", "https://good3.example.com/", "2026-01-09T00:00:00.000Z"),
        // duplicate pair, handled separately below via dedicated hostnames
        post("10", "https://good1.example.com/later", "2026-01-10T00:00:00.000Z"),
      ],
    };

    const result = screenFrame(frame);

    // 10 shares a hostname with 7, so it is a hostname-duplicate of an already-included post.
    assert.equal(result.included.length, 3);
    assert.deepEqual(result.included.map((p) => p.id), ["7", "8", "9"]);
    assert.equal(result.excluded.length, 7);

    for (const code of ALL_REASON_CODES) {
      assert.equal(typeof result.counts[code], "number", `counts must have a ${code} key`);
    }
    assert.equal(result.counts.included, 3);
    const total = ALL_REASON_CODES.reduce((sum, code) => sum + result.counts[code], 0) + result.counts.included;
    assert.equal(total, frame.posts.length);

    for (const code of [
      "library-no-product-claim",
      "model-or-paper",
      "dataset",
      "ai-adjacent",
      "demo-no-site",
      "unreachable-at-screening",
    ]) {
      assert.equal(result.counts[code], 1, `${code} must have exactly 1 match`);
    }
    assert.equal(result.counts.duplicate, 1);
  });

  test("counts has all seven reason-code keys present even when a code matches nothing", () => {
    const frame = { posts: [post("1", "https://only.example.com/", "2026-01-01T00:00:00.000Z")] };
    const result = screenFrame(frame);
    for (const code of ALL_REASON_CODES) {
      assert.equal(result.counts[code], 0);
    }
    assert.equal(result.counts.included, 1);
  });

  test("a duplicate-hostname pair with no reason hint: the earlier-created_at post (listed first) stays included, the later is excluded duplicate", () => {
    const frame = {
      posts: [
        post("early", "https://shared.example.com/a", "2026-01-01T00:00:00.000Z"),
        post("late", "https://shared.example.com/b", "2026-01-02T00:00:00.000Z"),
      ],
    };
    const result = screenFrame(frame);
    assert.deepEqual(result.included.map((p) => p.id), ["early"]);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].post.id, "late");
    assert.equal(result.excluded[0].reasonCode, "duplicate");
  });

  test("www-prefixed hostnames and different-case hostnames are treated as the same host for duplicate detection", () => {
    const frame = {
      posts: [
        post("1", "https://Example.com/a", "2026-01-01T00:00:00.000Z"),
        post("2", "https://www.example.com/b", "2026-01-02T00:00:00.000Z"),
      ],
    };
    const result = screenFrame(frame);
    assert.deepEqual(result.included.map((p) => p.id), ["1"]);
    assert.equal(result.excluded[0].reasonCode, "duplicate");
  });

  test("empty frame returns the all-zero shape without throwing", () => {
    const result = screenFrame({ posts: [] });
    assert.deepEqual(result.included, []);
    assert.deepEqual(result.excluded, []);
    for (const code of ALL_REASON_CODES) assert.equal(result.counts[code], 0);
    assert.equal(result.counts.included, 0);
  });

  test("no included or excluded post object ever carries an author/name/email key", () => {
    const frame = {
      posts: [
        post("1", "https://a.example.com/", "2026-01-01T00:00:00.000Z"),
        post("2", "https://b.example.com/", "2026-01-02T00:00:00.000Z", "dataset"),
      ],
    };
    const result = screenFrame(frame);
    const forbidden = ["author", "name", "email"];
    for (const p of result.included) {
      for (const key of Object.keys(p)) assert.equal(forbidden.includes(key), false, `unexpected key ${key}`);
    }
    for (const { post: p } of result.excluded) {
      for (const key of Object.keys(p)) assert.equal(forbidden.includes(key), false, `unexpected key ${key}`);
    }
  });
});
