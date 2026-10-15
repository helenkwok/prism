// The phase's tracer: one real project (mysetup.ai, from the Phase 1 Tavily
// spike's own-domain measurement) wired through every stage — boundary,
// Tavily collection, redaction, segmentation, Nemotron coding, the
// quote-or-unknown filter, the 5 claim.json records, and the gate — with
// fakes only at the three genuine external-process boundaries: the Tavily
// fetch, the Nebius fetch, and the gate's child process.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveBoundary } from "../../src/pipeline/evidence/boundary.ts";
import { collectProjectPages } from "../../src/pipeline/evidence/tavily.ts";
import { redactText } from "../../src/pipeline/evidence/redact.ts";
import { buildSnapshot } from "../../src/pipeline/evidence/segment.ts";
import { buildContract, loadGateFile, isSchemaValid } from "../../src/pipeline/coding/contract.ts";
import { createClient, buildChatBody, PINNED_MODEL } from "../../src/pipeline/coding/nebius-client.ts";
import { applyQuoteOrUnknownFilter } from "../../src/pipeline/coding/filter.ts";
import { buildClaimsForProject } from "../../src/pipeline/claims/build-claims.ts";
import { runGate } from "../../src/pipeline/gate/run-gate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gates = JSON.parse(fs.readFileSync(gatesPath, "utf8"));

// The Phase 1 Tavily spike's own-domain project (n=1): PRISM_DATA_DIR/spikes/projects.json.
const PROJECT_TITLE = "Show HN: Share your AI Setup, Learn from others";
const PROJECT_URL = "https://mysetup.ai/";

const PAGE_TEXT = `# MySetup.ai

Contact us at founder@mysetup.ai or call +1 415-555-0100 for help. Thanks to @alice for the feedback.

\`\`\`
ping @bob
npm install @octokit/rest
\`\`\`

## Features

MySetup lets you share your AI development environment with others and learn from what they run.`;

/** Hand-derived from claim_gate.py's evaluate(): BLOCKED if any required check
 * is "fail"; else INSUFFICIENT_EVIDENCE if any is "unknown"/"not-applicable";
 * else PASS. Valid only for structurally complete records with no missing
 * fields and no claim mismatch — true of every record build-claims.ts emits. */
function fakeGateStatus(record) {
  const rule = gates.decisions[record.targetDecision];
  const states = rule.requiredChecks.map((c) => record.gateChecks[c.id] ?? "unknown");
  if (states.includes("fail")) return "BLOCKED";
  if (states.some((s) => s === "unknown" || s === "not-applicable")) return "INSUFFICIENT_EVIDENCE";
  return "PASS";
}

function fakeSpawnImpl(_command, args) {
  const tmpFile = args[args.length - 1];
  const record = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  const status = fakeGateStatus(record);
  return { status: status === "PASS" ? 0 : 1, stdout: JSON.stringify({ status, targetDecision: record.targetDecision }), stderr: "" };
}

const runGateViaFakeSpawn = (record) => runGate(record, { spawnImpl: fakeSpawnImpl, pythonPath: "fake-python", gateScriptPath: "fake-gate.py", repoRoot: root });

