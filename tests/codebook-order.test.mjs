// CDB-05 coverage for the codebook freeze-guard, run against a throwaway git repository so the
// result does not depend on whether this repository has been tagged yet.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { checkOrder, TAG, CODEBOOK_PATH } from "../scripts/check-codebook-order.mjs";

describe("checkOrder (CDB-05)", () => {
  const cwd = process.cwd();
  let dir;
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  const write = (text) => fs.writeFileSync(path.join(dir, CODEBOOK_PATH), text);
  const commit = (msg) => {
    git("add", CODEBOOK_PATH);
    git("commit", "-q", "-m", msg);
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebook-order-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "tag.gpgSign", "false");
    git("config", "commit.gpgSign", "false");
    write("# Codebook\n\nfrozen text\n");
    commit("draft");
    process.chdir(dir);
  });
  after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("before the tag exists: pending and fine, unless the tag is required", () => {
    assert.deepEqual(checkOrder({ requireTag: false }).problems, []);
    assert.equal(checkOrder({ requireTag: false }).tagPending, true);
    const required = checkOrder({ requireTag: true });
    assert.equal(required.problems.length, 1);
    assert.match(required.problems[0], new RegExp(TAG.replace(".", "\\.")));
  });

  test("after an annotated tag, appending an addendum is fine and editing tagged text is not", () => {
    git("tag", "-a", TAG, "-m", "freeze");
    assert.deepEqual(checkOrder({ requireTag: true }).problems, []);
    write("# Codebook\n\nfrozen text\n\n## Addendum\n\nnew\n");
    assert.deepEqual(checkOrder({ requireTag: true }).problems, []);
    write("# Codebook\n\nedited text\n");
    assert.ok(checkOrder({ requireTag: true }).problems.length > 0);
    write("# Codebook\n\nfrozen text\n");
  });

  test("a lightweight tag is refused", () => {
    git("tag", "-d", TAG);
    git("tag", TAG);
    assert.ok(checkOrder({ requireTag: true }).problems.length > 0);
  });
});
