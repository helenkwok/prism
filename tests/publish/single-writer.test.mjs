// PUB-03 / T-06-04: only src/publish/export.ts may both name public-data and write files.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WRITE = /\b(writeFileSync|writeFile|renameSync|rename|cpSync|mkdirSync)\s*\(/;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : CODE.test(e.name) ? [p] : [];
  });
}

test("single-writer: export.ts is the only file that names public-data and writes files", () => {
  const writers = ["src", "scripts", "site"]
    .flatMap((d) => walk(path.join(REPO, d)))
    .filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return text.includes("public-data") && WRITE.test(text);
    })
    .map((f) => path.relative(REPO, f));
  assert.deepEqual(writers, ["src/publish/export.ts"]);
});
