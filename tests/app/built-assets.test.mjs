// scripts/check-built-assets.mjs against fake build and source trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve("scripts/check-built-assets.mjs");
const RULE = (name) => `.icon-\\[lucide--${name}\\]{width:1em;height:1em}`;

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prism-assets-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const r = spawnSync(process.execPath, [script, "--dist", path.join(root, "dist"), "--src", path.join(root, "src")], {
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, line: r.stdout.trim(), stderr: r.stderr };
}

const clean = {
  "src/page.tsx": `<span className="icon-[lucide--circle-alert]" aria-hidden="true" />`,
  "dist/client/assets/css/index.css": RULE("circle-alert"),
  "dist/client/assets/js/index.js": "console.log('ok')",
  "dist/server/index.js": "export default {}",
};

test("a clean build reports zero API references and zero missing rules", () => {
  const r = run(clean);
  assert.equal(r.line, "ASSETS iconify_api_refs=0 icon_classes=1 missing_icon_rules=0");
  assert.equal(r.status, 0);
});

test("an Iconify API host anywhere in the build is counted and fails", () => {
  const r = run({ ...clean, "dist/server/chunk.js": `fetch("https://api.iconify.design/lucide.json")` });
  assert.equal(r.line, "ASSETS iconify_api_refs=1 icon_classes=1 missing_icon_rules=0");
  assert.equal(r.status, 1);
});

test("an icon class with no generated rule is reported and fails", () => {
  const r = run({ ...clean, "src/other.tsx": `<span className="icon-[lucide--no-such-icon]" />` });
  assert.equal(r.line, "ASSETS iconify_api_refs=0 icon_classes=2 missing_icon_rules=1");
  assert.match(r.stderr, /icon-\[lucide--no-such-icon\]/);
  assert.equal(r.status, 1);
});

test("a missing build is an error, not a pass", () => {
  const r = run({ "src/page.tsx": "" });
  assert.equal(r.status, 2);
});
