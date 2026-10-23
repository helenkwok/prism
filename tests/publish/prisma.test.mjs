// PUB-03 / T-06-05: PRISMA small-reason merge (protocol section 6.7).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mergeSmallReasons } from "../../src/publish/prisma.ts";

const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe("mergeSmallReasons (6.7)", () => {
  test("prisma-merge-upward: other under 10 merges into the nearest larger reason", () => {
    const input = { "stage1:not-ai": 640, "stage1:no-own-site": 180, "stage2:dataset": 4, "stage2:demo-no-site": 3 };
    const out = mergeSmallReasons(input);
    assert.deepEqual(out, { "stage1:not-ai": 640, "stage1:no-own-site": 187 });
    assert.equal(total(out), total(input));
  });

  test("prisma-other-kept: other at 10 or more stays its own reason", () => {
    const input = { "stage1:not-ai": 640, "stage2:dataset": 4, "stage2:demo-no-site": 3, "stage1:duplicate": 5 };
    const out = mergeSmallReasons(input);
    assert.deepEqual(out, { "stage1:not-ai": 640, other: 12 });
    assert.equal(total(out), total(input));
  });

  test("prisma-pass-through: totals pass through; not-collectable merges within itself", () => {
    const input = {
      screened: 1200,
      included: 290,
      "included-insufficient-text": 10,
      "stage1:not-ai": 800,
      "not-collectable:robots": 85,
      "not-collectable:timeout": 12,
      "not-collectable:dns": 3,
    };
    const out = mergeSmallReasons(input);
    assert.deepEqual(out, {
      screened: 1200,
      included: 290,
      "included-insufficient-text": 10,
      "stage1:not-ai": 800,
      "not-collectable:robots": 85,
      "not-collectable:timeout": 15,
    });
    assert.equal(total(out), total(input));
  });

  test("prisma-ties: the nearest larger reason is the smallest at or over the floor, ties by key", () => {
    const out = mergeSmallReasons({ "stage1:b": 20, "stage1:a": 20, "stage1:c": 50, "stage2:x": 2 });
    assert.deepEqual(out, { "stage1:a": 22, "stage1:b": 20, "stage1:c": 50 });
  });

  test("prisma-all-small: with no reason at the floor, other stands alone", () => {
    const out = mergeSmallReasons({ "stage1:a": 3, "stage1:b": 2, included: 5 });
    assert.deepEqual(out, { included: 5, other: 5 });
  });
});
