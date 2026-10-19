// Chunked coding: spans are grouped by whole pages under a size cap, and per-chunk codings merge with
// pass > claimed > fail > unknown, unioning the winning state's span ids.
import assert from "node:assert/strict";
import { test } from "node:test";

import { chunkSpans, mergeChunkCodings } from "../../src/pipeline/run.ts";

const span = (id, n) => ({ id, text: "x".repeat(n) });

test("whole pages are grouped until the cap, never splitting a page that fits", () => {
  const spans = [span("p1-s001", 30), span("p1-s002", 30), span("p2-s001", 30), span("p3-s001", 50)];
  const chunks = chunkSpans(spans, 100);
  assert.deepEqual(chunks.map((c) => c.map((s) => s.id)), [["p1-s001", "p1-s002", "p2-s001"], ["p3-s001"]]);
});

test("a page larger than the cap is split at span boundaries, and every span appears exactly once", () => {
  const spans = [span("p1-s001", 60), span("p1-s002", 60), span("p1-s003", 60), span("p2-s001", 10)];
  const chunks = chunkSpans(spans, 100);
  assert.deepEqual(chunks.flat().map((s) => s.id), spans.map((s) => s.id));
  assert.ok(chunks.every((c) => c.reduce((a, s) => a + s.text.length, 0) <= 120));
  assert.ok(chunks.length >= 2);
});

test("small input stays one chunk", () => {
  assert.equal(chunkSpans([span("p1-s001", 5), span("p2-s001", 5)], 100).length, 1);
});

test("merge: the strongest state wins, with the union of spans cited for it; unknown carries no spans", () => {
  const merged = mergeChunkCodings(["a", "b", "c"], [
    [{ checkId: "a", proposedState: "fail", spanIds: ["p1-s001"] }, { checkId: "b", proposedState: "claimed", spanIds: ["p1-s002"] }, { checkId: "c", proposedState: "unknown", spanIds: [] }],
    [{ checkId: "a", proposedState: "pass", spanIds: ["p2-s001"] }, { checkId: "b", proposedState: "claimed", spanIds: ["p2-s003", "p1-s002"] }, { checkId: "c", proposedState: "unknown", spanIds: [] }],
    [{ checkId: "a", proposedState: "pass", spanIds: ["p3-s004"] }],
  ]);
  assert.deepEqual(merged, [
    { checkId: "a", proposedState: "pass", spanIds: ["p2-s001", "p3-s004"] },
    { checkId: "b", proposedState: "claimed", spanIds: ["p1-s002", "p2-s003"] },
    { checkId: "c", proposedState: "unknown", spanIds: [] },
  ]);
});
