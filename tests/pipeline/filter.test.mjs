// COD-02 coverage for the downgrade-only quote-or-unknown filter.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyQuoteOrUnknownFilter } from "../../src/pipeline/coding/filter.ts";

describe("applyQuoteOrUnknownFilter (COD-02)", () => {
  test("a zero-span pass and a zero-span fail both downgrade to unknown", () => {
    const out = applyQuoteOrUnknownFilter(
      [
        { checkId: "a", proposedState: "pass", spanIds: [] },
        { checkId: "b", proposedState: "fail", spanIds: [] },
      ],
      ["s001"],
    );
    assert.equal(out[0].proposedState, "unknown");
    assert.deepEqual(out[0].spanIds, []);
    assert.equal(out[1].proposedState, "unknown");
    assert.deepEqual(out[1].spanIds, []);
  });

  test("a pass with one resolvable span and one with several are both left as pass", () => {
    const out = applyQuoteOrUnknownFilter(
      [
        { checkId: "a", proposedState: "pass", spanIds: ["s001"] },
        { checkId: "b", proposedState: "pass", spanIds: ["s001", "s002"] },
      ],
      ["s001", "s002"],
    );
    assert.equal(out[0].proposedState, "pass");
    assert.equal(out[1].proposedState, "pass");
  });

  test("a pass citing an unresolvable span downgrades to unknown", () => {
    const out = applyQuoteOrUnknownFilter([{ checkId: "a", proposedState: "pass", spanIds: ["s999"] }], ["s001"]);
    assert.equal(out[0].proposedState, "unknown");
    assert.deepEqual(out[0].spanIds, []);
  });

  test("an unknown check with non-empty spanIds is cleared to spanIds: [] but stays unknown", () => {
    const out = applyQuoteOrUnknownFilter([{ checkId: "a", proposedState: "unknown", spanIds: ["s001"] }], ["s001"]);
    assert.equal(out[0].proposedState, "unknown");
    assert.deepEqual(out[0].spanIds, []);
  });

  test("running the filter on its own output a second time is idempotent", () => {
    const input = [
      { checkId: "a", proposedState: "pass", spanIds: [] },
      { checkId: "b", proposedState: "pass", spanIds: ["s001"] },
      { checkId: "c", proposedState: "claimed", spanIds: [] },
      { checkId: "d", proposedState: "unknown", spanIds: ["s001"] },
    ];
    const once = applyQuoteOrUnknownFilter(input, ["s001"]);
    const twice = applyQuoteOrUnknownFilter(once, ["s001"]);
    assert.deepEqual(once, twice);
  });
});
