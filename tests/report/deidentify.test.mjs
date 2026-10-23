// APP-03 / D-81: de-identified evidence for judges (plan 07-06), proven on the
// synthetic corpus and its identifying fixture, Zentrolux (P07). A fixed test
// key is used; no real pseudonym key is created, read or printed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import Database from "better-sqlite3";

import { buildDocumentFrequency, deidentifyView, dictionaryOf, maskText, pseudonymOf, QUOTE_WORDS } from "../../src/report/deidentify.ts";
import { buildReportView, loadGapText, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, corpusPath, gatesPath, jsRunGate, order, root } from "./js-gate.mjs";

const TEST_KEY = "prism-test-key-not-a-secret-0123456789";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prism-deid-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const keyFile = path.join(scratch, "test.key");
fs.writeFileSync(keyFile, TEST_KEY);

const gapText = loadGapText({ repoRoot: scratch, codebook });
let views; // identifiable views of all 10 projects
let df;
let deid; // projectId -> { view, counts }

before(async () => {
  views = [];
  for (const p of corpus.projects) views.push(await buildReportView(sourceFromFixture(corpus, p, order), { codebook, gatesPath, runGate: jsRunGate, gapText }));
  df = buildDocumentFrequency(views);
  deid = Object.fromEntries(views.map((v) => [v.projectRef, deidentifyView(v, { dictionary: dictionaryOf(v), corpus: df, key: TEST_KEY })]));
});

const quotesOf = (v) => v.checks.flatMap((c) => c.quotes.map((q) => q.text));
const z = () => JSON.stringify(deid.P07.view);

/** Runs materialize in a clean HOME with no PRISM_PSEUDONYM_KEY, so no real key can be picked up. */
function materialize(args, { fixture = corpusPath, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(scratch, "home-"));
  const base = { ...process.env, HOME: home };
  delete base.PRISM_PSEUDONYM_KEY;
  const db = path.join(home, "views.sqlite");
  const res = spawnSync(process.execPath, ["scripts/materialize-views.mjs", "--fixture", fixture, "--js-gate", "--db", db, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...base, ...env },
  });
  return { ...res, db };
}

function countRows(dbPath, table, where = "1=1") {
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const t = db.prepare("select name from sqlite_master where type='table' and name=?").get(table);
    return t ? db.prepare(`select count(*) n from ${table} where ${where}`).get().n : 0;
  } finally {
    db.close();
  }
}

describe("identifying fixture: Zentrolux (APP-03 / D-81)", () => {
  for (const term of ["zentrolux", "zentro", "zentrolux.example", "zentro-labs", "zentrolux-core", "founder.name@", "github.com/zentro"]) {
    test(`forbidden term "${term}" does not survive in any casing`, () => {
      assert.equal(z().toLowerCase().includes(term), false);
    });
  }

  test("no 6-word run of the coined slogan survives", () => {
    const slogan = "zentrolux turns quarterly vibes into audited lattices".split(" ");
    const flat = quotesOf(deid.P07.view).join(" ").toLowerCase();
    for (let i = 0; i + 6 <= slogan.length; i++) assert.equal(flat.includes(slogan.slice(i, i + 6).join(" ")), false, `run ${i}`);
    for (const w of ["quarterly", "vibes", "lattices"]) assert.equal(flat.includes(w), false, w);
  });

  test("placeholders replace what was masked", () => {
    const flat = quotesOf(deid.P07.view).join(" ");
    for (const ph of ["[product]", "[domain]", "[url]", "[email redacted]", "▇▇"]) assert.ok(flat.includes(ph), ph);
  });

  test("the shared sentence (P02, P05, P07) survives unmasked in each", () => {
    for (const id of ["P02", "P05", "P07"]) assert.ok(quotesOf(deid[id].view).includes("We do not use your data to train our models."), id);
  });
});

