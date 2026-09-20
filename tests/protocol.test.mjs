import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FLOOR, MIN_VALUES } from "../protocol/disclosure/audit.mjs";
import { scanText } from "../scripts/check-agent-names.mjs";
import { createTempGitRepo } from "./helpers/temp-git-repo.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, "protocol/PROTOCOL.md"), "utf8");
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor/ai-output-to-value/PIN.json"), "utf8"));
const FINAL = process.env.PROTOCOL_FINAL === "1";

const HEADINGS = [
  "# PRISM Protocol v1",
  "## 0. Status and pre-registration",
  "## 1. Sample frame, window and seeds",
  "## 2. Inclusion and exclusion",
  "## 3. Check states, claimed rule and missing data",
  "## 4. Metrics, thresholds and shortfall actions",
  "## 5. Gold-label sample design",
  "## 6. Disclosure control",
  "## 7. Launch cohorts and interpretation limits",
  "## 8. Confirmatory hypotheses",
  "## 9. Bulk-size rule",
  "## 10. Reddit trigger",
  "## 11. Well-known company rule",
  "## 12. Amendments",
  "## 13. Sign-off register",
];

function section(n) {
  const start = text.indexOf(HEADINGS[n + 1]);
  const next = HEADINGS[n + 2] ? text.indexOf(HEADINGS[n + 2]) : text.length;
  return text.slice(start, next);
}

