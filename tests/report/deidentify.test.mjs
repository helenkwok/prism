// APP-03 / D-81: de-identified evidence for judges (plan 07-06), proven on the
// synthetic corpus and its identifying fixture, Example Planner (P07). A fixed test
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

// The corpus uses only .example hosts, so the platform-host path (owner/repo
// from a shared code host) is covered here on a bare view.
test("a repository on a shared code host adds its owner and repo, not the host", () => {
  const v = { projectRef: "PX", title: "Example Repo Tool (synthetic)", collection: { urls: ["https://github.com/example-org/example-repo.git"] }, checks: [] };
  const terms = dictionaryOf(v).terms.map((t) => [t.text, t.placeholder]);
  assert.deepEqual(terms.filter(([, ph]) => ph === "[repo]").map(([t]) => t).sort(), ["example org", "example-org", "example-repo", "example_org", "example_repo", "exampleorg", "examplerepo", "example repo"].sort());
  assert.equal(terms.some(([t]) => /github/i.test(t)), false);
});

describe("identifying fixture: Example Planner (APP-03 / D-81)", () => {
  for (const term of ["example planner", "example-planner", "example-planner.example", "example-code-host", "example-org", "example-repo", "founder.name@"]) {
    test(`forbidden term "${term}" does not survive in any casing`, () => {
      assert.equal(z().toLowerCase().includes(term), false);
    });
  }

  test("no 6-word run of the coined slogan survives", () => {
    const slogan = "example planner (synthetic) turns quarterly vibes into audited lattices".split(" ");
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

  test("a 6-word run of common words found in no other project is broken", () => {
    const c = { maskedTerms: 0, dfMasked: 0, ngramBreaks: 0, cut: 0, redacted: 0 };
    const out = maskText("docs tool tested release hosted platform", "PX", { projectRef: "PX", terms: [] }, df, c);
    assert.equal(c.dfMasked, 0, "every word is common across the corpus");
    assert.equal(c.ngramBreaks, 1);
    assert.equal(out.split(" ").filter((w) => w === "▇▇").length, 1);
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
      assert.equal(/example planner/i.test(l) || l.includes(".example"), false, l);
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

// ---- Task 2: the identifier scan is a hard gate (T-07-21), plus collision and key refusals ----

function corpusVariant(name, edit) {
  const c = structuredClone(corpus);
  edit(c);
  const p = path.join(scratch, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(c));
  return p;
}

function assertRefusedAndEmpty(res, reason) {
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`^DEID REFUSED ${reason}$`, "m"));
  assert.equal(countRows(res.db, "app_report_view"), 0, "no view row may be written");
  assert.equal(countRows(res.db, "app_project_access"), 0, "no access row may be written");
}

describe("identifier scan (APP-03)", () => {
  const entries = () => views.map((v) => ({ view: structuredClone(deid[v.projectRef].view), dictionary: dictionaryOf(v) }));
  const firstQuote = (view) => view.checks.find((c) => c.quotes.length > 0).quotes[0];
  const scan = async (e) => (await import("../../src/report/deidentify.ts")).scanDeidentified(e);

  test("clean de-identified views give zero hits", async () => {
    assert.deepEqual(await scan(entries()), []);
  });

  test("a planted leftover of the project's own name is found, reported by pseudonym and term index only", async () => {
    const e = entries();
    firstQuote(e.find((x) => x.dictionary.projectRef === "P07").view).text += " Example Planner (synthetic)";
    const hits = await scan(e);
    const ps = pseudonymOf(TEST_KEY, "P07");
    assert.ok(hits.some((h) => h.pseudonym === ps && h.termOf === ps && Number.isInteger(h.termIndex)), JSON.stringify(hits));
    assert.equal(/example planner/i.test(JSON.stringify(hits)), false, "hits never carry the term text");
  });

  test("another project's domain planted into P01's quote is caught by the cross-project part", async () => {
    const e = entries();
    firstQuote(e.find((x) => x.dictionary.projectRef === "P01").view).text += " see p02.example";
    const hits = await scan(e);
    assert.ok(hits.some((h) => h.pseudonym === pseudonymOf(TEST_KEY, "P01") && h.termOf === pseudonymOf(TEST_KEY, "P02")), JSON.stringify(hits));
  });

  test("a leftover URL is a hit", async () => {
    const e = entries();
    firstQuote(e[0].view).text += " https://elsewhere.example/x";
    assert.ok((await scan(e)).length >= 1);
  });

  test("materialize: a surviving identifier refuses the whole run (DEID REFUSED identifier-scan) and writes nothing", () => {
    // P06's product renamed to a word three other projects use: DF masking keeps it, so it
    // survives in P01's quotes and only the cross-project scan can catch it.
    const fixture = corpusVariant("scan-leak", (c) => {
      c.projects.find((p) => p.projectId === "P06").title = "Show HN: Release – plan routes for delivery vans";
    });
    const res = materialize(["--deidentify", "--key-file", keyFile], { fixture });
    assertRefusedAndEmpty(res, "identifier-scan");
    assert.match(res.stdout, /^DEID hit project=[0-9A-Z]{5} term_of=[0-9A-Z]{5} term=-?\d+$/m);
    assert.equal(/release/i.test(res.stdout.split("\n").filter((l) => l.startsWith("DEID")).join("\n")), false);
  });

  test("materialize: two projects with the same pseudonym refuse (DEID REFUSED pseudonym-collision) and write nothing", () => {
    // A real collision of the 25-bit pseudonym under the test key, found by search (birthday bound ~6k ids).
    const seen = new Map();
    let pair;
    for (let i = 0; !pair; i++) {
      const ps = pseudonymOf(TEST_KEY, `C${i}`);
      if (seen.has(ps)) pair = [seen.get(ps), `C${i}`];
      else seen.set(ps, `C${i}`);
    }
    const fixture = corpusVariant("collision", (c) => {
      c.projects[0].projectId = pair[0];
      c.projects[1].projectId = pair[1];
    });
    assertRefusedAndEmpty(materialize(["--deidentify", "--key-file", keyFile], { fixture }), "pseudonym-collision");
  });

  test("materialize: no key file and no PRISM_PSEUDONYM_KEY refuses (DEID REFUSED no-key) and writes nothing", () => {
    assertRefusedAndEmpty(materialize(["--deidentify"]), "no-key");
    assertRefusedAndEmpty(materialize(["--deidentify", "--key-file", path.join(scratch, "missing.key")]), "no-key");
  });

  test("materialize: a key shorter than 16 characters refuses (DEID REFUSED weak-key)", () => {
    const weak = path.join(scratch, "weak.key");
    fs.writeFileSync(weak, "short");
    assertRefusedAndEmpty(materialize(["--deidentify", "--key-file", weak]), "weak-key");
  });

  test("materialize: PRISM_PSEUDONYM_KEY is accepted", () => {
    const res = materialize(["--deidentify"], { env: { PRISM_PSEUDONYM_KEY: TEST_KEY } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`^DEID project=${pseudonymOf(TEST_KEY, "P07")} `, "m"));
  });

  test("materialize: a clean run ends with DEID scan hits=0 views=10", () => {
    const res = materialize(["--deidentify", "--key-file", keyFile]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^DEID scan hits=0 views=10$/m);
  });
});

// ---- 07-12 (Helen, 2026-10-23): text identical in every view AND in a public shared source is exempt ----

describe("shared-text exemption (T-07-66)", () => {
  // "Catalogued" is codebook text (check id assumptions-catalogued, codebook.md) that every
  // view carries and no quote uses: a product named with it must not block the export.
  const WORD = "Catalogued";
  const P07_TERM = "Example Planner (synthetic)";
  const mod = () => import("../../src/report/deidentify.ts");
  const entries = (titleFor = {}) =>
    views.map((v) => ({ view: structuredClone(deid[v.projectRef].view), dictionary: dictionaryOf(titleFor[v.projectRef] ? { ...v, title: titleFor[v.projectRef] } : v) }));
  /** Put `text` in the view as a quote (some synthetic views carry none). */
  const plant = (view, text) => view.checks[0].quotes.unshift({ spanId: "planted", text, injectionFlagged: false });

  test("a product named with a codebook word shared by every view gives no hit; without the public text it would", async () => {
    const { scanDeidentified, publicSharedText } = await mod();
    assert.match(fs.readFileSync(path.join(root, "codebook.md"), "utf8"), new RegExp(`\\b${WORD}\\b`, "i"));
    assert.equal(quotesOf(views[0]).concat(...views.map(quotesOf)).some((q) => new RegExp(WORD, "i").test(q)), false, "no quote uses the word");
    const e = entries({ P06: WORD });
    assert.deepEqual(scanDeidentified(e, publicSharedText()), []);
    assert.ok(scanDeidentified(e, "").length > 0, "control: with no public text the shared codebook strings are scanned and hit");
  });

  test("materialize: a product named with that word ends DEID scan hits=0 views=10", () => {
    const fixture = corpusVariant("shared-word", (c) => {
      c.projects.find((p) => p.projectId === "P06").title = `Show HN: ${WORD} – plan routes for delivery vans`;
    });
    const res = materialize(["--deidentify", "--key-file", keyFile], { fixture });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^DEID scan hits=0 views=10$/m);
  });

  test("two views sharing an identical quote with a dictionary term still refuse (the quote is in no public source)", async () => {
    const { scanDeidentified, publicSharedText } = await mod();
    const two = entries().filter((x) => ["P01", "P07"].includes(x.dictionary.projectRef));
    for (const x of two) plant(x.view, `${P07_TERM} shipped the same release note`);
    const hits = scanDeidentified(two, publicSharedText());
    const ps = pseudonymOf(TEST_KEY, "P07");
    // Both views hit the P07 dictionary (the product name and its host label both match).
    assert.equal(new Set(hits.filter((h) => h.termOf === ps).map((h) => h.pseudonym)).size, 2, JSON.stringify(hits));
  });

  test("a string in every view but one is still scanned; in every view and the public text it is exempt", async () => {
    const { scanDeidentified } = await mod();
    const quote = `${P07_TERM} shipped the same release note`;
    const all = entries();
    for (const x of all) plant(x.view, quote);
    assert.deepEqual(scanDeidentified(all, quote), []);
    const allButOne = entries();
    for (const x of allButOne.slice(1)) plant(x.view, quote);
    assert.ok(scanDeidentified(allButOne, quote).length > 0);
  });

  test("with a single view nothing is exempt", async () => {
    const { scanDeidentified, sharedStrings, publicSharedText } = await mod();
    const one = entries({ P06: WORD }).filter((x) => x.dictionary.projectRef === "P06");
    assert.equal(sharedStrings(one.map((x) => x.view), publicSharedText()).size, 0);
    assert.ok(scanDeidentified(one, publicSharedText()).length > 0);
  });

  test("the URL check follows the same exemption", async () => {
    const { scanDeidentified } = await mod();
    const quote = "see https://docs.example/shared for the method";
    const e = entries();
    for (const x of e) plant(x.view, quote);
    assert.deepEqual(scanDeidentified(e, quote), []);
    assert.ok(scanDeidentified(e, "no such text").some((h) => h.termIndex === -1));
  });
});
