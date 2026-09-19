#!/usr/bin/env node
// Lints spikes/*.md against the record contract.
//
//   node scripts/check-spike-records.mjs                  lint every spikes/*.md that exists
//   node scripts/check-spike-records.mjs --require-final  also require all three records, status final
//   node scripts/check-spike-records.mjs --dir <dir>      lint another directory (tests)
//
// Exit 0 when clean, 1 with one line per violation, 2 on a usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECORD_NAMES,
  extractJsonBlock,
  numbersOnlyViolations,
  validateRecord,
} from "./lib/spike-record.mjs";

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../spikes");

/** Lint one record file's text. Returns violation strings prefixed with the file name. */
export function lintRecordText(file, name, md, { requireFinal = false } = {}) {
  const out = [];
  for (const v of numbersOnlyViolations(md)) {
    out.push(`${file}: numbers-only guard: ${v.rule} (line ${v.line})`);
  }
  if (!RECORD_NAMES.includes(name)) return out; // other markdown files get the numbers-only guard only
  let obj;
  try {
    obj = extractJsonBlock(md);
  } catch (err) {
    out.push(`${file}: ${err.message}`);
    return out;
  }
  for (const v of validateRecord(name, obj, { requireFinal })) out.push(`${file}: ${v}`);
  return out;
}

export function lintDir(dir, { requireFinal = false } = {}) {
  const out = [];
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    : [];

  for (const f of files) {
    const name = f.slice(0, -3);
    const md = fs.readFileSync(path.join(dir, f), "utf8");
    out.push(...lintRecordText(f, name, md, { requireFinal: requireFinal && RECORD_NAMES.includes(name) }));
  }
  if (requireFinal) {
    for (const name of RECORD_NAMES) {
      if (!files.includes(`${name}.md`)) out.push(`${name}.md: record is missing (required final)`);
    }
  }
  return out;
}

function main(argv) {
  let dir = DEFAULT_DIR;
  let requireFinal = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--require-final") requireFinal = true;
    else if (argv[i] === "--dir" && argv[i + 1]) dir = path.resolve(argv[++i]);
    else {
      console.error("usage: check-spike-records.mjs [--require-final] [--dir <dir>]");
      return 2;
    }
  }
  const violations = lintDir(dir, { requireFinal });
  for (const v of violations) console.error(v);
  return violations.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
