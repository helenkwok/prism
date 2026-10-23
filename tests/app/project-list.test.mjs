// APP-01 / 07-UI-SPEC project list: projectListFor returns exactly the rows a
// role may open, in a stable order, 50 to a page. Synthetic rows only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_SIZE, projectListFor } from "../../src/app/server/list-fns.ts";

const access = (projectId, extra = {}) => ({
  projectId,
  basis: null,
  sponsorHold: false,
  inSample: true,
  title: `Show HN: Title ${projectId} – x`,
  pseudonym: `PS${projectId}`,
  fixture: true,
  ...extra,
});
const summary = (projectRef, view, extra = {}) => ({
  projectRef,
  view,
  title: view === "identifiable" ? `Title ${projectRef}` : null,
  passCount: 2,
  generatedAt: "2026-10-20T10:00:00Z",
  collectedAt: "2026-10-01T09:00:00Z",
  fixture: true,
  ...extra,
});

const rows = [
  access("P01", { basis: "own" }),
  access("P02"),
  access("P03", { basis: "well-known", sponsorHold: true }),
  access("P05", { basis: "opt-in" }),
  access("P09", { inSample: false, pseudonym: null }),
];
const summaries = [
  ...rows.map((r) => summary(r.projectId, "identifiable", { passCount: Number(r.projectId.slice(1)) % 6 })),
  ...rows.filter((r) => r.pseudonym).map((r) => summary(r.pseudonym, "deidentified")),
];

test("admin gets every access row with access basis, hold and review link", () => {
  const list = projectListFor("admin", [], rows, summaries, 1);
  assert.deepEqual(list.identifiable.rows.map((r) => r.projectId), ["P01", "P02", "P03", "P05", "P09"]);
  const p03 = list.identifiable.rows.find((r) => r.projectId === "P03");
  assert.equal(p03.basis, "well-known");
  assert.equal(p03.sponsorHold, true);
  assert.equal(p03.reviewN, 3);
  assert.equal(list.identifiable.rows.find((r) => r.projectId === "P09").reviewN, null, "not in the sample");
  assert.equal(list.deidentified, null);
  assert.equal(list.fixture, true);
});

test("judge: identifiable only with a basis and no hold; every other sampled project de-identified, held ones included", () => {
  const list = projectListFor("judge", [], rows, summaries, 1);
  assert.deepEqual(list.identifiable.rows.map((r) => r.projectId), ["P01", "P05"]);
  assert.deepEqual(list.deidentified.rows.map((r) => r.pseudonym), ["PSP02", "PSP03"]);
  // No title, project id, basis or hold on a de-identified row; no access detail on identifiable rows.
  for (const r of list.deidentified.rows) assert.deepEqual(Object.keys(r).sort(), ["collected", "passCount", "pseudonym"]);
  for (const r of list.identifiable.rows) {
    assert.equal(r.sponsorHold, undefined);
    assert.equal(r.reviewN, undefined);
  }
  const all = JSON.stringify(list);
  assert.ok(!all.includes("Title P02") && !all.includes("Title P03"), "no de-identified title");
  assert.ok(!all.includes('"P02"') && !all.includes('"P03"'), "no pseudonym-to-project link");
  assert.ok(!all.includes("P09"), "out-of-sample project absent");
});

test("judge never sees a hold: a held project is listed de-identified like any other", () => {
  const list = projectListFor("judge", [], rows, summaries, 1);
  assert.ok(!JSON.stringify(list).toLowerCase().includes("hold"));
});

test("company gets exactly its grants, one row as a one-row table", () => {
  const one = projectListFor("company", ["P05"], rows, summaries, 1);
  assert.deepEqual(one.identifiable.rows.map((r) => r.projectId), ["P05"]);
  assert.equal(one.identifiable.total, 1);
  assert.equal(one.deidentified, null);
  assert.ok(!JSON.stringify(one).includes("Title P01"));
  // A grant for a project the access table does not know shows nothing.
  assert.equal(projectListFor("company", ["P77"], rows, summaries, 1).identifiable.total, 0);
  assert.equal(projectListFor("company", [], rows, summaries, 1).identifiable.total, 0);
});

test("decisions column reads the PASS count and dates come from the stored view", () => {
  const list = projectListFor("company", ["P05"], rows, summaries, 1);
  assert.equal(list.identifiable.rows[0].passCount, 5);
  assert.equal(list.identifiable.rows[0].updated, "2026-10-20");
  assert.equal(list.identifiable.rows[0].title, "Title P05");
  const judge = projectListFor("judge", [], rows, summaries, 1);
  assert.equal(judge.deidentified.rows[0].collected, "2026-10-01");
  // A row with no stored view yet still lists, without a count.
  const bare = projectListFor("admin", [], [access("P40", { basis: "own" })], [], 1);
  assert.equal(bare.identifiable.rows[0].passCount, null);
  assert.equal(bare.identifiable.rows[0].title, "Show HN: Title P40 – x");
});

test("ties sort by project id after title or pseudonym", () => {
  const tied = [access("P20", { basis: "own", pseudonym: "SAME1" }), access("P10", { basis: "own", pseudonym: "SAME2" })];
  const sums = [summary("P20", "identifiable", { title: "Same" }), summary("P10", "identifiable", { title: "Same" })];
  assert.deepEqual(projectListFor("admin", [], tied, sums, 1).identifiable.rows.map((r) => r.projectId), ["P10", "P20"]);
  const deid = [access("P20", { pseudonym: "K7F2Q" }), access("P10", { pseudonym: "A0000" }), access("P15", { pseudonym: "K7F2Q2" })];
  assert.deepEqual(projectListFor("judge", [], deid, [], 1).deidentified.rows.map((r) => r.pseudonym), ["A0000", "K7F2Q", "K7F2Q2"]);
});

test("page 2 of 120 rows holds rows 51-100 and reports 3 pages", () => {
  const many = Array.from({ length: 120 }, (_, i) => access(`P${String(i + 1).padStart(3, "0")}`, { basis: "own" }));
  const sums = many.map((r) => summary(r.projectId, "identifiable", { title: `T${r.projectId}` }));
  const list = projectListFor("admin", [], many, sums, 2);
  assert.equal(PAGE_SIZE, 50);
  assert.equal(list.page, 2);
  assert.equal(list.pages, 3);
  assert.equal(list.identifiable.total, 120);
  assert.deepEqual(
    list.identifiable.rows.map((r) => r.projectId),
    many.slice(50, 100).map((r) => r.projectId),
  );
  assert.equal(projectListFor("admin", [], many, sums, 3).identifiable.rows.length, 20);
  // Out-of-range pages clamp.
  assert.equal(projectListFor("admin", [], many, sums, 99).page, 3);
  assert.equal(projectListFor("admin", [], [], [], 5).pages, 1);
});
