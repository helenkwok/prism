// EVD-04 coverage for the new production segmenter.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildSnapshot, segmentText } from "../../src/pipeline/evidence/segment.ts";

describe("segmentText (EVD-04)", () => {
  test("two blocks separated by exactly one blank line become two spans", () => {
    const spans = segmentText("first paragraph\n\nsecond paragraph");
    assert.equal(spans.length, 2);
    assert.equal(spans[0].text, "first paragraph");
    assert.equal(spans[1].text, "second paragraph");
  });

  test("the same two blocks separated by a single newline stay one span", () => {
    const spans = segmentText("first paragraph\nsecond paragraph");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].text, "first paragraph\nsecond paragraph");
  });

  test("a heading line starts a new span, distinct from the paragraph before and after it", () => {
    const spans = segmentText("intro text\n## A Heading\noutro text");
    assert.equal(spans.length, 3);
    assert.equal(spans[0].text, "intro text");
    assert.equal(spans[1].text, "## A Heading");
    assert.equal(spans[2].text, "outro text");
  });

  test("two consecutive identical blocks collapse to one span", () => {
    const spans = segmentText("nav footer text\n\nnav footer text\n\nreal content");
    assert.equal(spans.length, 2);
    assert.equal(spans[0].text, "nav footer text");
    assert.equal(spans[1].text, "real content");
  });

  test("empty or whitespace-only text yields zero spans", () => {
    assert.deepEqual(segmentText(""), []);
    assert.deepEqual(segmentText("   \n\t  "), []);
  });

  test("a single-paragraph text yields exactly one span", () => {
    const spans = segmentText("just one paragraph of text");
    assert.equal(spans.length, 1);
  });

  test("segmentText is deterministic: the same input run twice yields byte-identical span ids and text", () => {
    const input = "para one\n\n## heading\n\npara two\n\npara two";
    assert.deepEqual(segmentText(input), segmentText(input));
  });

  test("buildSnapshot's visibility is always provider-extracted and its hash changes with the input", () => {
    const a = buildSnapshot("https://example.com/", "2026-10-15T00:00:00Z", "some text");
    const b = buildSnapshot("https://example.com/", "2026-10-15T00:00:00Z", "some textX");
    assert.equal(a.visibility, "provider-extracted");
    assert.equal(b.visibility, "provider-extracted");
    assert.notEqual(a.snapshotHash, b.snapshotHash);
  });
});
