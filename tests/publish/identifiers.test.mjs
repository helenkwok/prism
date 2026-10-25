// PUB-03 / protocol 6.6 / D-77 / T-06-08, T-06-09: identifier scan over output text, reporting rule and file only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildIdentifierSet, scanTexts } from "../../src/publish/identifiers.ts";
import { ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "src/publish/identifiers.ts");
const STORE = path.join(ROOT, "tests/fixtures/publish/synthetic-store.json");

const projects = [
  { n: 7, hn_id: "90000071", title: "Synthetic 007", entry_url: "https://synthetic-07.example/launch", final_url: "https://www.synthetic-07.example/" },
  { n: 8, hnId: "90000081", title: "Show HN: Synthetic Widget – a tool for tests", finalUrl: "https://github.com/synth-org/synth-repo" },
  { n: 9, hn_id: "90000091", title: "Tiny", final_url: "https://synth-app.vercel.app/" },
];
const frame = [{ id: "90000999", title: "Excluded Synthetic Candidate", url: "https://excluded-synth.example/", created_at: "2026-01-01" }];
const set = buildIdentifierSet({ projects, frame });
const scan = (text) => scanTexts([{ file: "v1/release.json", text }], set);

describe("buildIdentifierSet", () => {
  test("generic-hosts: shared hosts contribute only path-qualified URLs, never the bare host", () => {
    for (const h of ["github.com", "vercel.app"]) assert.ok(!set.hosts.has(h), h);
    assert.ok(set.urls.has("github.com/synth-org/synth-repo"));
    assert.ok(set.hosts.has("synth-app.vercel.app"));
    assert.deepEqual(scan("Code lives on github.com and apps on vercel.app."), []);
  });

  test("short-titles: titles under 6 characters are left out", () => {
    assert.ok(!set.titles.has("tiny"));
    assert.deepEqual(scan("A tiny sample."), []);
  });
});

describe("scanTexts", () => {
  test("host-hit: a planted host is found case-insensitively, with rule and file only", () => {
    const hits = scan('{"note":"see Synthetic-07.EXAMPLE for details"}');
    assert.deepEqual(hits, [{ file: "v1/release.json", rule: "hostname" }]);
    assert.deepEqual(Object.keys(hits[0]).sort(), ["file", "rule"]);
  });

  test("url-hit: a path-qualified URL on a generic host is found without its scheme", () => {
    assert.deepEqual(scan("from GitHub.com/synth-org/synth-repo/issues"), [{ file: "v1/release.json", rule: "url" }]);
  });

  test("hn-id-whole-token: an HN id matches only as a whole number", () => {
    assert.deepEqual(scan("count 1900000712"), []);
    assert.deepEqual(scan("item?id=90000071&x"), [{ file: "v1/release.json", rule: "hn-id" }]);
  });

  test("title-hit: a project title in a statement is found under rule title", () => {
    assert.deepEqual(scan("At least 3 of 300 launches publicly evidence synthetic 007."), [{ file: "v1/release.json", rule: "title" }]);
    assert.deepEqual(scan("Like Synthetic Widget does."), [{ file: "v1/release.json", rule: "title" }]);
  });

  test("frame-identifiers: excluded candidates in the frame are identifiers too", () => {
    assert.deepEqual(scan("excluded-synth.example"), [{ file: "v1/release.json", rule: "hostname" }]);
    assert.deepEqual(scan("id 90000999"), [{ file: "v1/release.json", rule: "hn-id" }]);
  });

  test("artcraft-always: the worked case's HN id is in the set even when not in the sample (D-77)", () => {
    const empty = buildIdentifierSet({ projects: [] });
    assert.ok(empty.hnIds.has(ARTCRAFT_HN_ID));
    assert.deepEqual(scanTexts([{ file: "a.html", text: `<p>${ARTCRAFT_HN_ID}</p>` }], empty), [{ file: "a.html", rule: "hn-id" }]);
  });

  test("file-name-withheld: a file name that is itself an identifier is not printed", () => {
    const hits = scanTexts([{ file: "pages/synthetic-07.example.html", text: "clean" }], set);
    assert.deepEqual(hits, [{ file: "(file name withheld)", rule: "hostname" }]);
  });

  test("clean text has no hits", () => {
    assert.deepEqual(scan("At least 120 of 300 launches publicly evidence `intended-use-defined`."), []);
  });
});

describe("SCAN CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-scan-"));
  const run = (...paths) => spawnSync(process.execPath, [CLI, "--store", STORE, ...paths], { encoding: "utf8" });

  test("clean directory prints the SCAN summary with zero hits", () => {
    fs.mkdirSync(path.join(dir, "clean/v1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "clean/v1/release.json"), '{"n":300}');
    fs.writeFileSync(path.join(dir, "clean/index.html"), "<h1>Findings</h1>");
    const r = run(path.join(dir, "clean"));
    assert.equal(r.stdout.trim(), 'SCAN: {"files":2,"hits":0}', r.stderr);
    assert.equal(r.status, 0);
  });

  test("no-leak: a planted host is reported by rule and file, and no substring of it is printed", () => {
    const planted = "synthetic-007.example";
    fs.mkdirSync(path.join(dir, "dirty"), { recursive: true });
    const f = path.join(dir, "dirty/page.html");
    fs.writeFileSync(f, `<p>Visit https://${planted}/ now</p>`);
    const r = run(f);
    assert.match(r.stdout, /^SCAN HIT \S*page\.html hostname$/m);
    assert.match(r.stdout, /^SCAN: \{"files":1,"hits":\d+\}$/m);
    assert.equal(r.status, 1);
    const out = r.stdout + r.stderr;
    for (const part of ["synthetic-007", "007.example", "synthetic-00"]) assert.ok(!out.toLowerCase().includes(part), part);
  });
});
