// PUB-01..05 (plan 06-04): what the full aggregate release holds. Content assertions read the committed
// synthetic release (export.test.mjs checks that it equals a fresh export); variants export in-process with
// the source split off (SOURCE_SPLIT_MIN_GROUP's alternative) unless the variant is about sources, because
// the tiny Reddit group makes the full closure slow.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";
import { PROCESS_FIGURES } from "../../src/publish/a11.ts";
import { expandFixture, loadDecisionRules, tupleId } from "../../src/publish/aggregate.ts";
import { RefusalError, exportRelease, secure } from "../../src/publish/export.ts";
import { h2Permutation, testHypotheses } from "../../src/publish/hypotheses.ts";
import { buildIdentifierSet, scanTexts } from "../../src/publish/identifiers.ts";
import { lintStatements } from "../../src/publish/lint.ts";
import { buildModel, buildTables, decTuple } from "../../src/publish/release-model.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORE = path.join(REPO, "tests/fixtures/publish/synthetic-store.json");
const COMMITTED = path.join(REPO, "tests/fixtures/publish/public-data-synthetic");
const raw = () => JSON.parse(fs.readFileSync(STORE, "utf8"));
const release = JSON.parse(fs.readFileSync(path.join(COMMITTED, "v1/release.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(COMMITTED, "v1/manifest.json"), "utf8"));
const rules = loadDecisionRules();
const DECISIONS = [...rules.keys()];
const FAST = { sourceMinGroup: 10 };

const outDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prism-content-")), "out");
const model = (store = raw(), opts = {}) => {
  const input = expandFixture(store);
  return buildModel(input, buildTables(input, opts), rules);
};
const fast = (store) => exportRelease({ input: expandFixture(store), outDir: outDir(), ...FAST });
const statement = (rel, id) => rel.statements.find((s) => s.id === id);
const hasRow = (m, terms, sense, rhs) =>
  m.truth.constraints.some(
    (c) => c.sense === sense && c.rhs === rhs && c.terms.length === terms.length && terms.every(([id, coef]) => c.terms.some((t) => t.id === id && t.coef === coef)),
  );

/** Every Row-shaped object anywhere in a release. */
function allRows(x, out = []) {
  if (Array.isArray(x)) for (const v of x) allRows(v, out);
  else if (x && typeof x === "object") {
    if (typeof x.id === "string" && typeof x.state === "string" && typeof x.label === "string") out.push(x);
    else for (const v of Object.values(x)) allRows(v, out);
  }
  return out;
}

function cli(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-content-store-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(file, JSON.stringify(store));
  const out = path.join(dir, "out");
  const res = spawnSync(process.execPath, ["src/publish/export.ts", "--store", file, "--out", out], { cwd: REPO, encoding: "utf8" });
  return { stdout: res.stdout, written: fs.existsSync(out) };
}

describe("task 1: decisions, H1 and H3, sensitivity, lint and scan as refusals", () => {
  test("decisions-rows: five decision rows, and each joins the audit against the checks its gate requires", () => {
    assert.deepEqual(release.figures.decisions.rows.map((r) => r.id), DECISIONS.map((d) => decTuple(d, "all")));
    const m = model();
    for (const d of DECISIONS) {
      for (const p of m.tables.partitions) {
        for (const c of m.decisionRows[d]) assert.ok(hasRow(m, [[decTuple(d, p), 1], [tupleId(c, "pass", p), -1]], "<=", 0), `${d} ${c} ${p}`);
      }
    }
    // operate's deliverable-gate-passed comes from rely's gate: a row against rely, never against the coded check
    assert.ok(!m.decisionRows.operate.includes("deliverable-gate-passed"));
    assert.ok(hasRow(m, [[decTuple("operate", "all"), 1], [decTuple("rely", "all"), -1]], "<=", 0));
    // the fixture's decision strings agree with the gate rule over its states
    const explore = m.truth.tuples.find((t) => t.id === decTuple("explore", "all"));
    assert.equal(explore.c, 179);
  });

  test("h1-h3-release: tuples, rows against the check tuples, and a boolean supported flag", () => {
    for (const h of ["h1", "h3"]) {
      const out = release.hypotheses[h];
      assert.equal(typeof out.test.supported, "boolean");
      assert.equal(out.row.id, `${h}|all`);
      assert.ok(statement(release, `hypothesis:${h}`));
      if (out.row.state === "released") assert.match(statement(release, `hypothesis:${h}`).text, new RegExp(`${out.row.c} of ${out.row.n}`));
      else assert.equal(out.test.p, undefined, "no p value for a suppressed count");
    }
    const m = model();
    const claimed = m.truth.tuples.filter((t) => /^chk\|.*\|claimed\|all$/.test(t.id)).map((t) => t.id);
    for (const id of claimed) assert.ok(hasRow(m, [[id, 1], ["h1|all", -1]], "<=", 0), id);
    assert.ok(hasRow(m, [...claimed.map((id) => [id, 1]), ["h1|all", -1]], ">=", 0));
    for (const c of rules.get("rely")) assert.ok(hasRow(m, [[tupleId(c, "pass", "all"), 1], ["h3|all", -1]], "<=", 0), c);
  });

  test("sensitivity-rows: the four collection failures are excluded and each line is bounded by them", () => {
    assert.equal(release.sensitivity.excluded, 4);
    const ids = ["h1|all|sens", "h3|all|sens", ...DECISIONS.map((d) => `${decTuple(d, "all")}|sens`)];
    assert.deepEqual(Object.keys(release.sensitivity.rows).sort(), ids.sort());
    const m = model();
    for (const id of ids) {
      const base = id.slice(0, -5);
      assert.ok(hasRow(m, [[base, 1], [id, -1]], ">=", 0), id);
      assert.ok(hasRow(m, [[base, 1], [id, -1]], "<=", 4), id);
      assert.equal(m.truth.tuples.find((t) => t.id === id).n, 296);
    }
  });

  test("plant-identifier: a project host in a decision label refuses with nothing written", () => {
    const store = raw();
    store.labels = { "decision:explore": "Launches like synthetic-007.example" };
    const { stdout, written } = cli(store);
    assert.match(stdout, /^EXPORT REFUSED: identifier /m);
    assert.equal(written, false);
  });

  test("plant-identifier backstop: an identifier that only reaches the serialized release is caught by the scan", async () => {
    const store = raw();
    store.method = { frame: "posts such as Synthetic 042", window: "2025" };
    await assert.rejects(fast(store), (err) => err instanceof RefusalError && err.rule === "identifier");
  });

  test("plant-evaluative: a hand-written finding note with evaluative wording refuses with nothing written", () => {
    const store = raw();
    store.notes = [{ id: "note:policy", kind: "finding", text: "Most launches lack a policy." }];
    const { stdout, written } = cli(store);
    assert.match(stdout, /^EXPORT REFUSED: lint /m);
    assert.equal(written, false);
  });

  test("inconsistent-input: a PASS decision while a required check is unknown refuses", () => {
    const store = raw();
    const k = store.checkIds.indexOf("intended-use-defined");
    const p = store.projects.find((x) => x.states[k] !== "p");
    p.decisions = p.decisions.slice(0, 1) + "P" + p.decisions.slice(2);
    const { stdout, written } = cli(store);
    assert.match(stdout, /^EXPORT REFUSED: inconsistent-input /m);
    assert.equal(written, false);
  });

  test("inconsistent-input: aggregate counts that break a decision row refuse inside the model", async () => {
    const truth = {
      tuples: [
        { id: "dec|rely|PASS|all", n: 300, c: 40 },
        { id: "chk|x|pass|all", n: 300, c: 30 },
      ],
      constraints: [{ terms: [{ id: "dec|rely|PASS|all", coef: 1 }, { id: "chk|x|pass|all", coef: -1 }], sense: "<=", rhs: 0 }],
    };
    await assert.rejects(secure(truth), (err) => err instanceof RefusalError && err.rule === "inconsistent-input");
  });

  test("the manifest records the statements, a clean lint and a clean scan", () => {
    assert.equal(manifest.lint.errors, 0);
    assert.equal(manifest.lint.statements, release.statements.length);
    assert.deepEqual(manifest.scan, { files: 3, hits: 0 });
    assert.deepEqual(lintStatements(release.statements), []);
    assert.equal(manifest.audit.pass, true);
  });
});

describe("task 2: cohorts, sources, claims, source types, H2 and PRISMA", () => {
  test("cohorts-order: four rows per decision in calendar order", () => {
    for (const d of DECISIONS) assert.deepEqual(release.figures[`cohorts:${d}`].rows.map((r) => r.id), ["q1", "q2", "q3", "q4"].map((q) => decTuple(d, q)));
    for (const q of ["quarter 1", "quarter 2", "quarter 3", "quarter 4"]) assert.ok(release.statements.some((s) => s.text === `Launched in ${q}, as evidenced today.`));
  });

  test("sources-absent-and-small: Show HN, Reddit (n 6, never a number) and an absent GitHub-only row", () => {
    for (const d of DECISIONS) {
      const [shn, reddit, gh] = release.figures[`sources:${d}`].rows;
      assert.equal(shn.id, decTuple(d, "src:show-hn"));
      assert.ok(["lt10", "suppressed"].includes(reddit.state), reddit.state);
      assert.equal(reddit.c, undefined);
      assert.equal(gh.state, "absent");
      assert.equal(gh.reason, "no GitHub-only launches met the inclusion criteria");
    }
    assert.ok(statement(release, "absent:github-only"));
  });

  test("source-split-min-group: at 10, every source row is absent with the fixed reason (Helen's open choice)", () => {
    const t = buildTables(expandFixture(raw()), { sourceMinGroup: 10 });
    for (const p of ["src:show-hn", "src:reddit"]) assert.equal(t.absent.get(p), "the source split is published only when every source has at least ten included launches");
    assert.ok(!t.partitions.some((p) => p.startsWith("src:")));
  });

  test("h2-descriptive: Reddit has 6 included launches, so H2 is reported descriptively", () => {
    assert.equal(release.hypotheses.h2.test.tested, false);
    assert.equal(release.hypotheses.h2.statementId, "method:h2-descriptive");
    assert.ok(statement(release, "method:h2-descriptive"));
  });

  test("h2-tested-variant: with 60 Reddit launches H2 is tested and Holm covers three tests", async () => {
    const store = raw();
    let moved = 0;
    for (const p of store.projects) if (p.source === "show-hn" && p.n % 5 === 0 && moved < 54) (p.source = "reddit"), moved++;
    const res = await exportRelease({ input: expandFixture(store), outDir: outDir() });
    const h2 = res.release.hypotheses.h2;
    assert.equal(h2.test.tested, true);
    assert.equal(h2.test.groups.reddit, 60);
    const input = expandFixture(store);
    const pub = res.model.tables.checkIds.filter((c) => res.model.tables.publishable.has(c));
    const pass = new Set(input.published.filter((s) => s.published === "pass").map((s) => `${s.projectN}|${s.checkId}`));
    const perm = h2Permutation({
      projects: input.projects.map((p) => ({ group: p.source, passes: pub.map((c) => pass.has(`${p.n}|${c}`)) })),
      seed: input.seed,
      groups: ["show-hn", "reddit", "github-only"],
    });
    const expected = testHypotheses({ h1: res.model.h1, h2: perm, h3: res.model.h3, recall: 59 / 66 });
    assert.equal(expected.tests.length, 3);
    assert.equal(h2.test.pAdjusted, expected.tests.find((t) => t.id === "h2").pAdjusted);
    assert.ok(statement(res.release, "hypothesis:h2"));
  });

  test("claims-pairs: per check the claimed row, then the publicly evidenced row", () => {
    const rows = release.figures.claims.rows;
    assert.equal(rows.length, 48);
    raw().checkIds.forEach((c, k) => {
      assert.equal(rows[2 * k].id, tupleId(c, "claimed", "all"));
      assert.equal(rows[2 * k + 1].id, tupleId(c, "pass", "all"));
    });
  });

  test("checks-by-partition: full check x state x partition tables for table views", () => {
    assert.equal(release.figures.checksByCohort.rows.length, 24 * 2 * 4);
    assert.equal(release.figures.checksBySource.rows.length, 24 * 2 * 3);
    for (const d of DECISIONS) assert.ok(release.figures[`checks:${d}`].rows.length > 0);
  });

  test("source-types-top8: at most eight types plus other, an overlap statement, and folding past eight", async () => {
    const rows = release.figures.sourceTypes.rows;
    assert.ok(rows.length <= 9);
    assert.ok(rows.every((r) => /^st\|[^|]+\|all$/.test(r.id)));
    assert.ok(statement(release, "method:source-types-overlap"));
    const store = raw();
    const extra = ["t1", "t2", "t3", "t4", "t5", "t6"];
    store.projects.forEach((p, i) => (p.sourceTypes = [...(p.sourceTypes ?? []), extra[i % extra.length]]));
    const m = model(store, FAST);
    assert.equal(m.sourceTypes.length, 9);
    assert.equal(m.sourceTypes.at(-1), "other");
  });

  test("prisma-merged: small reasons merged before they are tuples, totals pinned, no released count under 10", () => {
    const ex = Object.fromEntries(release.prisma.exclusions.map((e) => [e.id, e.row]));
    assert.ok(ex.other, "the two small exclusion reasons merge into other");
    assert.equal(ex["stage1:model-or-paper"], undefined);
    assert.equal(ex["not-collectable:redirected-off-boundary"], undefined);
    for (const r of [...release.prisma.exclusions, ...release.prisma.boxes].map((x) => x.row).filter(Boolean)) {
      if (r.state === "released") assert.ok(r.c >= 10 && r.n - r.c >= 10, r.id);
    }
    assert.deepEqual(release.prisma.boxes.map((b) => b.id), ["identified", "screened", "assessed", "included", "included-insufficient-text"]);
    const m = model();
    assert.ok(m.truth.constraints.some((c) => c.sense === "=" && c.rhs === 644 && c.terms.some((t) => t.id === "prisma|other")));
  });
});

describe("task 3: how we know, methods, validation, limitations, exploratory", () => {
  test("how-we-know: agreement per check, precision tuples, labeller and confirmer", () => {
    const h = release.howWeKnow;
    assert.equal(h.n, 300);
    assert.equal(Object.keys(h.agreement).length, 24);
    assert.equal(h.labeller.wording, "agreement with an independent labeller");
    assert.equal(h.labeller.modelId, "synthetic-model-d");
    assert.equal(h.confirmer.modelId, "synthetic-model-e");
    const gate = new Map(raw().gate.checks.map((g) => [g.checkId, g]));
    for (const [c, a] of Object.entries(h.agreement)) {
      const pass = allRows(release.figures).find((r) => r.id === tupleId(c, "pass", "all"));
      if (pass.state === "released") assert.equal(a.ac1, Math.round(100 * gate.get(c).ac1) / 100, c);
      else assert.equal(a.ac1, null, c);
      assert.equal(a.precision.id, `prec|${c}`);
    }
    // 18 of 20: the complement is under 10, so precision is suppressed and the export still passed;
    // the not-estimable check has fewer than ten gold passes, so its precision count shows <10
    for (const [c, a] of Object.entries(h.agreement)) assert.equal(a.precision.state, c === "recovery-tested" ? "lt10" : "suppressed", c);
  });

  test("person-edits-computed: 0 gives the no-human-edits line; one edit gives the share instead", async () => {
    assert.deepEqual(release.howWeKnow.personEdits, { count: 0, total: 7200 });
    assert.equal(statement(release, "validation:person-edits").text, "Agent roles, no human edits.");
    const store = raw();
    store.edits = [{ projectN: 1, checkId: "output-reproducible" }];
    const res = await fast(store);
    assert.deepEqual(res.release.howWeKnow.personEdits, { count: 1, total: 7200 });
    assert.equal(statement(res.release, "validation:person-edits").text, "1 of 7200 published check states (0%) were edited by a person.");
    assert.doesNotMatch(statement(res.release, "limitation:agent-roles").text, /No human edited/);
  });

  test("process-figures-listed: exactly the four D-83 figures, each with addendum A14", () => {
    assert.deepEqual(
      manifest.processFigures.map((f) => f.id),
      ["screening-audit", "collection-recall", "person-edits", "confirmation-total"],
    );
    assert.ok(manifest.processFigures.every((f) => f.addendum === "A14" && f.reason));
    assert.deepEqual(manifest.processFigures.map((f) => f.id), PROCESS_FIGURES.map((f) => f.id));
    assert.equal(manifest.kind, "fixture");
  });

  test("confirmation-total-pins-split: the total is published and the split is a pinned tuple pair", async () => {
    const c = release.howWeKnow.confirmation;
    const letters = raw().projects.flatMap((p) => [...p.states]);
    assert.equal(c.total.changed, letters.filter((s) => s === "x" || s === "d").length);
    assert.equal(c.total.proposed, letters.filter((s) => "pcdx".includes(s)).length);
    assert.equal(c.total.pct, Math.round((1000 * c.total.changed) / c.total.proposed) / 10);
    const m = model();
    assert.ok(hasRow(m, [["conf|rejected", 1], ["conf|downgraded", 1]], "=", c.total.changed));
    assert.ok(m.truth.constraints.some((r) => r.sense === "=" && r.rhs === c.total.changed && r.terms.length === 24));
    // variant: 4 rejected, 30 downgraded
    const store = raw();
    let x = 0;
    let d = 0;
    for (const p of store.projects) {
      p.states = [...p.states].map((s) => (s === "x" ? (x++ < 4 ? "x" : "u") : s === "d" ? (d++ < 30 ? "d" : "c") : s)).join("");
    }
    const res = await fast(store);
    const v = res.release.howWeKnow.confirmation;
    assert.equal(v.total.changed, 34);
    assert.equal(v.rejected.state, "lt10");
    assert.equal(v.downgraded.state, "suppressed");
    assert.ok(res.manifest.audit.added.includes("conf|downgraded"), "closure added the downgraded tuple");
    assert.equal(res.line.audit, "pass(all,interior)");
  });

  test("d76-limitations: every D-76 and PUB-05 item, with the 04-08 recall counts", () => {
    for (const id of [
      "limitation:screening",
      "exploratory:screening-remeasure",
      "limitation:recall",
      "limitation:gathered-items",
      "limitation:collector-change",
      "exploratory:collector-cross-check",
      "limitation:whole-page-spans",
      "limitation:agent-roles",
      "limitation:provider-visibility",
      "limitation:cohort-survivorship",
      "limitation:not-done",
      "limitation:sampling-frame",
    ]) {
      assert.ok(statement(release, id), id);
    }
    assert.equal(
      statement(release, "limitation:screening").text,
      "Screening missed its pre-registered target: 12.2% of audited exclusions were in error (5 of 41, 95% CI 5.3–25.5%) against a 10% bar. This is a selection limitation.",
    );
    assert.match(statement(release, "limitation:recall").text, /0\.894 \(59 of 66; 8 of 10 projects contributed\); raw recall 0\.887 \(141 of 159\)/);
    assert.match(statement(release, "limitation:gathered-items").text, /Of 159 gathered items, 66 \(42%\) were supported and 93 \(58%\) unsupported, 27 \(17%\)/);
    assert.equal(statement(release, "exploratory:screening-remeasure").kind, "exploratory");
    assert.equal(statement(release, "exploratory:collector-cross-check").kind, "exploratory");
    assert.equal(release.validation.crossCheck.positiveAgreement, 0.78);
    assert.equal(release.validation.visibility.row.id, "vis|provider-only");
    assert.equal(statement(release, "limitation:not-done").text, "Not publicly evidenced does not mean not done.");
  });

  test("community-absent: no community input gives null and the one-line note", () => {
    assert.equal(release.exploratory.community, null);
    assert.equal(statement(release, "exploratory:community").text, "The community layer (addendum A4) is not part of this release.");
  });

  test("community-tuples: community counts are exploratory tuples, suppressed under 10", async () => {
    const store = raw();
    store.community = { "support-claim-reply-seen": 34, "support-claim-no-reply": 7 };
    const res = await fast(store);
    const rows = Object.fromEntries(res.release.exploratory.community.rows.map((r) => [r.id, r]));
    assert.equal(rows["comm|support-claim-reply-seen|all"].state, "released");
    assert.equal(rows["comm|support-claim-no-reply|all"].state, "lt10");
    assert.equal(statement(res.release, "exploratory:community").kind, "exploratory");
  });

  test("no-worked-case: no worked-case statement, a clean scan, and the worked case's id refuses", async () => {
    assert.ok(!release.statements.some((s) => s.kind === "worked-case"));
    const set = buildIdentifierSet({ projects: raw().projects });
    const texts = ["ledger.json", "v1/release.json", "v1/manifest.json"].map((f) => ({ file: f, text: fs.readFileSync(path.join(COMMITTED, f), "utf8") }));
    assert.deepEqual(scanTexts(texts, set), []);
    const store = raw();
    store.notes = [{ id: "method:case", kind: "method", text: `See item ${ARTCRAFT_HN_ID}.` }];
    assert.match(cli(store).stdout, /^EXPORT REFUSED: identifier /m);
  });

  test("methods: roles with model, host and manifest values; codebook relations without standard text", () => {
    const m = release.methods;
    assert.equal(m.roles.length, 8);
    assert.ok(m.roles.every((r) => r.kind === "agent" && r.modelId && r.host && r.manifest.seed));
    assert.deepEqual(m.disclosure, { floor: 10, minValues: 5, priors: ["all", "interior"] });
    assert.equal(m.codebook.length, 24);
    for (const c of m.codebook) for (const r of c.relations) assert.deepEqual(Object.keys(r).sort(), ["clause", "relation", "standard"]);
    for (const id of ["method:eligibility", "method:frame", "method:collection", "method:self-claim", "method:confirmation", "method:gate", "method:disclosure", "method:hypotheses"]) {
      assert.equal(statement(release, id)?.kind, "method", id);
    }
  });

  test("no row that is not released carries a number", () => {
    for (const r of allRows(release)) {
      if (r.state === "released") continue;
      for (const k of ["c", "n", "pct", "ci"]) assert.equal(r[k], undefined, `${r.id} ${k}`);
    }
  });
});
