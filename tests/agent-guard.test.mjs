import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPatterns, scanText } from "../scripts/check-agent-names.mjs";
import { createTempGitRepo } from "./helpers/temp-git-repo.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every violating sample is base64 so this file never contains one in cleartext.
const dec = (b64) => Buffer.from(b64, "base64").toString("utf8");
const SAMPLE_TEXT = dec("QnVpbHQgd2l0aCBDbGF1ZGUgQ29kZSBmb3IgdGhlIGRlbW8u");
const SAMPLE_TRAILER = dec("Q28tQXV0aG9yZWQtQnk6IENsYXVkZSA8bm9yZXBseUBhbnRocm9waWMuY29tPg==");
const SAMPLE_EMAIL = dec("bm9yZXBseUBhbnRocm9waWMuY29t");
const SAMPLE_TAG_MESSAGE = dec(
  "cmVsZWFzZSBub3RlcywgZ2VuZXJhdGVkIHdpdGggW0NsYXVkZSBDb2RlXShodHRwczovL2V4YW1wbGUuaW52YWxpZCk=",
);
// A single vendor word taken from the sample, used to prove output never echoes matched text.
const SAMPLE_WORD = SAMPLE_TEXT.split(" ")[2].toLowerCase();

const GUARD = "scripts/check-agent-names.mjs";

