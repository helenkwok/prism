// Plan 07-14: store mode on the synthetic corpus (no real data): identifiable and de-identified views,
// the method view, access rows with sponsor holds, the worked case left out, one local database only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { materializeStore } from "../../src/report/materialize-store.ts";
import { loadGapText, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, gatesPath, jsRunGate, order, root } from "./js-gate.mjs";

const method = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/report/synthetic-method.json"), "utf8"));
const gapText = loadGapText({ repoRoot: root, codebook });
const KEY = "test-key-0123456789abcdef";

function loaded(p, extra = []) {
  const spans = Object.entries(p.spans).map(([spanId, s]) => ({ projectId: p.projectId, spanId, text: s.text, url: s.url }));
  return { source: sourceFromFixture(corpus, p, order), snapshots: p.snapshots ?? {}, spans: [...spans, ...extra.map((text, i) => ({ projectId: p.projectId, spanId: `x${i}`, text, url: p.pages[0]?.url ?? null }))] };
}

async function run({ workedCase = [], extra = {} } = {}) {
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  const res = await materializeStore({
    entries: corpus.projects.map((p) => ({ projectId: p.projectId, hnId: p.hnId })),
    sourceOf: async (e) => loaded(corpus.projects.find((p) => p.projectId === e.projectId), extra[e.projectId]),
    workedCaseHnIds: workedCase,
    key: KEY,
    codebook,
    gatesPath,
    runGate: jsRunGate,
    gapText,
    method: { ...method, synthetic: false },
    db,
  });
  return { db, res };
}

test("builds identifiable and de-identified views for every sampled project, one method view and access rows", async () => {
  const { db, res } = await run();
  const n = corpus.projects.length;
  assert.equal(res.deidViews, n);
  assert.equal(res.reportRows, 2 * n);
  const views = await db.selectFrom("app_report_view").select(["view"]).execute();
  assert.equal(views.filter((v) => v.view === "identifiable").length, n);
  assert.equal(views.filter((v) => v.view === "deidentified").length, n);
  assert.equal((await db.selectFrom("app_method_view").selectAll().execute()).length, 1);
  const access = await db.selectFrom("app_project_access").selectAll().execute();
  assert.equal(access.length, n);
  assert.ok(access.every((a) => a.basis === null && a.in_sample === 1 && a.pseudonym && a.fixture === 0));
  await db.destroy();
});

test("a Nemotron mention holds its project; an employee count over 50 is a candidate with its quote", async () => {
  const { db, res } = await run({ extra: { P03: ["Built on Nemotron models."], P05: ["We are 120 employees in four cities."] } });
  const held = await db.selectFrom("app_project_access").select("project_id").where("sponsor_hold", "=", 1).execute();
  assert.deepEqual(held.map((r) => r.project_id), ["P03"]);
  assert.deepEqual(res.candidates.map((c) => [c.projectId, c.pattern]), [["P05", "employees"]]);
  assert.match(res.candidates[0].quote, /120 employees/);
  await db.destroy();
});

test("the A3 worked case gets no row", async () => {
  const { db, res } = await run({ workedCase: [corpus.projects[0].hnId] });
  assert.equal(res.excludedWorkedCase, 1);
  const ids = (await db.selectFrom("app_project_access").select("project_id").execute()).map((r) => r.project_id);
  assert.ok(!ids.includes(corpus.projects[0].projectId));
  await db.destroy();
});

test("another project's rare name in a quote is word-masked in every view, and the scan passes", async () => {
  const saved = corpus.projects[2].spans.s001.text;
  corpus.projects[2].spans.s001.text = `${saved} Compare p02.example too.`;
  try {
    const { db } = await run();
    const p03 = (await db.selectFrom("app_project_access").select("pseudonym").where("project_id", "=", "P03").executeTakeFirst()).pseudonym;
    const row = await db.selectFrom("app_report_view").select("json").where("project_ref", "=", p03).where("view", "=", "deidentified").executeTakeFirst();
    assert.ok(row, "de-identified view of P03 written");
    assert.doesNotMatch(row.json, /p02/i);
    assert.match(row.json, /▇▇ too\./);
    await db.destroy();
  } finally {
    corpus.projects[2].spans.s001.text = saved;
  }
});

test("vocabulary means every word is in the quotes of VOCAB_DF or more projects", async () => {
  const { isVocabulary } = await import("../../src/report/deidentify.ts");
  const corpusDf = { df: new Map([["memory", 12], ["agent", 30], ["zyxo", 1]]), grams: new Map() };
  assert.equal(isVocabulary("memory", corpusDf), true);
  assert.equal(isVocabulary("agent-memory", corpusDf), true);
  assert.equal(isVocabulary("zyxo-agent", corpusDf), false);
  assert.equal(isVocabulary("unseen", corpusDf), false);
});
