#!/usr/bin/env node
// Codebook freeze-guard (CDB-05), a close adaptation of check-protocol-order.mjs's own
// tag-ancestor and prefix-byte-comparison logic (D-21's pattern), for codebook.md's freeze point.
//
//   node scripts/check-codebook-order.mjs                default: fine before codebook-v1.0 exists
//   node scripts/check-codebook-order.mjs --require-tag  the annotated tag codebook-v1.0 must exist
//
// Rules, checked from the current directory's git repository:
//   1. When the tag exists, it must be an annotated tag.
//   2. The tagged text of codebook.md must be an exact prefix of the current file, so an
//      amendment can only be appended as an addendum and the tagged text is never edited.
//
// Unlike check-protocol-order.mjs, there is no "nothing may exist before this tag" rule here:
// the pipeline code this phase builds necessarily exists BEFORE the codebook is frozen.
//
// Exit 0 when the rules hold (printing "tag pending" while the tag does not exist), 1 with a
// reason when one is broken, 2 on a usage or git error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const TAG = "codebook-v1.0";
export const CODEBOOK_PATH = "codebook.md";

function git(args) {
  const res = spawnSync("git", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? Buffer.alloc(0), stderr: (res.stderr ?? Buffer.alloc(0)).toString("utf8") };
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

  if (tagExists) {
    const tagged = git(["show", `refs/tags/${TAG}:${CODEBOOK_PATH}`]);
    if (tagged.status !== 0) {
      problems.push(`the tag ${TAG} does not contain ${CODEBOOK_PATH}`);
    } else if (!fs.existsSync(CODEBOOK_PATH)) {
      problems.push(`${CODEBOOK_PATH} is missing from the working tree`);
    } else {
      const current = fs.readFileSync(CODEBOOK_PATH);
      if (current.length < tagged.stdout.length || !current.subarray(0, tagged.stdout.length).equals(tagged.stdout)) {
        problems.push(`the tagged text of ${CODEBOOK_PATH} is not an exact prefix of the current file (amendments must be appended only)`);
      }
    }
  }
  return { problems, tagPending: !tagExists };
}

function main(argv) {
  const requireTag = argv.includes("--require-tag");
  const unknown = argv.filter((a) => a !== "--require-tag");
  if (unknown.length) {
    console.error("usage: check-codebook-order.mjs [--require-tag]");
    return 2;
  }
  let result;
  try {
    result = checkOrder({ requireTag });
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  for (const p of result.problems) console.error(`codebook order: ${p}`);
  if (result.problems.length) return 1;
  console.log(result.tagPending ? "codebook order ok: tag pending, no codebook-v1.0 tag yet" : `codebook order ok: ${TAG} exists and is respected`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
