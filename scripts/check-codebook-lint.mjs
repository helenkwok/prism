#!/usr/bin/env node
// Lints codebook.md against the codebook contract (CDB-01..CDB-04, D-34, D-35, D-36).
//
//   node scripts/check-codebook-lint.mjs                lint codebook.md at the repo root
//   node scripts/check-codebook-lint.mjs --file <path>  lint another file (tests)
//
// Exit 0 when clean, 1 with one line per violation, 2 on a usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCheckIds, lintCodebookText } from "./lib/codebook-lint.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_FILE = path.join(REPO_ROOT, "codebook.md");
// Same vendored path coding/contract.ts's resolveGatesPath defaults to — kept
// as a plain-JS literal here, not an import, so scripts/ stays independent
// of the TypeScript pipeline tree.
const GATES_PATH = path.join(REPO_ROOT, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");

function main(argv) {
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file" && argv[i + 1]) file = path.resolve(argv[++i]);
    else {
      console.error("usage: check-codebook-lint.mjs [--file <path>]");
      return 2;
    }
  }

  let md;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`${file}: ${err.message}`);
    return 2;
  }

  const checkIds = loadCheckIds(GATES_PATH);
  const violations = lintCodebookText(md, checkIds).map((v) => `${file}: ${v}`);
  for (const v of violations) console.error(v);
  return violations.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