describe("de-identified view shape", () => {
  test("every quote is at most 40 words; a longer one is cut with an ellipsis", () => {
    for (const { view } of Object.values(deid)) for (const t of quotesOf(view)) assert.ok(t.split(/\s+/).length <= QUOTE_WORDS, t);
    const long = Array.from({ length: 60 }, () => "the tool").join(" ");
    const c = { maskedTerms: 0, dfMasked: 0, ngramBreaks: 0, cut: 0, redacted: 0 };
    const out = maskText(long, "P01", { projectRef: "P01", terms: [] }, df, c);
    assert.equal(out.split(/\s+/).length, QUOTE_WORDS);
    assert.ok(out.endsWith("…"));
    assert.equal(c.cut, 1);
  });

  test("title, hnId, URLs, hostnames, snapshot hashes and collection.urls are absent", () => {
    for (const [id, { view }] of Object.entries(deid)) {
      const s = JSON.stringify(view);
      assert.equal(view.view, "deidentified");
      assert.equal("title" in view, false, id);
      assert.equal("hnId" in view, false, id);
      assert.equal("urls" in view.collection, false, id);
      assert.equal(/https?:\/\//.test(s), false, id);
      // The only host left is PRISM's own model host in "how this was made", never a collected one.
      assert.deepEqual([...new Set(s.match(/[\w.-]+\.example\b/gi) ?? [])], ["inference.example"], id);
      assert.equal(/snapshotHash|"url"/.test(s), false, id);
      assert.equal(s.includes(id), false, `${id}: the project id must not appear`);
      for (const p of corpus.projects) for (const h of Object.keys(p.snapshots ?? {})) assert.equal(s.includes(h), false, `${id} carries a snapshot hash`);
      const title = corpus.projects.find((p) => p.projectId === id).title;
      assert.equal(s.includes(title), false, id);
    }
  });

  test("verdicts and checks are carried over unchanged", () => {
    const id = views.find((v) => v.projectRef === "P01");
    assert.deepEqual(deid.P01.view.decisions, id.decisions);
    assert.deepEqual(deid.P01.view.checks.map((c) => c.checkId), id.checks.map((c) => c.checkId));
  });
});

describe("pseudonym", () => {
  test("5 Crockford base32 uppercase characters, stable for the same key and project", () => {
    const p = pseudonymOf(TEST_KEY, "P07");
    assert.match(p, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    assert.equal(pseudonymOf(TEST_KEY, "P07"), p);
    assert.equal(deid.P07.view.projectRef, p);
  });

  test("a different key gives a different pseudonym", () => {
    assert.notEqual(pseudonymOf("another-test-key-0123456789", "P07"), pseudonymOf(TEST_KEY, "P07"));
  });

  test("an empty key throws", () => {
    assert.throws(() => pseudonymOf("", "P07"));
  });
});

describe("materialize-views --deidentify", () => {
  test("writes 20 view rows and 10 access rows; DEID lines name pseudonyms only", () => {
    const res = materialize(["--deidentify", "--key-file", keyFile]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(countRows(res.db, "app_report_view", "view='identifiable'"), 10);
    assert.equal(countRows(res.db, "app_report_view", "view='deidentified'"), 10);
    assert.equal(countRows(res.db, "app_project_access", "pseudonym is not null and in_sample=1 and fixture=1"), 10);
    assert.match(res.stdout, /^REPORT rows=20$/m);
    const lines = res.stdout.split("\n").filter((l) => l.startsWith("DEID project="));
    assert.equal(lines.length, 10);
    for (const l of lines) {
      assert.match(l, /^DEID project=[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5} masked_terms=\d+ df_masked=\d+ ngram_breaks=\d+$/);
      assert.equal(/zentrolux/i.test(l) || l.includes(".example"), false, l);
      for (const p of corpus.projects) assert.equal(l.toLowerCase().includes(productTitle(p.title).toLowerCase()), false, l);
    }
    assert.equal(res.stdout.includes(TEST_KEY) || res.stderr.includes(TEST_KEY), false, "the key is never printed");

    const db = new Database(res.db, { readonly: true });
    const row = db.prepare("select * from app_project_access where project_id='P05'").get();
    db.close();
    assert.equal(row.basis, "opt-in");
    assert.equal(row.pseudonym, pseudonymOf(TEST_KEY, "P05"));
    assert.equal(JSON.parse(row.live_boundary_json)[0].host, "p05.example");
  });
});

function productTitle(t) {
  return t.replace(/^Show HN:\s*/, "").split(/ – | - |:/)[0].trim();
}
