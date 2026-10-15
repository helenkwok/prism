// EVD-07 coverage for the promoted redact.ts handle pattern. Email/phone
// cases are unchanged copies already proven by tests/spike-preflight.test.mjs;
// this file covers only the new handle-redaction behavior plus the
// empty/whitespace-input contract.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { redactText } from "../../src/pipeline/evidence/redact.ts";

describe("redactText handle pattern (EVD-07)", () => {
  test("a prose @handle is redacted", () => {
    const { text, counts } = redactText("thanks to @alice for the review");
    assert.equal(text, "thanks to [handle redacted] for the review");
    assert.equal(counts.handles, 1);
    assert.equal(counts.nearMissHandles, 0);
  });

  test("a fenced-code-block @handle is left alone and counted as a near-miss", () => {
    const input = "```\nping @bob\n```";
    const { text, counts } = redactText(input);
    assert.equal(text, input);
    assert.equal(counts.handles, 0);
    assert.equal(counts.nearMissHandles, 1);
  });

  test("an inline-code @handle is left alone and counted as a near-miss", () => {
    const { text, counts } = redactText("use `@carol` as the mention");
    assert.equal(text, "use `@carol` as the mention");
    assert.equal(counts.handles, 0);
    assert.equal(counts.nearMissHandles, 1);
  });

  test("an npm-scope-shaped token is left alone and NOT counted as a near-miss", () => {
    const { text, counts } = redactText("install @octokit/rest from npm");
    assert.equal(text, "install @octokit/rest from npm");
    assert.equal(counts.handles, 0);
    assert.equal(counts.nearMissHandles, 0);
  });

  test("an npm-scope token inside a code fence is also excluded by the trailing-slash rule, not counted as a near-miss", () => {
    const input = "```\nnpm install @octokit/rest\n```";
    const { text, counts } = redactText(input);
    assert.equal(text, input);
    assert.equal(counts.handles, 0);
    assert.equal(counts.nearMissHandles, 0);
  });

  test("empty or whitespace-only input returns zero counts unchanged", () => {
    assert.deepEqual(redactText(""), { text: "", counts: { emails: 0, phones: 0, handles: 0, nearMissHandles: 0 } });
    assert.deepEqual(redactText("   \n\t  "), { text: "   \n\t  ", counts: { emails: 0, phones: 0, handles: 0, nearMissHandles: 0 } });
  });
});
