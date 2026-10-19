// A6: an agent sign-off reviewer never codes or confirms the work it signs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PINNED_MODEL, SECOND_CODER_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import { CONFIRMER_MODEL } from "../../src/pipeline/confirm/confirm.ts";
import { signOff, SIGNOFF_MODEL } from "../../src/pipeline/signoff/signoff.ts";

test("the coding and confirming models are refused as sign-off reviewers", async () => {
  for (const model of [PINNED_MODEL, SECOND_CODER_MODEL, CONFIRMER_MODEL]) {
    await assert.rejects(signOff({ request: async () => assert.fail("must not call") }, "doc", "", "R1", model), /A6/);
  }
  assert.ok(![PINNED_MODEL, SECOND_CODER_MODEL, CONFIRMER_MODEL].includes(SIGNOFF_MODEL));
});

test("a decision record is bound to the digest of the text it judged", async () => {
  const client = { request: async () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"approved","narrowsWhatPasses":true,"reason":"r"}' } }] } }) };
  const a = await signOff(client, "doc", "ctx", "R1");
  const b = await signOff(client, "doc changed", "ctx", "R1");
  assert.equal(a.decision, "approved");
  assert.equal(a.narrowsWhatPasses, true);
  assert.equal(a.reviewer.kind, "agent");
  assert.notEqual(a.inputDigest, b.inputDigest);
});
