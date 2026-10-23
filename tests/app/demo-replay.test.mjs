// SUB-01 / D-82: the demo replay turns one own project's ReportView into an
// ordered terminal-browser sequence, writes nothing, and refuses a view that is
// not Helen's own (plan 07-04).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSteps, replayLine, run } from "../../scripts/demo-replay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "demo-replay.mjs");
const fixtureDir = path.join(root, "tests", "fixtures", "replay");
const viewPath = path.join(fixtureDir, "own-view.json");
const view = JSON.parse(fs.readFileSync(viewPath, "utf8"));
const OWN = "helen-own.example";
const REPORT = "http://127.0.0.1:3000/p/OWN01";

const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const replayLines = (out) => out.split("\n").filter((l) => l.startsWith("REPLAY step="));

function dirDigest(dir) {
  const h = crypto.createHash("sha256");
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    h.update(name);
    h.update(fs.statSync(p).isDirectory() ? dirDigest(p) : fs.readFileSync(p));
  }
  return h.digest("hex");
}

function recorder() {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: "" };
  };
  return { calls, runner };
}

describe("demo replay (SUB-01)", () => {
  test("dry run: first page in a split pane, the rest in collection order, then the report", () => {
    const r = cli("--view", viewPath, "--own-host", OWN, "--report-url", REPORT, "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    const opens = replayLines(r.stdout)
      .map((l) => JSON.parse(l.slice(l.indexOf("args=") + 5)))
      .filter((a) => a.includes("open"));
    const urls = view.collection.urls;
    assert.equal(urls.length, 3);
    assert.deepEqual(opens, [["open", urls[0], "--split", "right"], ["action", "--", "open", urls[1]], ["action", "--", "open", urls[2]], ["action", "--", "open", REPORT]]);
    for (const l of replayLines(r.stdout)) assert.match(l, /^REPLAY step=\d+ cmd=terminal-browser args=\[/);
  });

  test("the injected runner records exactly the dry run's command list", async () => {
    const steps = buildSteps(view, { ownHost: OWN, reportUrl: REPORT });
    const { calls, runner } = recorder();
    const logged = [];
    assert.equal(await run(steps, { runner, pauseMs: 0, log: (l) => logged.push(l) }), 0);
    const dry = replayLines(cli("--view", viewPath, "--own-host", OWN, "--report-url", REPORT, "--dry-run").stdout);
    assert.deepEqual(calls.map((c, i) => replayLine(i + 1, c)), dry);
    assert.deepEqual(logged.filter((l) => l.startsWith("REPLAY step=")), dry);
  });

  test("write-free: the fixture directory is byte-identical after a dry run and a recorded run", async () => {
    const before = dirDigest(fixtureDir);
    cli("--view", viewPath, "--own-host", OWN, "--report-url", REPORT, "--dry-run");
    const { runner } = recorder();
    await run(buildSteps(view, { ownHost: OWN, reportUrl: REPORT }), { runner, pauseMs: 0, log: () => {} });
    assert.equal(dirDigest(fixtureDir), before);
  });

  test("refusal: no --own-host, or a page outside it, is not an own project and runs nothing", async () => {
    const missing = cli("--view", viewPath, "--report-url", REPORT, "--dry-run");
    assert.match(missing.stderr, /not an own project/);
    assert.equal(replayLines(missing.stdout).length, 0);

    const other = cli("--view", viewPath, "--own-host", "someone-else.example", "--report-url", REPORT, "--dry-run");
    assert.match(other.stderr, /not an own project/);
    assert.equal(replayLines(other.stdout).length, 0);

    // A look-alike host (helen-own.example.evil.example) is not a subdomain.
    const tampered = structuredClone(view);
    tampered.collection.urls[1] = "https://helen-own.example.evil.example/";
    assert.throws(() => buildSteps(tampered, { ownHost: OWN, reportUrl: REPORT }), /not an own project/);
    const suffix = structuredClone(view);
    suffix.collection.urls[2] = "https://nothelen-own.example/";
    assert.throws(() => buildSteps(suffix, { ownHost: OWN, reportUrl: REPORT }), /not an own project/);
  });
});
