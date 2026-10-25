// PUB-04 / PUB-01 / R09 / T-06-10: kind-tagged statements and the wording and trend lint.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { lintFinding, lintStatements, lintTrend } from "../../src/publish/lint.ts";
import * as S from "../../src/publish/statements.ts";

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/publish/lint.ts");

describe("templates", () => {
  test("share-template: R09 'At least' wording, check id in backticks, kind finding", () => {
    const s = S.shareSentence({ c: 120, n: 300, checkId: "intended-use-defined", pct: 40, ci: [35, 46] });
    assert.equal(s.text, "At least 120 of 300 launches publicly evidence `intended-use-defined` (40%, 95% CI 35–46%).");
    assert.equal(s.kind, "finding");
    assert.deepEqual(lintFinding(s.text), []);
  });

  test("state-labels: the four fixed display strings", () => {
    assert.deepEqual(S.STATE_LABELS, {
      pass: "publicly evidenced (artefact linked)",
      claimed: "claimed, no artefact linked",
      unknown: "no public evidence found",
      fail: "own page shows the check is not met",
    });
  });

  test("finding-templates: every finding-kind template passes lintFinding and lintTrend", () => {
    const h = (id, supported) => ({ id, c: 180, n: 300, share: 0.6, p: 0.0003, pAdjusted: 0.0009, rejected: supported, supported, sensitivity: { c: 160, p: 0.12, pAdjusted: 0.24, rejected: false } });
    const findings = [
      S.shareSentence({ c: 120, n: 300, checkId: "failure-modes-tested", pct: 40, ci: [35, 46] }),
      S.claimsSentence({ c: 45, x: 30, n: 300, checkId: "limitations-stated", p: 15, q: 10 }),
      S.decisionSentence({ c: 42, n: 300, pct: 14, ci: [10, 18] }),
      S.hypothesisSentence("h1", h("h1", true)),
      S.hypothesisSentence("h1", h("h1", false)),
      S.hypothesisSentence("h2", { id: "h2", tested: true, groups: { "show-hn": 200, reddit: 60, "github-only": 40 }, T: 52.1, p: 0.004, pAdjusted: 0.008, rejected: true, supported: true, V: 0.12, B: 2000 }),
      S.hypothesisSentence("h2", { id: "h2", tested: true, groups: { "show-hn": 200, reddit: 60 }, T: 10, p: 0.6, pAdjusted: 0.6, rejected: false, supported: false, V: 0.03, B: 2000 }),
      S.hypothesisSentence("h3", h("h3", true)),
      S.hypothesisSentence("h3", h("h3", false)),
    ];
    for (const f of findings) {
      assert.equal(f.kind, "finding", f.id);
      assert.deepEqual(lintFinding(f.text), [], `${f.id}: ${f.text}`);
      assert.deepEqual(lintTrend(f.text), [], f.id);
    }
    assert.match(findings[3].text, /do not publicly evidence/);
    assert.deepEqual(lintStatements(findings), []);
  });

  test("d76-limitations: every limitation and exploratory item, with the D-76 numbers, passes lintStatements", () => {
    const items = [
      S.screeningLimitation({ errors: 5, audited: 41, pct: 12.2, ci: [5.3, 25.5], bar: 10 }),
      S.screeningRemeasure({ pct: 2.4, audited: 41, sample: 300 }),
      S.recallLimitation({ supportedFound: 59, supported: 66, recall: 0.894, contributed: 8, projects: 10, rawFound: 141, raw: 159, rawRecall: 0.887 }),
      S.gatheredItemsLimitation({ gathered: 159, supported: 66, unsupported: 93, boilerplate: 27 }),
      S.collectorChange(),
      S.collectorCrossCheck({ projects: 142, positiveAgreement: 0.78, allStates: 0.915 }),
      S.wholePageSpanDefect(),
      S.agentRoles([
        { role: "coder", model: "model-a", host: "host-a" },
        { role: "independent labeller", model: "model-b", host: "host-b" },
      ]),
      S.providerVisibility(),
      S.cohortSurvivorship(),
      S.notDone(),
      S.samplingFrameBias(),
    ];
    for (const s of items) assert.ok(["limitation", "exploratory"].includes(s.kind), s.id);
    assert.equal(items[1].kind, "exploratory");
    assert.equal(items[5].kind, "exploratory");
    assert.equal(items[0].text, "Screening missed its pre-registered target: 12.2% of audited exclusions were in error (5 of 41, 95% CI 5.3–25.5%) against a 10% bar. This is a selection limitation.");
    assert.equal(S.notDone().text, "Not publicly evidenced does not mean not done.");
    assert.deepEqual(lintStatements(items), []);
  });

  test("ui-copy: banner, H2 line, absent row, withheld row, empty state and cohort caption", () => {
    const rest = [S.cohortBanner(), S.h2DescriptiveLine(), S.absentRow("reddit"), S.absentRow("reddit", "every pick was tagged context"), S.withheldRow("second miss, estimate withheld"), ...S.emptyState(), S.cohortCaption("2026 Q1")];
    assert.equal(rest[2].text, "not in this release: no reddit launches met the inclusion criteria");
    assert.equal(rest[3].text, "not in this release: every pick was tagged context");
    assert.equal(rest[5].text, "Findings not yet released");
    assert.equal(rest.at(-1).text, "Launched in 2026 Q1, as evidenced today.");
    assert.ok(rest.at(-1).id.startsWith("cohort"));
    assert.deepEqual(lintStatements(rest), []);
  });
});

