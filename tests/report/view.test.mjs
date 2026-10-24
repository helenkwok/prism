// APP-04 / SC3: the gate-first ReportView read model (plan 07-03), proven on
// the synthetic corpus with the vendored JS evaluator injected as the gate.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { ensureReportViewSchema, listReportViews, readReportView, upsertReportView } from "../../src/report/store.ts";
import { buildReportView, CROSSWALK_ORDER, gapTextDigest, loadGapText, productName, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, corpusPath, gatesPath, jsRunGate, order, root } from "./js-gate.mjs";

const DECISIONS = ["explore", "rely", "operate", "measure-outcome", "scale-renew-stop"];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prism-report-view-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const passRuleOnly = loadGapText({ repoRoot: scratch, codebook }); // scratch has no protocol/gap-text.json
const project = (id) => corpus.projects.find((p) => p.projectId === id);
const source = (id) => sourceFromFixture(corpus, project(id), order);

async function build(id, { runGate = jsRunGate, gapText = passRuleOnly } = {}) {
  return buildReportView(source(id), { codebook, gatesPath, runGate, gapText });
}
const check = (view, id) => view.checks.find((c) => c.checkId === id);

describe("ReportView builder (APP-04)", () => {
  test("decision order: five decisions first, in decision-gates order, statuses from the injected gate, then 24 checks in codebook order", async () => {
    const v = await build("P01");
    assert.deepEqual(Object.keys(v).slice(0, 12), ["version", "view", "projectRef", "title", "fixture", "generatedAt", "codebookVersion", "gateSha", "collection", "decisions", "checks", "howMade"]);
    assert.deepEqual(v.decisions.map((d) => d.decisionId), DECISIONS);
    assert.deepEqual(v.decisions.map((d) => d.status), ["PASS", "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
    assert.deepEqual(v.checks.map((c) => c.checkId), Object.keys(codebook.checks));
    assert.deepEqual(v.checks.map((c) => c.checkId), order);
    for (const d of v.decisions) {
      const t = d.tally;
      assert.equal(t.pass + t.claimed + t.unknown + t.fail + t.awaiting, d.requiredChecks.length, d.decisionId);
    }
    assert.deepEqual(v.decisions[1].tally, { pass: 2, claimed: 1, unknown: 1, fail: 0, awaiting: 1 });

    // The verdict is whatever the gate returns, never computed by the builder.
    const forced = await build("P02", { runGate: async () => ({ status: "BLOCKED", raw: null, gateSha: "forced" }) });
    assert.deepEqual(forced.decisions.map((d) => d.status), Array(5).fill("BLOCKED"));
    assert.equal(forced.gateSha, "forced");
  });

  test("awaiting-as-unknown: a published null reaches the gate as unknown and is tallied as awaiting; downgraded shows claimed, rejected shows unknown", async () => {
    const seen = [];
    const spy = async (record) => {
      seen.push(structuredClone(record));
      return jsRunGate(record);
    };
    const v = await build("P01", { runGate: spy });
    const awaiting = check(v, "acceptance-criteria-met");
    assert.equal(awaiting.published, null);
    assert.equal(awaiting.basis, "unconfirmed");
    const rely = seen.find((r) => r.targetDecision === "rely");
    assert.equal(rely.gateChecks["acceptance-criteria-met"], "unknown");
    // the cited span of an unconfirmed positive is not offered to the gate as evidence
    assert.ok(!rely.evidenceRefs.some((r) => r.includes(`#${project("P01").cites["acceptance-criteria-met"][0]}`)));
    assert.equal(v.decisions.find((d) => d.decisionId === "rely").tally.awaiting, 1);

    const down = check(v, "acceptance-criteria-defined");
    assert.deepEqual([down.published, down.basis], ["claimed", "downgraded"]);
    assert.equal(rely.gateChecks["acceptance-criteria-defined"], "unknown");
    const rej = check(v, "failure-modes-tested");
    assert.deepEqual([rej.published, rej.basis], ["unknown", "rejected"]);

    // P03: a stale confirmation is awaiting too
    const p3 = await build("P03");
    assert.deepEqual([check(p3, "intended-use-defined").published, check(p3, "intended-use-defined").basis], [null, "stale"]);
    assert.equal(p3.decisions.find((d) => d.decisionId === "rely").tally.awaiting, 1);
  });

  test("zero-pages: P04 has every check unknown with no quotes and every decision INSUFFICIENT_EVIDENCE", async () => {
    const v = await build("P04");
    assert.equal(v.collection.pages, 0);
    assert.deepEqual(v.collection.urls, []);
    for (const c of v.checks) {
      assert.equal(c.published, "unknown", c.checkId);
      assert.deepEqual(c.quotes, []);
    }
    assert.deepEqual(v.decisions.map((d) => d.status), Array(5).fill("INSUFFICIENT_EVIDENCE"));
  });

  test("chips-without-text: crosswalk chips follow codebook.md edges in the fixed standard order and copy no title or qualification", async () => {
    const v = await build("P02");
    for (const c of v.checks) {
      const expected = CROSSWALK_ORDER.flatMap((std) =>
        (codebook.checks[c.checkId].crosswalk[std] ?? []).map((e) => ({ standard: std, locator: e.locator, relationType: e.relation_type, informational: e.informational === true })),
      );
      assert.deepEqual(c.crosswalk, expected, c.checkId);
      for (const chip of c.crosswalk) assert.deepEqual(Object.keys(chip), ["standard", "locator", "relationType", "informational"]);
    }
    assert.ok(v.checks.some((c) => c.crosswalk.some((x) => x.informational)), "the EU AI Act edges are informational");
    const json = JSON.stringify(v);
    for (const cb of Object.values(codebook.checks)) {
      for (const edges of Object.values(cb.crosswalk)) for (const e of edges) {
        assert.ok(!json.includes(e.qualification), "no qualification text");
        assert.ok(!json.includes(e.title), "no standard title text");
      }
    }
  });

  test("gap-text-on-non-pass-only: pass has gapText null; non-pass shows the codebook pass rule with gapSource passRule", async () => {
    const v = await build("P10");
    for (const c of v.checks) {
      if (c.published === "pass") assert.deepEqual([c.gapText, c.gapSource], [null, null], c.checkId);
      else assert.deepEqual([c.gapText, c.gapSource], [codebook.checks[c.checkId].passRule, "passRule"], c.checkId);
    }
    assert.ok(v.checks.some((c) => c.published !== "pass"));
  });

  test("gap-text file is used only with an approval bound to its digest", () => {
    const entries = Object.fromEntries(order.map((id) => [id, `Draft text for ${id}.`]));
    const write = (dir, approval) => {
      fs.mkdirSync(path.join(dir, "protocol"), { recursive: true });
      fs.writeFileSync(path.join(dir, "protocol", "gap-text.json"), JSON.stringify({ entries, approval }));
      return loadGapText({ repoRoot: dir, codebook });
    };
    const id = order[0];
    assert.equal(write(path.join(scratch, "a"), null)(id).source, "passRule");
    assert.equal(write(path.join(scratch, "b"), { actorId: "x", actorKind: "person", decidedAt: "2026-10-23", digest: "0".repeat(64) })(id).source, "passRule");
    const ok = write(path.join(scratch, "c"), { actorId: "x", actorKind: "person", decidedAt: "2026-10-23", digest: gapTextDigest(entries) })(id);
    assert.deepEqual(ok, { text: entries[id], source: "gap-text" });
  });

  test("exact quote text: quotes are the stored span text byte for byte (combining accent, markup-like characters)", async () => {
    const v = await build("P01");
    const spans = project("P01").spans;
    const all = v.checks.flatMap((c) => c.quotes);
    const accent = all.find((q) => q.text.includes("̀"));
    const markup = all.find((q) => q.text.includes("<script>"));
    assert.ok(accent && markup);
    assert.equal(accent.text, spans[accent.spanId].text);
    assert.notEqual(accent.text, accent.text.normalize("NFC"), "fixture keeps a decomposed accent");
    assert.equal(Buffer.compare(Buffer.from(accent.text), Buffer.from(spans[accent.spanId].text)), 0);
    assert.equal(markup.text, spans[markup.spanId].text);
    for (const q of all) assert.equal(q.text, spans[q.spanId].text);
    assert.equal(check(v, "baseline-defined").quotes.length, 0, "a check with no cited span has no quotes");
  });

  test("determinism: collection.urls in collection order and two builds are byte-identical", async () => {
    const a = await build("P01");
    const b = await build("P01");
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(a.collection.urls, project("P01").pages.map((p) => p.url));
    assert.equal(a.generatedAt, corpus.generatedAt);
    assert.deepEqual([a.collection.pages, a.collection.rendered, a.collection.notRendered], [3, 2, 1]);
    assert.equal(a.fixture, true);
  });

  test("store round trip: readReportView returns JSON equal to the built view", async () => {
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureReportViewSchema(db);
    const v = await build("P07");
    await upsertReportView(db, v);
    await upsertReportView(db, v); // idempotent
    const back = await readReportView(db, "P07", "identifiable");
    assert.equal(JSON.stringify(back), JSON.stringify(v));
    assert.equal(await readReportView(db, "P99", "identifiable"), null);
    assert.equal((await listReportViews(db, "identifiable")).length, 1);
    await db.destroy();
  });

  test("materialize-views prints one REPORT line per project and REPORT rows=10", () => {
    const res = spawnSync(process.execPath, ["scripts/materialize-views.mjs", "--fixture", corpusPath, "--js-gate", "--db", path.join(scratch, "views.sqlite")], { cwd: root, encoding: "utf8" });
    const lines = res.stdout.split("\n").filter((l) => l.startsWith("REPORT project="));
    assert.equal(lines.length, 10, res.stderr);
    for (const l of lines) assert.match(l, /view=identifiable decisions=5 checks=24 gapSource=/);
    assert.match(res.stdout, /^REPORT rows=10$/m);
  });

  test("synthetic corpus: every host is .example", () => {
    const raw = fs.readFileSync(corpusPath, "utf8");
    assert.equal(corpus.synthetic, true);
    assert.equal(corpus.projects.length, 10);
    const urls = raw.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    assert.ok(urls.length > 10);
    for (const u of urls) {
      const host = new URL(u).hostname;
      assert.ok(host.endsWith(".example"), u);
    }
    const hosts = [...(raw.match(/\b[\w.-]+\.[a-z]{2,}\b/gi) ?? [])].filter((h) => /\.(com|ai|io|net|org|dev|co)$/i.test(h));
    assert.deepEqual([...new Set(hosts)].filter((h) => h !== "github.com"), []);
    for (const e of raw.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) assert.ok(e.endsWith(".example"), e);
    const shared = corpus.projects.filter((p) => Object.values(p.spans).some((s) => s.text.includes("We do not use your data to train our models")));
    assert.deepEqual(shared.map((p) => p.projectId), ["P02", "P05", "P07"]);
  });
});

// Task 3: Helen's 07-03 answers (07-03-DECISIONS.md): "option-b, P2, hidden, launch title".
describe("Helen's report-content answers (07-03 Task 3)", () => {
  const gapFile = path.join(root, "protocol", "gap-text.json");
  const BANNED = /lack|missing|fail|non-compliant|blocked|compliant|certified|score|\bfirst\b|\bonly\b/i;
  const STANDARD_TEXT = /\b(ISO|IEC|NIST|RMF|AI Act|OECD|GAICC|Annex|clause|shall)\b/i;

  test("option-b: protocol/gap-text.json drafts exactly the 24 gate checks in evidence language, approval null", () => {
    const g = JSON.parse(fs.readFileSync(gapFile, "utf8"));
    assert.deepEqual(Object.keys(g.entries), order);
    assert.equal(g.approval, null);
    assert.match(g.digestNote, /actorId, actorKind, decidedAt, digest/);
    for (const [id, text] of Object.entries(g.entries)) {
      assert.equal(typeof text, "string", id);
      assert.ok(text.length > 40, id);
      assert.ok((text.match(/[.!?](\s|$)/g) ?? []).length <= 2, `${id}: one or two sentences`);
      assert.doesNotMatch(text, BANNED, id);
      assert.doesNotMatch(text, STANDARD_TEXT, id);
      assert.notEqual(text, codebook.checks[id].passRule, id);
    }
  });

  test("option-b: gapSource stays passRule while approval is null, and becomes gap-text with a matching approval digest on a temp copy", async () => {
    const live = loadGapText({ repoRoot: root, codebook });
    for (const id of order) assert.deepEqual(live(id), { text: codebook.checks[id].passRule, source: "passRule" });
    const v = await buildReportView(source("P01"), { codebook, gatesPath, runGate: jsRunGate, gapText: live });
    assert.deepEqual([...new Set(v.checks.map((c) => c.gapSource).filter(Boolean))], ["passRule"]);

    const g = JSON.parse(fs.readFileSync(gapFile, "utf8"));
    g.approval = { actorId: "test-signoff", actorKind: "person", decidedAt: "2026-10-23T00:00:00Z", digest: gapTextDigest(g.entries) };
    const dir = path.join(scratch, "approved");
    fs.mkdirSync(path.join(dir, "protocol"), { recursive: true });
    fs.writeFileSync(path.join(dir, "protocol", "gap-text.json"), JSON.stringify(g));
    const approved = loadGapText({ repoRoot: dir, codebook });
    const va = await buildReportView(source("P01"), { codebook, gatesPath, runGate: jsRunGate, gapText: approved });
    for (const c of va.checks) {
      if (c.published === "pass") assert.equal(c.gapText, null);
      else assert.deepEqual([c.gapText, c.gapSource], [g.entries[c.checkId], "gap-text"], c.checkId);
    }
  });

  test("launch title: the report title is the product name from the launch post title", async () => {
    assert.equal(productName("Show HN: Example Notes (synthetic) – meeting notes you can check"), "Example Notes (synthetic)");
    assert.equal(productName("Show HN: Example Routes (synthetic) - plan routes"), "Example Routes (synthetic)");
    assert.equal(productName("Show HN: Example Replies (synthetic): draft replies"), "Example Replies (synthetic)");
    assert.equal(productName("Show HN: Bare Name"), "Bare Name");
    assert.equal((await build("P07")).title, "Example Planner (synthetic)");
    // Q4 chose the launch title, so a company-supplied display_title is not used.
    const withDisplay = { ...source("P05"), display_title: "Another Name" };
    const v = await buildReportView(withDisplay, { codebook, gatesPath, runGate: jsRunGate, gapText: passRuleOnly });
    assert.equal(v.title, "Example Sorter (synthetic)");
  });
});
