import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizePromptSizes } from "../../src/pipeline/validate/prompt-size.ts";

test("prompt-size percentiles use nearest rank and refuse at the cap", () => {
  assert.deepEqual(summarizePromptSizes([20000, 1, 100, 300, 500]), { p50: 300, p90: 20000, max: 20000, n: 5, unit: "tokens", cap: 20000, refused: 1 });
  assert.equal(summarizePromptSizes([19999]).refused, 0);
  assert.equal(summarizePromptSizes([20001]).refused, 1);
});
test("empty preflight remains visibly empty", () => {
  assert.deepEqual(summarizePromptSizes([]), { p50: 0, p90: 0, max: 0, n: 0, unit: "tokens", cap: 20000, refused: 0 });
});