describe("lintFinding (PUB-04)", () => {
  const failing = [
    ["Most launches lack a security policy.", ["evaluative-term", "missing-publicly-evidence"]],
    ["120 of 300 launches failed `failure-modes-tested`.", ["evaluative-term", "missing-publicly-evidence"]],
    ["At least 12 of 300 launches publicly evidence `x`, so most are missing it.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence a compliant policy.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence `x` but are non-compliant.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence `x`; the rest are BLOCKED.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence a certified audit.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence `x` and score well.", ["evaluative-term"]],
    ["At least 12 of 300 launches publicly evidence `x`, failing the rest.", ["evaluative-term"]],
    ["12 of 300 launches show `x`.", ["missing-publicly-evidence"]],
  ];
  for (const [text, rules] of failing) {
    test(`fails: ${text}`, () => assert.deepEqual(lintFinding(text), rules));
  }

  const passing = [
    "120 of 300 launches publicly evidence `failure-modes-tested`.",
    "At least 3 of 300 launches publicly evidence <code>failure-modes-tested</code>.",
    "At least 3 of 300 launches publicly evidence a <cite>Security Compliance Policy</cite>.",
    "AT LEAST 3 OF 300 LAUNCHES PUBLICLY EVIDENCE `x`.",
  ];
  for (const text of passing) {
    test(`passes: ${text}`, () => assert.deepEqual(lintFinding(text), []));
  }

  test("failure-modes-tested: the backticked id alone passes the evaluative rule", () => {
    assert.ok(lintFinding("120 of 300 launches failed `failure-modes-tested`").includes("evaluative-term"));
    assert.ok(!lintFinding("120 of 300 launches `failure-modes-tested`").includes("evaluative-term"));
  });

  test("cite-stripped: a source title inside <cite> is stripped before the evaluative rule", () => {
    assert.deepEqual(lintFinding("At least 3 of 300 launches publicly evidence <cite>Failure Score Compliance</cite>."), []);
  });
});

describe("lintTrend (protocol section 7)", () => {
  const failing = [
    "Evidence is improving.",
    "Evidence is worsening.",
    "Rising shares.",
    "Falling shares.",
    "A clear trend.",
    "Shares change over time.",
    "Growth in evidence.",
    "A decline in evidence.",
    "More than last quarter.",
    "fewer than last quarter",
  ];
  for (const text of failing) test(`fails: ${text}`, () => assert.deepEqual(lintTrend(text), ["trend-wording"]));
  test("passes: present-day cohort caption", () => assert.deepEqual(lintTrend("Launched in 2026 Q1, as evidenced today."), []));
});

describe("lintStatements", () => {
  test("method-text: a method statement with fail, missing data and BLOCKED passes", () => {
    const m = { id: "method:missing", kind: "method", text: "Missing data is unknown, never fail; a site BLOCKED by robots.txt is counted apart." };
    assert.deepEqual(lintStatements([m]), []);
  });

  test("trend lint covers findings and cohort-prefixed statements, not methods", () => {
    const list = [
      { id: "cohort:q1", kind: "title", text: "Launched in Q1, rising since." },
      { id: "method:x", kind: "method", text: "We describe no trend over time." },
      { id: "share:x", kind: "finding", text: "At least 3 of 300 launches publicly evidence `x`, a growth." },
    ];
    assert.deepEqual(lintStatements(list), [
      { id: "cohort:q1", rule: "trend-wording" },
      { id: "share:x", rule: "trend-wording" },
    ]);
  });
});

describe("LINT CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-lint-"));
  const run = (file) => spawnSync(process.execPath, [LINT, file], { encoding: "utf8" });

  test("passing file prints the LINT summary", () => {
    const f = path.join(dir, "ok.json");
    const list = [S.shareSentence({ c: 120, n: 300, checkId: "intended-use-defined", pct: 40, ci: [35, 46] }), S.notDone()];
    fs.writeFileSync(f, JSON.stringify(list));
    const r = run(f);
    assert.ok(r.stdout.startsWith('LINT: {"statements":'), r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'LINT: {"statements":2,"findings":1,"errors":0}');
  });

  test("failing file prints one LINT FAIL line per error", () => {
    const f = path.join(dir, "bad.json");
    fs.writeFileSync(f, JSON.stringify([{ id: "share:bad", kind: "finding", text: "Most launches lack a security policy." }]));
    const r = run(f);
    assert.match(r.stdout, /^LINT FAIL share:bad evaluative-term$/m);
    assert.match(r.stdout, /^LINT FAIL share:bad missing-publicly-evidence$/m);
    assert.equal(r.status, 1);
  });
});