describe("name guard", () => {
  const repos = [];
  after(() => repos.forEach((r) => r.cleanup()));

  function repo() {
    const r = createTempGitRepo({ prefix: "prism-ag" });
    repos.push(r);
    return r;
  }

  /** Commit one clean file so the repo has a history to scan. */
  function seeded() {
    const r = repo();
    r.write("notes.md", "plain notes\n");
    r.stage("notes.md");
    const c = r.git("commit", "-q", "-m", "seed notes");
    assert.equal(c.status, 0, c.stderr);
    return r;
  }

  const guard = (r, ...args) => r.run("node", [GUARD, ...args]);

  test("a clean repository passes every mode", () => {
    const r = seeded();
    for (const args of [[], ["--files"], ["--history"]]) {
      const res = guard(r, ...args);
      assert.equal(res.status, 0, `${args.join(" ") || "default"}: ${res.stderr}`);
    }
  });

  test("an empty repository (no commits yet) passes", () => {
    const r = repo();
    const res = guard(r);
    assert.equal(res.status, 0, res.stderr);
  });

  test("a tracked file containing a sample fails --files, with location and pattern index only", () => {
    const r = seeded();
    r.write("docs/intro.md", `line one\n${SAMPLE_TEXT}\n`);
    r.stage("docs/intro.md");
    assert.equal(r.git("commit", "-q", "-m", "add intro").status, 0);
    const res = guard(r, "--files");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /pattern #\d+ at docs\/intro\.md:2/);
    assert.ok(!res.stderr.toLowerCase().includes(SAMPLE_WORD), "matched text must never be printed");
  });

  test("a commit message carrying a trailer sample fails --history", () => {
    const r = seeded();
    r.write("a.md", "a\n");
    r.stage("a.md");
    const c = r.git("commit", "-q", "--no-verify", "-m", `add a\n\n${SAMPLE_TRAILER}`);
    assert.equal(c.status, 0, c.stderr);
    const res = guard(r, "--history");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /pattern #\d+ at commit [0-9a-f]{12} message/);
    assert.ok(!res.stderr.toLowerCase().includes(SAMPLE_WORD));
  });

  test("a commit whose author email is a sample fails --history", () => {
    const r = seeded();
    r.write("b.md", "b\n");
    r.stage("b.md");
    const c = r.run("git", ["commit", "-q", "-m", "add b"], {
      env: { GIT_AUTHOR_EMAIL: SAMPLE_EMAIL },
    });
    assert.equal(c.status, 0, c.stderr);
    const res = guard(r, "--history");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /author email/);
  });

  test("a commit whose committer name is a sample fails --history", () => {
    const r = seeded();
    r.write("c.md", "c\n");
    r.stage("c.md");
    const c = r.run("git", ["commit", "-q", "-m", "add c"], {
      env: { GIT_COMMITTER_NAME: SAMPLE_TEXT.split(" ").slice(2, 4).join(" ") },
    });
    assert.equal(c.status, 0, c.stderr);
    const res = guard(r, "--history");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /committer name/);
  });

  test("an annotated tag message carrying a sample fails --history", () => {
    const r = seeded();
    const t = r.git("tag", "-a", "v0", "-m", SAMPLE_TAG_MESSAGE);
    assert.equal(t.status, 0, t.stderr);
    const res = guard(r, "--history");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /at tag [0-9a-f]{12} message/);
  });

  test("the commit-msg hook rejects a violating message and creates no commit", () => {
    const r = seeded();
    const headBefore = r.git("rev-parse", "HEAD").stdout.trim();
    r.write("d.md", "d\n");
    r.stage("d.md");
    const c = r.git("commit", "-m", `add d\n\n${SAMPLE_TRAILER}`);
    assert.notEqual(c.status, 0, "the commit must be refused");
    assert.match(c.stderr, /name guard: pattern #\d+ at commit message line/);
    assert.equal(r.git("rev-parse", "HEAD").stdout.trim(), headBefore, "no new commit may exist");
    assert.deepEqual(r.git("diff", "--cached", "--name-only").stdout.trim().split("\n"), ["d.md"]);
  });

  test("the commit-msg hook accepts a clean message", () => {
    const r = seeded();
    r.write("e.md", "e\n");
    r.stage("e.md");
    const c = r.git("commit", "-q", "-m", "add e");
    assert.equal(c.status, 0, c.stderr);
  });

  test("--message ignores comment lines, as git does", () => {
    const r = seeded();
    r.write("msg.txt", `subject\n# ${SAMPLE_TEXT}\n`);
    assert.equal(guard(r, "--message", "msg.txt").status, 0);
    r.write("msg2.txt", `subject\n${SAMPLE_TEXT}\n`);
    assert.equal(guard(r, "--message", "msg2.txt").status, 1);
  });

  test("a maintainer's own GitHub no-reply address does not trip the guard", () => {
    const r = repo();
    r.write("f.md", "f\n");
    r.stage("f.md");
    const c = r.run("git", ["commit", "-q", "-m", "add f"], {
      env: { GIT_AUTHOR_EMAIL: "12345+maintainer@users.noreply.github.com" },
    });
    assert.equal(c.status, 0, c.stderr);
    assert.equal(guard(r).status, 0);
  });

  test("CSS cursor text and database cursors do NOT trigger", () => {
    const r = repo();
    r.write(
      "style.css",
      [
        "button { cursor: pointer; }",
        ".cursor-pointer { cursor: pointer; }",
        "the database cursor advances one row",
        "const rows = db.cursor();",
        "",
      ].join("\n"),
    );
    r.stage("style.css");
    assert.equal(r.git("commit", "-q", "-m", "add style").status, 0);
    const res = guard(r);
    assert.equal(res.status, 0, res.stderr);
  });

  test("binary files (NUL in the first 8 KB) are skipped", () => {
    const r = repo();
    const abs = r.write("blob.bin", "");
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SAMPLE_TEXT)]));
    r.stage("blob.bin");
    assert.equal(r.git("commit", "-q", "-m", "add blob").status, 0);
    assert.equal(guard(r, "--files").status, 0);
  });

  test("unknown flags and a missing --message file argument are usage errors, not passes", () => {
    const r = repo();
    assert.equal(guard(r, "--nope").status, 2);
    assert.equal(guard(r, "--message").status, 2);
  });

  test("the pattern list decodes and every entry is a working expression", () => {
    const patterns = loadPatterns();
    assert.ok(patterns.length >= 15);
    assert.ok(scanText(SAMPLE_TEXT, patterns).length > 0, "a decoded sample must match");
  });

  test("SELF-SCAN: the guards, hooks, helper and tests contain no pattern in cleartext", () => {
    const patterns = loadPatterns();
    const targets = [];
    for (const dir of ["scripts", ".githooks", "tests"]) {
      const walk = (d) => {
        for (const entry of fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true })) {
          const rel = path.join(d, entry.name);
          if (entry.isDirectory()) walk(rel);
          else targets.push(rel);
        }
      };
      walk(dir);
    }
    for (const required of [
      "scripts/check-agent-names.mjs",
      "scripts/check-forbidden-paths.mjs",
      ".githooks/pre-commit",
      ".githooks/commit-msg",
      "tests/agent-guard.test.mjs",
    ]) {
      assert.ok(targets.includes(required), `${required} must be part of the scan`);
    }
    for (const rel of targets) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const hits = scanText(text, patterns);
      assert.deepEqual(hits, [], `${rel} contains a pattern in cleartext (pattern index and line shown)`);
    }
  });
});
