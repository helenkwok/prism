import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTempGitRepo } from "./helpers/temp-git-repo.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/check-forbidden-paths.mjs",
);

// An agent-tool path, kept base64-encoded so this file names none in cleartext.
const SAMPLE_AGENT_PATH_B64 = "LmNvZGV4L2NvbmZpZy50b21s";
const sampleAgentPath = () => Buffer.from(SAMPLE_AGENT_PATH_B64, "base64").toString("utf8");

function checkPaths(...paths) {
  const res = spawnSync("node", [SCRIPT, "--paths", ...paths], { encoding: "utf8" });
  return { status: res.status, stderr: res.stderr };
}

describe("path guard: unit rules through --paths", () => {
  test("a reference deck is refused and named by rule", () => {
    const r = checkPaths("references/deck.pptx");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reference-documents/);
    assert.match(r.stderr, /references\/deck\.pptx/);
  });

  test("any path under references/ is refused, whatever its extension", () => {
    assert.equal(checkPaths("references/notes.txt").status, 1);
  });

  test("an ordinary markdown file is allowed", () => {
    const r = checkPaths("notes.md");
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  });

  test("office binaries are refused anywhere", () => {
    for (const p of ["a.pptx", "docs/a.ppt", "x/b.key", "c.docx", "d.doc", "e.xlsx", "f.xls"]) {
      const r = checkPaths(p);
      assert.equal(r.status, 1, `${p} should be refused`);
      assert.match(r.stderr, /office-binary/);
    }
  });

  test("a pdf outside public-data is refused and one inside is allowed", () => {
    const blocked = checkPaths("docs/paper.pdf");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /pdf-outside-public-data/);
    assert.equal(checkPaths("public-data/x.pdf").status, 0);
  });

  test(".env is refused and .env.example is allowed", () => {
    const blocked = checkPaths(".env");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /private-data-env-file/);
    assert.equal(checkPaths(".env.local").status, 1);
    assert.equal(checkPaths("app/.env.production").status, 1);
    assert.equal(checkPaths(".env.example").status, 0);
  });

  test("database files are refused", () => {
    for (const p of ["prism.sqlite", "a/b.sqlite3", "x.db", "prism.sqlite-wal"]) {
      const r = checkPaths(p);
      assert.equal(r.status, 1, `${p} should be refused`);
      assert.match(r.stderr, /private-data-database/);
    }
  });

  test("a snapshots/ directory is refused", () => {
    const r = checkPaths("data/snapshots/page.html");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /private-data-snapshots/);
  });

  test("an agent-tool path built at run time from a base64 sample is refused", () => {
    const r = checkPaths(sampleAgentPath());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /agent-tool-path/);
  });

  test("agent-tool path matching is case-insensitive", () => {
    assert.equal(checkPaths(sampleAgentPath().toUpperCase()).status, 1);
  });

  test("names that merely resemble a rule are allowed", () => {
    for (const p of ["src/references.mjs", "docs/snapshot.md", "notes/environment.md", "scripts/db-utils.mjs", "public-data/tables.json"]) {
      assert.equal(checkPaths(p).status, 0, `${p} should be allowed`);
    }
  });

  test("no arguments is a usage error, not a pass", () => {
    const res = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 2);
  });
});

describe("path guard: real commits through the tracked pre-commit hook", () => {
  const repos = [];
  after(() => repos.forEach((r) => r.cleanup()));

  function repo() {
    const r = createTempGitRepo({ prefix: "prism-fp" });
    repos.push(r);
    return r;
  }

  test("PROOF: committing a staged reference deck is refused, HEAD is unchanged and the deck stays staged", () => {
    const r = repo();
    r.write("readme-seed.md", "seed\n");
    r.stage("readme-seed.md");
    const seed = r.git("commit", "-q", "-m", "seed");
    assert.equal(seed.status, 0, seed.stderr);
    const headBefore = r.git("rev-parse", "HEAD").stdout.trim();

    r.write("references/deck.pptx", "not a real deck\n");
    r.stage("references/deck.pptx");
    const commit = r.git("commit", "-m", "x");

    assert.notEqual(commit.status, 0, "the commit must be refused");
    assert.match(commit.stderr, /refused \[reference-documents\]: references\/deck\.pptx/);
    assert.equal(r.git("rev-parse", "HEAD").stdout.trim(), headBefore, "no new commit may exist");
    const staged = r.git("diff", "--cached", "--name-only").stdout.trim().split("\n");
    assert.deepEqual(staged, ["references/deck.pptx"], "the deck must still be staged");
  });

  test("PROOF on an empty repository: the first commit is refused and HEAD does not exist", () => {
    const r = repo();
    r.write("references/deck.pptx", "x\n");
    r.stage("references/deck.pptx");
    const commit = r.git("commit", "-m", "x");
    assert.notEqual(commit.status, 0);
    assert.notEqual(r.git("rev-parse", "--verify", "HEAD").status, 0, "HEAD must still not exist");
  });

  test("an innocuous file commits in the same repository once the deck is unstaged", () => {
    const r = repo();
    r.write("references/deck.pptx", "x\n");
    r.stage("references/deck.pptx");
    assert.notEqual(r.git("commit", "-m", "x").status, 0);
    assert.equal(r.git("rm", "-q", "--cached", "references/deck.pptx").status, 0);
    r.write("notes.md", "fine\n");
    r.stage("notes.md");
    const ok = r.git("commit", "-q", "-m", "notes");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(r.git("rev-parse", "--verify", "HEAD").status, 0);
  });

  test("removing an already-tracked forbidden file is allowed (deletions are not refused)", () => {
    const r = repo();
    r.write("references/deck.pptx", "x\n");
    r.stage("references/deck.pptx", { force: true });
    assert.equal(r.git("commit", "-q", "--no-verify", "-m", "add").status, 0);
    assert.equal(r.git("rm", "-q", "--cached", "references/deck.pptx").status, 0);
    const del = r.git("commit", "-q", "-m", "remove");
    assert.equal(del.status, 0, del.stderr);
  });

  test("BACKSTOP: --tracked fails after a forbidden file is committed with the hook bypassed", () => {
    const r = repo();
    r.write("notes.md", "fine\n");
    r.stage("notes.md");
    assert.equal(r.git("commit", "-q", "-m", "notes").status, 0);
    assert.equal(r.run("node", ["scripts/check-forbidden-paths.mjs", "--tracked"]).status, 0, "clean tree first");

    r.write("references/deck.pptx", "x\n");
    r.stage("references/deck.pptx", { force: true });
    const bypassed = r.git("commit", "-q", "--no-verify", "-m", "sneak");
    assert.equal(bypassed.status, 0, "the bypassed commit lands, as it would in real life");

    const tracked = r.run("node", ["scripts/check-forbidden-paths.mjs", "--tracked"]);
    assert.equal(tracked.status, 1);
    assert.match(tracked.stderr, /references\/deck\.pptx/);
  });
});
