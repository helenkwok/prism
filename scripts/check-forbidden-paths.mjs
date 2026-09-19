#!/usr/bin/env node
// Path guard: refuses paths that must never enter the public history.
//
//   node scripts/check-forbidden-paths.mjs --staged          staged additions and changes (pre-commit hook)
//   node scripts/check-forbidden-paths.mjs --tracked         every tracked file (CI, authoritative)
//   node scripts/check-forbidden-paths.mjs --paths a b ...   explicit list (unit tests)
//
// Exit 0 when clean, 1 when any path is refused (one line per path with the rule
// name), 2 on a usage error. The hook is advisory (it can be skipped); the
// --tracked run in CI is the backstop.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// Agent-tool path patterns are stored base64-encoded so this file never carries
// them in cleartext (decisions D-24, D-25). Each decodes to a regular expression
// matched case-insensitively against the repository-relative path.
const AGENT_PATH_PATTERNS_B64 = [
  "KF58LylcLmNsYXVkZSgvfCQp",
  "KF58LylcLmN1cnNvcigvfCQp",
  "KF58LylcLmNvZGV4KC98JCk=",
  "KF58LylcLmFnZW50cygvfCQp",
  "KF58LylcLmdlbWluaSgvfCQp",
  "KF58LylcLndpbmRzdXJmKC98JCk=",
  "KF58LylcLnBsYW5uaW5nKC98JCk=",
  "KF58LylcLmdzZCgvfCQp",
  "KF58LykoY2xhdWRlfGFnZW50c3xnZW1pbmkpXC5tZCQ=",
  "KF58LylcLmdpdGh1Yi9jb3BpbG90LWluc3RydWN0aW9uc1wubWQk",
  "XC5jdXJzb3JydWxlcyQ=",
];

const AGENT_PATH_PATTERNS = AGENT_PATH_PATTERNS_B64.map(
  (b64) => new RegExp(Buffer.from(b64, "base64").toString("utf8"), "i"),
);

const OFFICE_EXT = /\.(pptx|ppt|key|docx|doc|xlsx|xls)$/i;
const DB_EXT = /\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i;

/**
 * Classify one repository-relative path. Returns the rule name that refuses it,
 * or null when it is allowed.
 */
export function classifyPath(rawPath) {
  const p = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const base = p.split("/").pop() ?? p;

  if (p.startsWith("references/")) return "reference-documents";
  if (OFFICE_EXT.test(p)) return "office-binary";
  if (/\.pdf$/i.test(p) && !p.startsWith("public-data/")) return "pdf-outside-public-data";
  if (DB_EXT.test(p)) return "private-data-database";
  if (p.split("/").includes("snapshots")) return "private-data-snapshots";
  if ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example") {
    return "private-data-env-file";
  }
  if (AGENT_PATH_PATTERNS.some((re) => re.test(p))) return "agent-tool-path";
  return null;
}

/** Returns [{ path, rule }] for every refused path in the list. */
export function checkPaths(paths) {
  const violations = [];
  for (const p of paths) {
    const rule = classifyPath(p);
    if (rule) violations.push({ path: p, rule });
  }
  return violations;
}

function gitNameList(args) {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
  }
  return res.stdout.split("\0").filter(Boolean);
}

/** Staged additions, copies, modifications and renames. Deletions stay allowed. */
export function stagedPaths() {
  return gitNameList(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
}

export function trackedPaths() {
  return gitNameList(["ls-files", "-z"]);
}

function main(argv) {
  const mode = argv[0];
  let paths;
  try {
    if (mode === "--staged") paths = stagedPaths();
    else if (mode === "--tracked") paths = trackedPaths();
    else if (mode === "--paths") paths = argv.slice(1);
    else {
      console.error("usage: check-forbidden-paths.mjs --staged | --tracked | --paths <file...>");
      return 2;
    }
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const violations = checkPaths(paths);
  for (const v of violations) console.error(`refused [${v.rule}]: ${v.path}`);
  return violations.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
