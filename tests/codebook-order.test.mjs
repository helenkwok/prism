// CDB-05 coverage for the codebook freeze-guard. No equivalent protocol-order test file exists
// yet in this repo (check-protocol-order.mjs has none), so this is the minimal direct test of
// checkOrder() against the real repository at HEAD, as 03-04-PLAN.md specifies.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkOrder, TAG } from "../scripts/check-codebook-order.mjs";

describe("checkOrder (CDB-05)", () => {
  test("before any codebook-v1.0 tag exists, requireTag:false reports tag pending with no problems", () => {
    const result = checkOrder({ requireTag: false });
    assert.equal(result.tagPending, true);
    assert.deepEqual(result.problems, []);
  });

  test("before any codebook-v1.0 tag exists, requireTag:true reports exactly one problem naming the missing tag", () => {
    const result = checkOrder({ requireTag: true });
    assert.equal(result.tagPending, true);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], new RegExp(TAG.replace(".", "\\.")));
  });
});
