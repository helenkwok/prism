// APP-03 / SC4: the method audit read model (plan 07-10). Agreement with the
// independent labeller, PRISMA counts, the codebook and the confirmation
// records, built once at materialisation from the synthetic method fixture
// and the synthetic corpus.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { buildMethodView, codebookEntries, decisionLabelsOf } from "../../src/report/method-view.ts";
import { ensureReportViewSchema, readMethodView, upsertMethodView } from "../../src/report/store.ts";
import { buildReportView, loadGapText, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, corpusPath, gatesPath, jsRunGate, order, root } from "./js-gate.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prism-method-view-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const method = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "report", "synthetic-method.json"), "utf8"));
const gapText = loadGapText({ repoRoot: scratch, codebook });

async function projects() {
  const out = [];
  for (const p of corpus.projects) {
    const view = await buildReportView(sourceFromFixture(corpus, p, order), { codebook, gatesPath, runGate: jsRunGate, gapText });
    out.push({ view, pseudonym: `PS${p.projectId.slice(1)}X` });
  }
  return out;
}

const decisionLabels = decisionLabelsOf(gatesPath);
const build = async (over = {}) => buildMethodView({ method, codebook, gapText, decisionLabels, projects: await projects(), ...over });

describe("buildMethodView (APP-03 method audit)", () => {
  test("agreement: one row per check in codebook order; released rows carry AC1, its CI and precision c of m", async () => {
    const v = await build();
    assert.deepEqual(v.agreement.rows.map((r) => r.checkId), Object.keys(codebook.checks));
    assert.equal(v.agreement.rows.length, 24);
    assert.deepEqual(v.agreement.labeller, { role: "independent labeller", modelId: "zai-org/GLM-5.3", host: "inference.example" });
    const r = v.agreement.rows.find((x) => x.checkId === "output-reproducible");
    assert.equal(r.state, "released");
    assert.equal(r.label, codebook.checks["output-reproducible"].label);
    assert.equal(r.ac1, 0.72);
    assert.deepEqual(r.ac1CI, [0.63, 0.78]);
    assert.deepEqual(r.precision, { c: 11, m: 12 });
    assert.equal(r.text, null);
  });

  test("withheld and not-estimable rows carry the explicit-state words and no numbers", async () => {
    const v = await build();
    const withheld = v.agreement.rows.filter((r) => r.state === "withheld");
    const ne = v.agreement.rows.filter((r) => r.state === "not-estimable");
    assert.equal(withheld.length, 3);
    assert.equal(ne.length, 4);
    for (const r of [...withheld, ...ne]) {
      assert.equal(r.ac1, null);
      assert.equal(r.ac1CI, null);
      assert.equal(r.precision, null);
      assert.doesNotMatch(r.text, /\d/);
    }
    assert.equal(withheld[0].text, "withheld: agreement below the pre-registered threshold");
    assert.equal(ne[0].text, "not estimable: too few gold passes to estimate agreement");
  });

  test("every Phase 4 gate status maps to a state; an unknown status or a missing check is refused", async () => {
    const one = (status) => ({ ...method, agreement: method.agreement.map((a, i) => (i === 0 ? { ...a, status, reason: "r" } : a)) });
    assert.equal((await build({ method: one("corrected-revalidated") })).agreement.rows[0].state, "released");
    assert.equal((await build({ method: one("missed") })).agreement.rows[0].text, "withheld: r");
    assert.equal((await build({ method: one("person-coded") })).agreement.rows[0].text, "person-coded: r");
    await assert.rejects(build({ method: one("maybe") }), /unknown agreement status/);
    await assert.rejects(build({ method: { ...method, agreement: method.agreement.slice(1) } }), /no agreement entry for output-reproducible/);
  });

  test("PRISMA counts are labelled integers, in fixture order", async () => {
    const v = await build();
    assert.deepEqual(v.prisma, method.prisma);
    for (const p of v.prisma) assert.ok(Number.isInteger(p.count) && typeof p.label === "string");
  });

  test("codebook: 24 entries with definition, the three rules, crosswalk chips and gap text", async () => {
    const v = await build();
    assert.equal(v.codebook.length, 24);
    const e = v.codebook.find((x) => x.checkId === "intended-use-defined");
    const cb = codebook.checks["intended-use-defined"];
    assert.equal(e.label, cb.label);
    assert.equal(e.decision, cb.decision);
    assert.equal(e.decisionLabel, "Permit reliance for the named use");
    // The same entries stand alone for /method before any method row is stored.
    assert.deepEqual(codebookEntries(codebook, gapText, decisionLabels), v.codebook);
    assert.equal(e.operationalDefinition, cb.operationalDefinition);
    assert.equal(e.passRule, cb.passRule);
    assert.equal(e.claimedRule, cb.claimedRule);
    assert.equal(e.failRule, cb.failRule);
    assert.ok(e.crosswalk.length > 0);
    assert.deepEqual(Object.keys(e.crosswalk[0]).sort(), ["informational", "locator", "relationType", "standard"]);
    assert.equal(e.gapText, gapText("intended-use-defined").text);
  });

  test("confirmation records: one per corpus confirmation, each with its project id, pseudonym and title", async () => {
    const v = await build();
    const expected = corpus.projects.reduce((n, p) => n + Object.values(p.confirmations ?? {}).reduce((m, rs) => m + rs.length, 0), 0);
    assert.ok(expected > 0);
    assert.equal(v.confirmations.length, expected);
    const p02 = v.confirmations.filter((r) => r.projectId === "P02");
    assert.ok(p02.length > 0);
    for (const r of p02) {
      assert.equal(r.pseudonym, "PS02X");
      assert.equal(r.title, "Ledgerline");
      assert.equal(r.proposed, "pass");
      assert.ok(["confirmed", "downgraded", "rejected"].includes(r.decision));
      assert.ok(r.checkLabel && r.role && r.decidedAt);
    }
  });

  test("how this was made: roles, labeller, codebook and gate versions", async () => {
    const v = await build();
    assert.equal(v.howMade.coding.modelId, "nvidia/Nemotron-3-Ultra-550b-a55b");
    assert.equal(v.howMade.confirmation.role, "confirmer");
    assert.equal(v.howMade.labeller.modelId, "zai-org/GLM-5.3");
    assert.equal(v.howMade.codebookVersion, "v1.0");
    assert.equal(v.howMade.gateSha, "js-test");
    assert.equal(v.fixture, true);
  });
});

describe("method view store", () => {
  test("a missing method row reads back as null; a written one reads back unchanged", async () => {
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureReportViewSchema(db);
    assert.equal(await readMethodView(db), null);
    const v = await build();
    await upsertMethodView(db, v);
    await upsertMethodView(db, v); // singleton: a second write replaces the first
    assert.deepEqual(await readMethodView(db), v);
    const n = await db.selectFrom("app_method_view").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
    assert.equal(Number(n.n), 1);
    await db.destroy();
  });

  test("materialize-views --fixture writes the singleton method row and prints the METHOD line", () => {
    const dbPath = path.join(scratch, "m.sqlite");
    const r = spawnSync(process.execPath, ["scripts/materialize-views.mjs", "--fixture", corpusPath, "--js-gate", "--db", dbPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^METHOD rows=1 checks=24 confirmations=\d+$/m);
    const row = new Database(dbPath, { readonly: true }).prepare("select json, fixture from app_method_view").all();
    assert.equal(row.length, 1);
    assert.equal(row[0].fixture, 1);
    assert.equal(JSON.parse(row[0].json).agreement.rows.length, 24);
  });
});
