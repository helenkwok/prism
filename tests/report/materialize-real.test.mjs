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

const mem = () => new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });

async function decidedLocal() {
  const { db } = await run();
  // The synthetic corpus marks its views as fixture rows; a real local database has none.
  for (const t of ["app_report_view", "app_snapshot", "app_method_view", "app_project_access"]) await db.updateTable(t).set({ fixture: 0 }).execute();
  await db.updateTable("app_project_access").set({ basis: "own" }).where("project_id", "=", "P01").execute();
  await db.updateTable("app_project_access").set({ basis: "opt-in", sponsor_hold: 1 }).where("project_id", "=", "P02").execute();
  return db;
}

async function appWithFixtureAndOwn() {
  const { upsertProjectAccess, ensureAccessSchema } = await import("../../src/app/server/access-store.ts");
  const { ensureReportViewSchema, upsertReportView, upsertMethodView } = await import("../../src/report/store.ts");
  const app = mem();
  await ensureReportViewSchema(app);
  await ensureAccessSchema(app);
  await upsertProjectAccess(app, { projectId: "FIX1", title: "fixture", basis: "own", sponsorHold: false, inSample: true, pseudonym: "AAAAA", fixture: true });
  await upsertReportView(app, { projectRef: "FIX1", view: "identifiable", fixture: true, generatedAt: "2026-01-01" });
  await upsertMethodView(app, { fixture: true, generatedAt: "2026-01-01" });
  await upsertProjectAccess(app, { projectId: "OWN-LIVE", title: "own", basis: "own", sponsorHold: false, inSample: false, liveBoundaryJson: "[]" });
  await upsertReportView(app, { projectRef: "OWN-LIVE", view: "identifiable", fixture: false, generatedAt: "2026-01-01" });
  return app;
}

test("a pack holds identifiable views and snapshots only for a basis without a hold; the load replaces fixture rows and keeps live-run own rows", async () => {
  const { buildPack, loadPack } = await import("../../src/report/judge-pack.ts");
  const local = await decidedLocal();
  const pack = mem();
  const counts = await buildPack(local, pack);
  assert.equal(counts.identifiable, 1);
  assert.equal(counts.deid, corpus.projects.length);
  assert.equal(counts.method, 1);
  const ident = await pack.selectFrom("app_report_view").select("project_ref").where("view", "=", "identifiable").execute();
  assert.deepEqual(ident.map((r) => r.project_ref), ["P01"]);
  assert.ok((await pack.selectFrom("app_snapshot").select("project_ref").execute()).every((r) => r.project_ref === "P01"));

  const app = await appWithFixtureAndOwn();
  await loadPack(pack, app);
  const refs = (await app.selectFrom("app_report_view").select(["project_ref", "fixture"]).execute());
  assert.ok(!refs.some((r) => r.fixture === 1), "no fixture view left");
  assert.ok(refs.some((r) => r.project_ref === "OWN-LIVE"), "live-run own report kept");
  assert.ok(!(await app.selectFrom("app_project_access").select("fixture").execute()).some((r) => r.fixture === 1));
  assert.equal((await app.selectFrom("app_method_view").select("fixture").executeTakeFirst()).fixture, 0);
  for (const d of [local, pack, app]) await d.destroy();
});

test("a tampered pack (an identifiable view without a basis) is refused with nothing written", async () => {
  const { buildPack, loadPack, PackRefusal } = await import("../../src/report/judge-pack.ts");
  const local = await decidedLocal();
  const pack = mem();
  await buildPack(local, pack);
  const p05 = await local.selectFrom("app_report_view").selectAll().where("project_ref", "=", "P05").where("view", "=", "identifiable").executeTakeFirst();
  await pack.insertInto("app_report_view").values(p05).execute();
  const app = await appWithFixtureAndOwn();
  await assert.rejects(loadPack(pack, app), PackRefusal);
  assert.equal((await app.selectFrom("app_report_view").select("fixture").where("fixture", "=", 1).execute()).length, 1, "fixture rows untouched");
  for (const d of [local, pack, app]) await d.destroy();
});
