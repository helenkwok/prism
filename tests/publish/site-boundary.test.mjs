// PUB-06 / T-06-15: the public site can reach only public data. Every file under site/src and site/scripts
// imports nothing outside site/ except "@public-data/...", never mentions PRISM_DATA_DIR, and site/src never
// touches the file system.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");
const SPEC = /(?:\bimport\s[^'"]*?from\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s[^'"]*?from\s*)["']([^"']+)["']/g;

export function violations(file, text) {
  const found = [];
  for (const [, spec] of text.matchAll(SPEC)) {
    if (spec.startsWith("@public-data/")) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const target = path.resolve(path.dirname(file), spec);
      // One public constant shared with the app on the same host: where the app lives (/app).
      if (target === path.join(root, "base-path.mjs")) continue;
      if (target !== site && !target.startsWith(site + path.sep)) found.push(`imports outside site/: ${spec}`);
    }
    if (file.startsWith(path.join(site, "src") + path.sep) && /^(node:)?fs(\/promises)?$/.test(spec)) found.push(`file system in site/src: ${spec}`);
  }
  if (text.includes("PRISM_DATA_DIR")) found.push("mentions PRISM_DATA_DIR");
  return found;
}

const files = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => /\.(m?[jt]sx?|cjs)$/.test(f) && fs.statSync(f).isFile());

test("every site source and script stays inside site/ and reads data only through @public-data", () => {
  const all = [...files(path.join(site, "src")), ...files(path.join(site, "scripts"))];
  assert.ok(all.length > 10, "expected the site sources");
  const bad = all.flatMap((f) => violations(f, fs.readFileSync(f, "utf8")).map((v) => `${path.relative(root, f)}: ${v}`));
  assert.deepEqual(bad, []);
});

test("the guard catches a planted import of private code, a PRISM_DATA_DIR read and fs in site/src", () => {
  const planted = path.join(site, "src", "planted.ts");
  assert.deepEqual(violations(planted, 'import { run } from "../../src/pipeline/run.ts";'), ["imports outside site/: ../../src/pipeline/run.ts"]);
  assert.deepEqual(violations(planted, "const dir = process.env.PRISM_DATA_DIR;"), ["mentions PRISM_DATA_DIR"]);
  assert.deepEqual(violations(planted, 'import { readFileSync } from "node:fs";'), ["file system in site/src: node:fs"]);
  assert.deepEqual(violations(planted, 'const m = await import("../../src/publish/export.ts");'), ["imports outside site/: ../../src/publish/export.ts"]);
  assert.deepEqual(violations(planted, 'import release from "@public-data/release.json";'), []);
  assert.deepEqual(violations(planted, 'import { BASE_PREFIX } from "../../base-path.mjs";'), []);
  assert.deepEqual(violations(planted, 'import x from "../../base-path.mjs.bak";'), ["imports outside site/: ../../base-path.mjs.bak"]);
});
