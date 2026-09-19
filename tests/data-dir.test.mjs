import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertOutsideRepo,
  resolvePrivateDir,
  resolveRepoRoot,
} from "../scripts/check-data-dir.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-data-dir.mjs",
);

const created = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prism-dd-${prefix}-`));
  created.push(dir);
  return dir;
}

describe("PRISM_DATA_DIR containment guard", () => {
  let repo;
  let outside;

  before(() => {
    repo = tmp("repo");
    outside = tmp("outside");
  });

  after(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("(a) a directory outside the repo passes", () => {
    const resolved = assertOutsideRepo(path.join(outside, "data"), repo);
    assert.equal(resolved, path.join(fs.realpathSync.native(outside), "data"));
  });

  test("(b) a directory directly inside the repo fails", () => {
    const inner = path.join(repo, "data");
    fs.mkdirSync(inner);
    assert.throws(() => assertOutsideRepo(inner, repo), { code: "DATA_DIR_INSIDE_REPO" });
  });

  test("(c) a not-yet-existing nested path inside the repo fails", () => {
    const inner = path.join(repo, "does", "not", "exist", "yet");
    assert.equal(fs.existsSync(inner), false);
    assert.throws(() => assertOutsideRepo(inner, repo), { code: "DATA_DIR_INSIDE_REPO" });
  });

  test("(d) a symlink outside the repo that points into it fails", () => {
    const target = path.join(repo, "linked-target");
    fs.mkdirSync(target);
    const link = path.join(outside, "link");
    fs.symlinkSync(target, link);
    assert.throws(() => assertOutsideRepo(link, repo), { code: "DATA_DIR_INSIDE_REPO" });
    // and a not-yet-existing child beneath that symlink is rejected too
    assert.throws(() => assertOutsideRepo(path.join(link, "child"), repo), {
      code: "DATA_DIR_INSIDE_REPO",
    });
  });

  test("(e) the repo root itself fails", () => {
    assert.throws(() => assertOutsideRepo(repo, repo), { code: "DATA_DIR_INSIDE_REPO" });
  });

  test("(f) a relative value makes resolvePrivateDir throw DATA_DIR_RELATIVE", () => {
    assert.throws(() => resolvePrivateDir({ PRISM_DATA_DIR: "data/private" }, repo), {
      code: "DATA_DIR_RELATIVE",
    });
    assert.throws(() => resolvePrivateDir({ PRISM_DATA_DIR: "./data" }, repo), {
      code: "DATA_DIR_RELATIVE",
    });
  });

  test("(g) an unset variable resolves to a home-based path that passes", () => {
    const resolved = resolvePrivateDir({}, repo);
    assert.equal(resolved, path.join(os.homedir(), ".prism-data"));
    assert.doesNotThrow(() => assertOutsideRepo(resolved, repo));
    assert.equal(resolvePrivateDir({ PRISM_DATA_DIR: "~/x" }, repo), path.join(os.homedir(), "x"));
  });

  test("(h) CLI subprocess exits 1 inside a git repo, 0 outside, 2 for relative", () => {
    const gitRepo = tmp("gitrepo");
    const init = spawnSync("git", ["init", "-q"], { cwd: gitRepo });
    assert.equal(init.status, 0, "git init must succeed for this case to be meaningful");
    assert.equal(
      fs.realpathSync.native(resolveRepoRoot(gitRepo)),
      fs.realpathSync.native(gitRepo),
    );

    const badDir = path.join(gitRepo, "private-data");
    const bad = spawnSync(process.execPath, [SCRIPT], {
      cwd: gitRepo,
      env: { ...process.env, PRISM_DATA_DIR: badDir },
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes("private-data"), `stderr should name the path: ${bad.stderr}`);

    const goodDir = path.join(outside, "cli-ok");
    const good = spawnSync(process.execPath, [SCRIPT], {
      cwd: gitRepo,
      env: { ...process.env, PRISM_DATA_DIR: goodDir },
      encoding: "utf8",
    });
    assert.equal(good.status, 0, good.stderr);
    assert.ok(good.stdout.startsWith("PRISM_DATA_DIR ok: "));

    const rel = spawnSync(process.execPath, [SCRIPT], {
      cwd: gitRepo,
      env: { ...process.env, PRISM_DATA_DIR: "data" },
      encoding: "utf8",
    });
    assert.equal(rel.status, 2);
  });
});