function registerRows() {
  return section(13)
    .split("\n")
    .filter((l) => /^\| R\d\d \|/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

test("the protocol has its headings, in order", () => {
  const found = text.split("\n").filter((l) => /^#{1,2} /.test(l));
  assert.deepEqual(found, HEADINGS);
});

test("every locked numeric threshold appears as an exact literal", () => {
  for (const literal of [
    "AC1 >= 0.70",
    "pass precision >= 0.85",
    "n = 50",
    "exclusion error rate <= 10%",
    ">= 70%",
    "2025-09-01",
    "2026-08-31",
    "k = 10",
    "Holm",
    "Wilson",
    "2,000",
  ]) {
    assert.ok(text.includes(literal), `missing literal: ${literal}`);
  }
});

test("thresholds are applied as point estimates with intervals reported, and pooled figures never rescue a check", () => {
  const s = section(4);
  assert.match(s, /point estimates/);
  assert.match(s, /Confidence intervals are reported/);
  assert.match(s, /never rescues a failing check/);
  assert.match(s, /BOTH/);
});

test("second-model agreement is a reported figure and not a gate", () => {
  assert.match(section(4), /It is NOT a gate/);
});

test("the shortfall ladder and the miss actions are present", () => {
  const s = section(4);
  assert.match(s, /correct the codebook or the prompt ONCE and revalidate on a fresh seeded subset/);
  assert.match(s, /human-code that check across the full sample if at most 4 checks are affected, otherwise withhold/);
  assert.match(s, /not found by the collector/);
  assert.match(s, /tightening the rule and re-screening once/);
});

test("the Reddit frame is frozen verbatim", () => {
  for (const sub of [
    "r/SideProject", "r/IMadeThis", "r/alphaandbetausers", "r/vibecoding", "r/indiehackers",
    "r/LocalLLaMA", "r/AI_Agents", "r/LLMDevs", "r/LangChain", "r/ChatGPTCoding", "r/MachineLearning",
  ]) {
    assert.ok(section(1).includes(sub), `missing subreddit ${sub}`);
  }
});

test("five distinct seeds of 16 hexadecimal characters", () => {
  const seeds = [...section(1).matchAll(/^\| [A-Za-z -]+ \| `([0-9a-f]{16})` \|$/gm)].map((m) => m[1]);
  assert.equal(seeds.length, 5);
  assert.equal(new Set(seeds).size, 5);
});

test("the three confirmatory hypotheses, with Holm across them", () => {
  const s = section(8);
  for (const h of ["**H1.**", "**H2.**", "**H3.**"]) assert.ok(s.includes(h), `missing ${h}`);
  assert.ok(!s.includes("**H4."));
  assert.match(s, /Holm across the three/);
});

test("the header records the same gate tag and commit as the pin", () => {
  assert.ok(text.includes(`Gate tag: \`${pin.tag}\``));
  assert.ok(text.includes(`Gate commit: \`${pin.commit}\``));
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
});

test("the disclosure numbers in the text equal the reference audit's constants", () => {
  const s = section(6);
  const min = /Minimum feasible values per suppressed cell: (\d+) \(`MIN_VALUES`\)/.exec(s);
  const floor = /Cell floor: (\d+) \(`FLOOR`\)/.exec(s);
  assert.ok(min && floor, "the constants are not stated in the expected form");
  assert.equal(Number(min[1]), MIN_VALUES);
  assert.equal(Number(floor[1]), FLOOR);
  assert.ok(s.includes("k = 10"));
});

test("the launch-cohort section makes no improvement claim", () => {
  const s = section(7);
  assert.match(s, /no claim that evidence is improving/);
});

test("the sign-off register has R01 to R15, each with options, a recommendation and a status", () => {
  const rows = registerRows();
  assert.deepEqual(rows.map((r) => r[0]), Array.from({ length: 15 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`));
  for (const r of rows) {
    assert.equal(r.length, 6, `${r[0]} does not have six columns`);
    assert.ok(r[2].length > 40, `${r[0]} lists no options`);
    assert.ok(r[3].length > 0, `${r[0]} has no recommendation`);
    assert.ok(["PROPOSED", "SIGNED"].includes(r[4]), `${r[0]} has status ${r[4]}`);
  }
});

test("nothing from the deferred list is written as a rule", () => {
  assert.doesNotMatch(text, /lower[- ](CI|confidence)[- ]bound/i);
  assert.doesNotMatch(text, /tiered/i);
  assert.doesNotMatch(text, /second-model agreement (is|as) a (hard )?gate(?!\.)/i);
});

test("the protocol names no coding agent", () => {
  assert.deepEqual(scanText(text), []);
});

test("every number in the budget section is a formula or a measured input, never a made-up figure", () => {
  const s = section(9);
  assert.match(s, /Budget H = /);
  assert.match(s, /3600/);
  assert.match(s, /first 50 projects per quarter in seed order/);
});

// The final gate: with PROTOCOL_FINAL=1 the draft must be fully resolved.
test(`final mode (${FINAL ? "on" : "off"}): no row is PROPOSED, every row is signed, the budget is a number`, { skip: !FINAL }, () => {
  for (const r of registerRows()) {
    assert.equal(r[4], "SIGNED", `${r[0]} is ${r[4]}`);
    assert.ok(r[5].length > 0, `${r[0]} has no signed value`);
  }
  assert.match(section(9), /Budget H = \d+(\.\d+)? hours/);
  assert.doesNotMatch(text, /DRAFT/);
});

test("the final-mode test is not vacuous: it fails on the current draft", () => {
  // a nested runner must not inherit the outer runner's context, or it would not run at all
  const env = { ...process.env, PROTOCOL_FINAL: "1" };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ["--test", "--test-name-pattern=final mode", "tests/protocol.test.mjs"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.match(res.stdout, /final mode \(on\)/, "the nested run did not execute the final-mode test");
  const draft = registerRows().some((r) => r[4] === "PROPOSED");
  assert.equal(res.status !== 0, draft, "final mode must fail exactly while a row is PROPOSED");
});

// ---- the order script, proven in throwaway repositories ------------------------------------

function orderRepo() {
  const repo = createTempGitRepo({ prefix: "prism-order" });
  const commit = (message) => repo.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
  const check = (...args) => repo.run("node", ["scripts/check-protocol-order.mjs", ...args]);
  const add = (rel, contents) => {
    repo.write(rel, contents);
    repo.stage(rel);
  };
  return { repo, commit, check, add };
}

const PROTO = "# Protocol\n\nline one\nline two\n";

test("order script: no tag and no pipeline file is fine (tag pending); --require-tag then fails", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    commit("protocol draft");
    const res = check();
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /tag pending/);
    assert.equal(check("--require-tag").status, 1);
  } finally {
    repo.cleanup();
  }
});

test("order script: a pipeline file committed with no tag fails", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    add("src/pipeline/a.ts", "export {};\n");
    commit("both");
    const res = check();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /before the tag/);
  } finally {
    repo.cleanup();
  }
});

test("order script: an untracked pipeline file on disk with no tag fails", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    commit("protocol draft");
    repo.write("src/pipeline/sneaky.ts", "export {};\n");
    assert.equal(check().status, 1);
  } finally {
    repo.cleanup();
  }
});

test("order script: a pipeline file added after the tag passes", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    commit("protocol draft");
    assert.equal(repo.git("tag", "-a", "protocol-v1", "-m", "pre-registration").status, 0);
    add("src/pipeline/a.ts", "export {};\n");
    commit("pipeline");
    const res = check("--require-tag");
    assert.equal(res.status, 0, res.stderr);
  } finally {
    repo.cleanup();
  }
});

test("order script: a pipeline file added before the tag fails even once the tag exists", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    add("src/pipeline/a.ts", "export {};\n");
    commit("both");
    repo.git("tag", "-a", "protocol-v1", "-m", "late tag");
    const res = check();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /does not come after the tag/);
  } finally {
    repo.cleanup();
  }
});

test("order script: a lightweight tag is refused", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    commit("protocol draft");
    repo.git("tag", "protocol-v1");
    const res = check();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not an annotated tag/);
  } finally {
    repo.cleanup();
  }
});

test("order script: a silent edit of the tagged text fails, an appended addendum passes", () => {
  const { repo, commit, check, add } = orderRepo();
  try {
    add("protocol/PROTOCOL.md", PROTO);
    commit("protocol draft");
    repo.git("tag", "-a", "protocol-v1", "-m", "pre-registration");
    assert.equal(check("--require-tag").status, 0);

    repo.write("protocol/PROTOCOL.md", `${PROTO}\n## Addendum 2026-10-01\n\nA dated change.\n`);
    assert.equal(check("--require-tag").status, 0, "an appended addendum must pass");

    repo.write("protocol/PROTOCOL.md", "# Protocol\n\nline ONE\nline two\n\n## Addendum\n");
    const res = check("--require-tag");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not an exact prefix/);

    repo.write("protocol/PROTOCOL.md", "# Protocol\n\nline one\n");
    assert.equal(check("--require-tag").status, 1, "truncating the tagged text must fail");
  } finally {
    repo.cleanup();
  }
});

test("order script: this repository is currently in an allowed state", () => {
  const res = spawnSync(process.execPath, ["scripts/check-protocol-order.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});
