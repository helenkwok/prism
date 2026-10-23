import assert from "node:assert/strict";
import { test } from "node:test";

import { markSpans } from "../../src/report/marks.ts";

test("cited spans are marked by exact match; an unmatched span leaves the text unmarked", () => {
  const text = "One. Two <b>x</b>. Three.";
  assert.deepEqual(markSpans(text, [{ spanId: "s2", text: "Two <b>x</b>." }, { spanId: "s9", text: "Not here." }]), [
    { text: "One. " },
    { text: "Two <b>x</b>.", spanId: "s2" },
    { text: " Three." },
  ]);
  assert.deepEqual(markSpans(text, [{ spanId: "s9", text: "two <b>x</b>." }]), [{ text }]);
});

test("first occurrence only, overlaps skipped, order by position", () => {
  const text = "aa bb aa cc";
  assert.deepEqual(markSpans(text, [{ spanId: "c", text: "cc" }, { spanId: "a", text: "aa" }, { spanId: "o", text: "a bb" }]), [
    { text: "aa", spanId: "a" },
    { text: " bb aa " },
    { text: "cc", spanId: "c" },
  ]);
});
