import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueProjectSpans } from "../../src/pipeline/coding/span-packing.ts";
import { chunkSpans, CODING_CHUNK_CHARS } from "../../src/pipeline/run.ts";

test("packing retains the first exact text citation across pages without mutating evidence", () => {
  const spans = [{ id: "p1-s1", text: "same" }, { id: "p2-s1", text: "same" }, { id: "p2-s2", text: "Same" }];
  const before = structuredClone(spans);
  assert.deepEqual(uniqueProjectSpans(spans), [spans[0], spans[2]]);
  assert.deepEqual(spans, before);
  assert.equal(uniqueProjectSpans([{ id: "p1-s1", text: "same" }]).length, 1);
});

test("unique request packing retains the approved 40k bound", () => {
  const spans = Array.from({ length: 80 }, (_, i) => ({ id: `p1-s${i}`, text: `${i}`.padEnd(1500, "x") }));
  assert.equal(CODING_CHUNK_CHARS, 40_000);
  for (const chunk of chunkSpans(uniqueProjectSpans(spans))) assert.ok(chunk.reduce((sum, s) => sum + s.text.length, 0) <= 40_000);
});
