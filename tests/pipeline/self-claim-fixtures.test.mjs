// COD-03/D-38: a self-claimed badge with no register link is coded "claimed",
// never "pass" — proven end to end: the codebook's own claimedRule text
// reaches the Nemotron prompt (grounded in the loaded object's own field
// value, not a second hardcoded copy), and a correctly-proposed "claimed"
// state survives the quote-or-unknown filter unchanged.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadGateFile, resolveGatesPath, buildContract } from "../../src/pipeline/coding/contract.ts";
import { loadCodebook, checkPromptText } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildCodingMessages } from "../../src/pipeline/run.ts";
import { applyQuoteOrUnknownFilter } from "../../src/pipeline/coding/filter.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codebookPath = path.join(root, "codebook.md");
const gatesPath = resolveGatesPath(undefined, root);

describe("self-claim fixture: a badge with no register link codes claimed, never pass", () => {
  test("the codebook's claimedRule reaches the Nemotron prompt, and claimed survives the filter unchanged", () => {
    const codebook = loadCodebook(codebookPath);
    const gateFile = loadGateFile(gatesPath);
    const { jsonSchema } = buildContract(gateFile.checkIds);

    // The fixture span: a certification badge with no adjacent certificate ID or URL.
    const badgeSpanId = "p1-s1";
    const spans = [{ id: badgeSpanId, text: "We're proud to be SOC 2 Type II certified." }];

    const checkId = "acceptance-criteria-met";
    const expectedClaimedRule = codebook.checks[checkId].claimedRule;

    const prompt = checkPromptText(codebook, checkId);
    assert.ok(
      prompt.includes(expectedClaimedRule),
      "checkPromptText must carry the codebook's own claimedRule text",
    );

    const messages = buildCodingMessages(gateFile.checkIds, codebook, jsonSchema, spans);
    const system = messages[0].content;
    assert.ok(
      system.includes(expectedClaimedRule),
      "the Nemotron system prompt must carry the loaded codebook's own claimedRule text, not a second hardcoded copy",
    );

    // A canned reply simulating a model that correctly followed the
    // instruction: "claimed", citing the badge span, never "pass".
    const cannedChecks = gateFile.checkIds.map((id) =>
      id === checkId
        ? { checkId: id, proposedState: "claimed", spanIds: [badgeSpanId] }
        : { checkId: id, proposedState: "unknown", spanIds: [] },
    );

    const filtered = applyQuoteOrUnknownFilter(cannedChecks, [badgeSpanId]);
    const result = filtered.find((c) => c.checkId === checkId);
    assert.equal(
      result.proposedState,
      "claimed",
      "a correctly-proposed claimed state must survive the filter unchanged — never upgraded to pass, never downgraded",
    );
    assert.deepEqual(result.spanIds, [badgeSpanId]);
  });
});
