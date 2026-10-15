// scripts/lib/codebook-lint.mjs's own test suite (CDB-01, CDB-03, CDB-04,
// D-35, D-36). Uses small synthetic markdown strings built in this file —
// never the real, in-progress codebook.md — so these tests stay stable while
// later plans edit it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { lintCodebookText } from "../scripts/lib/codebook-lint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clauseReference = JSON.parse(fs.readFileSync(path.join(root, "scripts", "lib", "clause-reference.json"), "utf8"));
const FAKE_IDS = ["fake-check-1", "fake-check-2"];

function edge(overrides = {}) {
  return {
    source_id: "src-1",
    title: "Example Title",
    locator: "Clause 1.1",
    source_version: "v1",
    relation_type: "addresses",
    qualification: "A short example qualification.",
    ...overrides,
  };
}

function fakeCheck(overrides = {}) {
  const crosswalk = {
    iso42001: [edge()],
    gaicc: [edge()],
    nistAiRmf: [edge()],
    euAiAct: [edge({ informational: true })],
    oecd: [edge()],
  };
  return {
    decision: "rely",
    label: "Example label.",
    operationalDefinition: "Example operational definition.",
    passRule: "Example pass rule.",
    failRule: "Example fail rule.",
    claimedRule: "Example claimed rule.",
    notApplicableNote: "Example not-applicable note.",
    anchors: { positive: ["positive anchor"], negative: ["negative anchor"] },
    crosswalk,
    ...overrides,
  };
}

function md(checks, { relationTypes = ["addresses", "supports", "partial"], codebookVersion = "v0" } = {}) {
  const block = { codebookVersion, relationTypes, checks };
  return "# Fixture\n\n```json\n" + JSON.stringify(block, null, 2) + "\n```\n";
}

describe("codebook-lint: structural and content validation", () => {
  test("a minimal valid fixture (2 fake check IDs) passes", () => {
    const checks = { "fake-check-1": fakeCheck(), "fake-check-2": fakeCheck() };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.deepEqual(violations, []);
  });

  test("a fixture missing one required checkId fails, naming it", () => {
    const checks = { "fake-check-1": fakeCheck() };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.ok(violations.some((v) => v.includes('missing required check "fake-check-2"')), violations.join("\n"));
  });

  test("a relation_type value outside the three D-35 values fails", () => {
    const checks = {
      "fake-check-1": fakeCheck({ crosswalk: { ...fakeCheck().crosswalk, iso42001: [edge({ relation_type: "informational" })] } }),
      "fake-check-2": fakeCheck(),
    };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.ok(
      violations.some((v) => v.includes("checks.fake-check-1.crosswalk.iso42001[0].relation_type: must be one of addresses, supports, partial")),
      violations.join("\n"),
    );
  });

  test("a qualification containing the forbidden overreach word fails", () => {
    const checks = {
      "fake-check-1": fakeCheck({
        crosswalk: { ...fakeCheck().crosswalk, iso42001: [edge({ qualification: "This clause satisfies the check's intent." })] },
      }),
      "fake-check-2": fakeCheck(),
    };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.ok(
      violations.some((v) => v.includes('checks.fake-check-1.crosswalk.iso42001[0].qualification: must not use the overreach word "satisfies"')),
      violations.join("\n"),
    );
  });

  test("a long qualification containing a clause-reference.json entry as a substring fails", () => {
    const clause = clauseReference[0];
    const longQualification = `This mapping draws on the broader idea of ${clause} across several related supporting considerations noted here.`;
    assert.ok(longQualification.trim().split(/\s+/).length > 15, "fixture qualification must exceed the 15-word heuristic");
    const checks = {
      "fake-check-1": fakeCheck({
        crosswalk: { ...fakeCheck().crosswalk, iso42001: [edge({ qualification: longQualification })] },
      }),
      "fake-check-2": fakeCheck(),
    };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.ok(
      violations.some((v) => v.includes("checks.fake-check-1.crosswalk.iso42001[0]: qualification") && v.includes("clause-reference.json")),
      violations.join("\n"),
    );
  });

  test("a euAiAct edge omitting the informational flag still passes structurally", () => {
    const base = fakeCheck();
    const checks = {
      "fake-check-1": fakeCheck({ crosswalk: { ...base.crosswalk, euAiAct: [edge()] } }), // no `informational` key
      "fake-check-2": fakeCheck(),
    };
    const violations = lintCodebookText(md(checks), FAKE_IDS);
    assert.deepEqual(violations, []);
  });
});
