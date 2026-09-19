#!/usr/bin/env node
// Name guard: no tracked file, commit message, identity or tag message may
// match a pattern from the list below (decisions D-23, D-25).
//
//   node scripts/check-agent-names.mjs                  files + commit history + tags
//   node scripts/check-agent-names.mjs --files          contents of every tracked text file
//   node scripts/check-agent-names.mjs --history        commit messages, author and committer
//                                                       names and emails, annotated tag messages
//   node scripts/check-agent-names.mjs --message <file> one commit message file (commit-msg hook)
//
// Exit 0 when clean, 1 on any match, 2 on a usage or git error. Output names the
// location and the pattern INDEX only; the matched text is never printed.
//
// The pattern list is stored base64-encoded so that this script, its tests and
// the hook never contain a pattern in cleartext and cannot flag themselves.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Each entry decodes to a regular expression source, matched case-insensitively
// against one line at a time. Bare common words (a lone "cursor", for example)
// are deliberately absent so CSS and database cursors are not flagged.
export const PATTERNS_B64 = [
  "XGJjbGF1ZGVcYg==",
  "Y2xhdWRlWy1fIF0/Y29kZQ==",
  "XGJhbnRocm9waWNcYg==",
  "XGJjb2RleFxi",
  "KD88IVtcdy5dKVwuY3Vyc29yKD8hWy1cd10pfGN1cnNvclstXyBdP2FnZW50fGN1cnNvcnJ1bGVz",
  "XGJjb3BpbG90XGI=",
  "XGJ3aW5kc3VyZlxi",
  "XGJjb2RlaXVtXGI=",
  "Z2VtaW5pWy1fIF0/Y2xp",
  "XGJvcGVuY29kZVxi",
  "XGJhaWRlclxi",
  "XGJjbGluZVxi",
  "XGJnc2RcYnxnZXQtc2hpdC1kb25lfG9wZW5nc2Q=",
  "XGJhZ2VudHNcLm1kXGJ8XGJnZW1pbmlcLm1kXGJ8Y29waWxvdC1pbnN0cnVjdGlvbnM=",
  "Y28tYXV0aG9yZWQtYnk=",
  "XGIoZ2VuZXJhdGVkfGNyZWF0ZWQpIHdpdGggXFs=",
  "L2NvZGUvc2Vzc2lvbltfL10=",
  "QChhbnRocm9waWN8b3BlbmFpfGN1cnNvcnx3aW5kc3VyZnxjb2RlaXVtfG9wZW5jb2RlfGFpZGVyfGNsaW5lKVwuKGNvbXxhaXxzaHxkZXZ8aW8pXGI=",
];

export function loadPatterns() {
  return PATTERNS_B64.map((b64) => new RegExp(Buffer.from(b64, "base64").toString("utf8"), "i"));
}

/** Returns [{ line, pattern }] (1-based line, 0-based pattern index), one entry per pattern per line. */
export function scanText(text, patterns = loadPatterns()) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (let p = 0; p < patterns.length; p++) {
      if (patterns[p].test(lines[i])) hits.push({ line: i + 1, pattern: p });
    }
  }
  return hits;
}

function git(args) {
  const res = spawnSync("git", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return {
    status: res.status,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: (res.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

/** Surface 1: contents of every tracked text file. Returns findings. */
export function scanTrackedFiles(patterns = loadPatterns()) {
  const ls = git(["ls-files", "-z"]);
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
  const findings = [];
  for (const rel of ls.stdout.toString("utf8").split("\0").filter(Boolean)) {
    let buf;
    try {
      const stat = fs.lstatSync(rel);
      if (!stat.isFile()) continue; // symlinks and gitlinks are not text content
      buf = fs.readFileSync(rel);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (isBinary(buf)) continue;
    for (const h of scanText(buf.toString("utf8"), patterns)) {
      findings.push({ location: `${rel}:${h.line}`, pattern: h.pattern });
    }
  }
  return findings;
}

const NUL = "\0";
const RS = "\x01";

function scanField(value, location, patterns, findings) {
  for (const h of scanText(value, patterns)) {
    findings.push({ location: `${location}${h.line > 1 ? ` line ${h.line}` : ""}`, pattern: h.pattern });
  }
}

/** Surface 2: commit messages plus author and committer identities on all refs. */
export function scanCommits(patterns = loadPatterns()) {
  const res = git(["log", "--all", `--format=%H${"%x00"}%an${"%x00"}%ae${"%x00"}%cn${"%x00"}%ce${"%x00"}%B${"%x01"}`]);
  if (res.status !== 0) {
    if (/does not have any commits|unknown revision/i.test(res.stderr)) return [];
    throw new Error(`git log failed: ${res.stderr.trim()}`);
  }
  const findings = [];
  for (const record of res.stdout.toString("utf8").split(RS)) {
    const rec = record.replace(/^\n+/, "");
    if (!rec.trim()) continue;
    const [id, an, ae, cn, ce, ...rest] = rec.split(NUL);
    const body = rest.join(NUL);
    const short = id.slice(0, 12);
    scanField(an, `commit ${short} author name`, patterns, findings);
    scanField(ae, `commit ${short} author email`, patterns, findings);
    scanField(cn, `commit ${short} committer name`, patterns, findings);
    scanField(ce, `commit ${short} committer email`, patterns, findings);
    scanField(body, `commit ${short} message`, patterns, findings);
  }
  return findings;
}

/** Surface 3: annotated tag messages and tagger identities. */
export function scanTags(patterns = loadPatterns()) {
  const res = git([
    "for-each-ref",
    `--format=%(objecttype)${"%00"}%(objectname)${"%00"}%(taggername)${"%00"}%(taggeremail)${"%00"}%(contents)${"%01"}`,
    "refs/tags",
  ]);
  if (res.status !== 0) throw new Error(`git for-each-ref failed: ${res.stderr.trim()}`);
  const findings = [];
  for (const record of res.stdout.toString("utf8").split(RS)) {
    const rec = record.replace(/^\n+/, "");
    if (!rec.trim()) continue;
    const [type, id, name, email, ...rest] = rec.split(NUL);
    if (type !== "tag") continue; // lightweight tags carry no message
    const short = id.slice(0, 12);
    scanField(name, `tag ${short} tagger name`, patterns, findings);
    scanField(email, `tag ${short} tagger email`, patterns, findings);
    scanField(rest.join(NUL), `tag ${short} message`, patterns, findings);
  }
  return findings;
}

/** Surface 4: one commit message file. Comment lines (starting with #) are dropped, as git does. */
export function scanMessageFile(file, patterns = loadPatterns()) {
  const text = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => (l.startsWith("#") ? "" : l))
    .join("\n");
  return scanText(text, patterns).map((h) => ({
    location: `commit message line ${h.line}`,
    pattern: h.pattern,
  }));
}

function main(argv) {
  const mode = argv[0];
  let findings = [];
  try {
    if (mode === undefined) {
      findings = [...scanTrackedFiles(), ...scanCommits(), ...scanTags()];
    } else if (mode === "--files") {
      findings = scanTrackedFiles();
    } else if (mode === "--history") {
      findings = [...scanCommits(), ...scanTags()];
    } else if (mode === "--message" && argv[1]) {
      findings = scanMessageFile(argv[1]);
    } else {
      console.error("usage: check-agent-names.mjs [--files | --history | --message <file>]");
      return 2;
    }
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  for (const f of findings) console.error(`name guard: pattern #${f.pattern} at ${f.location}`);
  if (findings.length > 0) {
    console.error(`name guard: ${findings.length} match(es). Remove the text; see the project's public-repository rules.`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
