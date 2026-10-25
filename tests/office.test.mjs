// Office page / WebOffice port tests: the bridge origin check and desk rules
// (adapted from .office-ref/scripts/bridge.test.mjs and saves.test.mjs), the
// office-apps lock file, and the /office route module. No network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { editorMessage } from "../src/app/components/office/bridge.ts";
import { savedEntry } from "../src/app/components/office/library.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const origin = "https://office.example";
const grid = {};
const pdf = {};
const frames = { gridcraft: { contentWindow: grid }, pdfcraft: { contentWindow: pdf } };

test("accepts save bytes only from the expected editor browsing context", () => {
  assert.equal(editorMessage({ origin, source: grid, data: { type: "gridcraft:save" } }, origin, frames), "gridcraft");
  assert.equal(editorMessage({ origin, source: pdf, data: { type: "pdfcraft:save" } }, origin, frames), "pdfcraft");
});

test("rejects another tab, another origin and cross-editor impersonation", () => {
  for (const event of [
    { origin, source: {}, data: { type: "gridcraft:save" } },
    { origin: "https://other.example", source: grid, data: { type: "gridcraft:save" } },
    { origin, source: grid, data: { type: "pdfcraft:save" } },
    { origin, source: null, data: { type: "gridcraft:save" } },
    { origin, source: grid, data: null },
    { origin, source: grid, data: { type: "gridcraft:execute" } },
  ]) assert.equal(editorMessage(event, origin, frames), undefined);
});

// The desk rules (saves.test.mjs): a workbook save keeps its entry, renamed
// saves do not clobber it, PDF exports open in PdfCraft as separate entries.
const original = { id: "original-workbook", name: "finance.xlsx", tool: "gridcraft", bytes: new Uint8Array([80, 75, 3, 4]).buffer, modified: 1 };
const request = (name, saveAs) => ({ name, bytes: new TextEncoder().encode(name).buffer, saveAs });

test("ordinary workbook Save updates the current entry", () => {
  const { file, updatesCurrent } = savedEntry("gridcraft", request(original.name), original);
  assert.equal(file.id, original.id);
  assert.equal(file.tool, "gridcraft");
  assert.equal(updatesCurrent, true);
});

test("GridCraft Save As without a flag preserves the original workbook", () => {
  const { file, updatesCurrent } = savedEntry("gridcraft", request("finance-copy.xlsx"), original);
  assert.notEqual(file.id, original.id);
  assert.equal(file.name, "finance-copy.xlsx");
  assert.equal(updatesCurrent, true);
});

test("PDF export gets a separate PDF entry and does not retarget subsequent workbook saves", () => {
  const desk = new Map([[original.id, original]]);
  const exported = savedEntry("gridcraft", request("finance.PDF"), original);
  desk.set(exported.file.id, exported.file);
  assert.equal(desk.size, 2);
  assert.equal(desk.get(original.id), original);
  assert.equal(exported.file.tool, "pdfcraft");
  assert.equal(exported.updatesCurrent, false);
  const subsequent = savedEntry("gridcraft", request(original.name), original);
  desk.set(subsequent.file.id, subsequent.file);
  assert.equal(subsequent.file.id, original.id);
  assert.equal(desk.get(exported.file.id).tool, "pdfcraft");
  assert.equal(desk.size, 2);
});

test("office-apps.lock.json pins the four editors with 64-hex SHA-256 hashes", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "office-apps.lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), ["deckcraft", "gridcraft", "pdfcraft", "wordcraft"]);
  for (const [tool, pin] of Object.entries(lock)) {
    assert.match(pin.version, /^\d+\.\d+\.\d+$/, tool);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, tool);
  }
});

test("the office route is at /office and renders client-only", async () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/app/routes/office.tsx"), "utf8");
  assert.match(source, /createFileRoute\("\/office"\)/);
  assert.match(source, /"Open the findings in your browser"/);
  // The editors mount behind a browser check; the SSR branch renders neither
  // the shell nor an iframe.
  assert.match(source, /typeof window === "undefined"/);
  assert.doesNotMatch(source.split('typeof window === "undefined"')[0], /<WebOffice/);
});

test("site/downloads.sha256 pins every findings file the office route opens", () => {
  const sums = new Map(fs.readFileSync(path.join(repoRoot, "site/downloads.sha256"), "utf8").trim().split("\n").map((l) => l.split(/\s+/).reverse()));
  const route = fs.readFileSync(path.join(repoRoot, "src/app/routes/office.tsx"), "utf8");
  const names = [...route.matchAll(/\/office\/findings\/([\w.-]+)/g)].map((m) => m[1]);
  assert.equal(names.length, 4);
  for (const name of names) assert.match(sums.get(name) ?? "", /^[0-9a-f]{64}$/, name);
});

test("office.css styles the root's own classes as compound selectors, never as descendants", () => {
  const css = fs.readFileSync(path.join(repoRoot, "src/app/components/office/office.css"), "utf8");
  const tsx = fs.readFileSync(path.join(repoRoot, "src/app/components/office/WebOffice.tsx"), "utf8");
  const rootClasses = /className=\{`webOffice ([a-z-]+)/.exec(tsx)?.[1];
  assert.equal(rootClasses, "workspace", "the root element carries webOffice and workspace");
  assert.doesNotMatch(css, /\.webOffice \.workspace\b/, "'.webOffice .workspace' never matches: both classes are on one element");
  assert.match(css, /\.webOffice\.workspace\{[^}]*display:grid/);
});
