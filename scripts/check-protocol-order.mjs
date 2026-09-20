#!/usr/bin/env node
// Protocol ordering guard (decision D-21).
//
//   node scripts/check-protocol-order.mjs                default: fine while no pipeline file exists
//   node scripts/check-protocol-order.mjs --require-tag  the annotated tag protocol-v1 must exist
//
// Rules, checked from the current directory's git repository:
//   1. No file may exist under src/pipeline/ (tracked or on disk) unless the annotated tag
//      protocol-v1 exists.
//   2. Every commit that added a path under src/pipeline/ must come strictly AFTER the tag commit.
//   3. The tagged text of protocol/PROTOCOL.md must be an exact prefix of the current file, so an
//      amendment can only be appended as an addendum and the tagged text is never edited.
//
// Exit 0 when the rules hold (printing "tag pending" while the tag does not exist), 1 with a reason
// when one is broken, 2 on a usage or git error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TAG = "protocol-v1";
export const PROTOCOL_PATH = "protocol/PROTOCOL.md";
export const PIPELINE_DIR = "src/pipeline";

function git(args) {
  const res = spawnSync("git", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? Buffer.alloc(0), stderr: (res.stderr ?? Buffer.alloc(0)).toString("utf8") };
}

function filesOnDisk(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesOnDisk(p));
    else found.push(p);
  }
  return found;
}

/** Returns { problems: string[], tagPending: boolean }. */
export function checkOrder({ requireTag = false } = {}) {
  const problems = [];
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) throw new Error(`not a git repository: ${inside.stderr.trim()}`);

  const tagType = git(["cat-file", "-t", `refs/tags/${TAG}`]);
  const tagExists = tagType.status === 0;
  const annotated = tagExists && tagType.stdout.toString("utf8").trim() === "tag";
  if (tagExists && !annotated) problems.push(`tag ${TAG} exists but is not an annotated tag`);
  if (!tagExists && requireTag) problems.push(`tag ${TAG} does not exist (required)`);

  const tracked = git(["ls-files", "-z", "--", `${PIPELINE_DIR}/`]).stdout.toString("utf8").split("\0").filter(Boolean);
  const onDisk = filesOnDisk(PIPELINE_DIR);
  const present = new Set([...tracked, ...onDisk.map((p) => p.split(path.sep).join("/"))]);

  if (!tagExists && present.size > 0) {
    problems.push(`${present.size} file(s) under ${PIPELINE_DIR}/ exist before the tag ${TAG}: ${[...present].slice(0, 5).join(", ")}`);
  }

  if (tagExists) {
    const tagCommit = git(["rev-list", "-n", "1", `refs/tags/${TAG}`]).stdout.toString("utf8").trim();
    const added = git(["log", "--all", "--diff-filter=A", "--format=%H", "--", `${PIPELINE_DIR}/`]).stdout
      .toString("utf8").split("\n").filter(Boolean);
    for (const commit of new Set(added)) {
      const ancestor = commit !== tagCommit && git(["merge-base", "--is-ancestor", tagCommit, commit]).status === 0;
      if (!ancestor) problems.push(`commit ${commit.slice(0, 12)} added a path under ${PIPELINE_DIR}/ but does not come after the tag ${TAG}`);
    }

    const tagged = git(["show", `refs/tags/${TAG}:${PROTOCOL_PATH}`]);
    if (tagged.status !== 0) {
      problems.push(`the tag ${TAG} does not contain ${PROTOCOL_PATH}`);
    } else if (!fs.existsSync(PROTOCOL_PATH)) {
      problems.push(`${PROTOCOL_PATH} is missing from the working tree`);
    } else {
      const current = fs.readFileSync(PROTOCOL_PATH);
      if (current.length < tagged.stdout.length || !current.subarray(0, tagged.stdout.length).equals(tagged.stdout)) {
        problems.push(`the tagged text of ${PROTOCOL_PATH} is not an exact prefix of the current file (amendments must be appended only)`);
      }
    }
  }
  return { problems, tagPending: !tagExists };
}

function main(argv) {
  const requireTag = argv.includes("--require-tag");
  const unknown = argv.filter((a) => a !== "--require-tag");
  if (unknown.length) {
    console.error("usage: check-protocol-order.mjs [--require-tag]");
    return 2;
  }
  let result;
  try {
    result = checkOrder({ requireTag });
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  for (const p of result.problems) console.error(`protocol order: ${p}`);
  if (result.problems.length) return 1;
  console.log(result.tagPending ? "protocol order ok: tag pending, no pipeline file exists" : `protocol order ok: ${TAG} exists and is respected`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