describe("tracer: one project, every layer, wired end to end", () => {
  test("boundary -> tavily (fake) -> redact -> segment -> nebius (fake) -> filter -> build-claims -> gate (fake spawn)", async () => {
    // 1. boundary (real)
    const boundary = deriveBoundary(PROJECT_URL);
    assert.equal(boundary.host, "mysetup.ai");

    // 2. Tavily collection — FAKE fetch, real collectProjectPages logic
    const tavilyFetch = async (url) => {
      if (url.includes("/map")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [PROJECT_URL], usage: { credits: 1 } }) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [{ url: PROJECT_URL, raw_content: PAGE_TEXT }], usage: { credits: 1 } }),
      };
    };
    const collected = await collectProjectPages({ boundary, startUrl: PROJECT_URL, apiKey: "fake-tavily-key", fetchImpl: tavilyFetch });
    assert.equal(collected.pages.length, 1);
    assert.equal(collected.pages[0].rawText, PAGE_TEXT);

    // 3. redact (real)
    const { text: redacted, counts } = redactText(collected.pages[0].rawText);
    assert.equal(counts.emails, 1);
    assert.equal(counts.phones, 1);
    assert.equal(counts.handles, 1);
    assert.equal(counts.nearMissHandles, 1);
    assert.equal(redacted.includes("@bob"), true, "fenced-code @handle must survive unredacted");
    assert.equal(redacted.includes("@octokit/rest"), true, "npm-scope-shaped token must survive unredacted");
    assert.equal(redacted.includes("@alice"), false, "prose @handle must be redacted");
    assert.equal(redacted.includes("[handle redacted]"), true);

    // 4. segment/snapshot (real) — hash and spans computed over the REDACTED text
    const snapshot = buildSnapshot(PROJECT_URL, "2026-10-15T00:00:00Z", redacted);
    assert.equal(snapshot.visibility, "provider-extracted");
    assert.ok(snapshot.spans.length >= 2);
    const knownSpanIds = snapshot.spans.map((s) => s.id);
    const realSpanId = snapshot.spans[0].id;

    // 5. Nemotron coding — FAKE Nebius fetch, real contract + client plumbing
    const gateFile = loadGateFile(gatesPath);
    const { zodSchema, jsonSchema } = buildContract(gateFile.checkIds);

    const cannedChecks = gateFile.checkIds.map((checkId) => {
      if (checkId === "acceptance-criteria-met") return { checkId, proposedState: "pass", spanIds: [realSpanId] };
      if (checkId === "failure-modes-tested") return { checkId, proposedState: "pass", spanIds: [] };
      if (checkId === "limitations-stated") return { checkId, proposedState: "fail", spanIds: [] };
      if (checkId === "deliverable-gate-passed") return { checkId, proposedState: "pass", spanIds: [realSpanId] };
      return { checkId, proposedState: "unknown", spanIds: [] };
    });
    const cannedReplyText = JSON.stringify({ checks: cannedChecks });

    const nebiusFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: cannedReplyText } }] }),
    });
    const client = createClient({ baseUrl: "https://api.tokenfactory.nebius.com/v1", apiKey: "fake-nebius-key", fetchImpl: nebiusFetch });
    const body = buildChatBody({ model: PINNED_MODEL, messages: [{ role: "user", content: "code it" }], schema: jsonSchema, thinking: false });
    const response = await client.request("/chat/completions", { method: "POST", body });
    const rawReplyText = response.json.choices[0].message.content;

    const validity = isSchemaValid(rawReplyText, knownSpanIds, zodSchema);
    assert.equal(validity.valid, true, validity.stage);

    // 6. quote-or-unknown filter (real)
    const filtered = applyQuoteOrUnknownFilter(validity.data.checks, knownSpanIds);
    const byId = new Map(filtered.map((c) => [c.checkId, c]));
    assert.equal(byId.get("acceptance-criteria-met").proposedState, "pass");
    assert.equal(byId.get("failure-modes-tested").proposedState, "unknown");
    assert.equal(byId.get("limitations-stated").proposedState, "unknown");

    // 7. build-claims (real) + gate (FAKE spawnImpl, hand-derived PASS/BLOCKED/INSUFFICIENT_EVIDENCE rules)
    const claims = await buildClaimsForProject({
      project: PROJECT_TITLE,
      filteredStates: filtered,
      spanUrls: { [realSpanId]: PROJECT_URL },
      runGate: runGateViaFakeSpawn,
      gatesPath,
    });

    assert.equal(Object.keys(claims).length, 5);
    // rely has one real pass (acceptance-criteria-met) and 4 unknowns (the two
    // downgraded checks plus the two untouched defaults) -> INSUFFICIENT_EVIDENCE.
    assert.equal(claims.rely.gateResult.status, "INSUFFICIENT_EVIDENCE");
    // the model proposed "pass" (with a real span) for deliverable-gate-passed,
    // but the override must win: rely was INSUFFICIENT_EVIDENCE -> not-applicable.
    assert.equal(claims.operate.record.gateChecks["deliverable-gate-passed"], "not-applicable");

    for (const [decisionId, { record }] of Object.entries(claims)) {
      const requiredIds = gates.decisions[decisionId].requiredChecks.map((c) => c.id);
      for (const id of requiredIds) assert.ok(id in record.gateChecks, `${decisionId} missing ${id}`);
    }
  });
});
