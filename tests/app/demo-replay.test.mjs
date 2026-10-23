// SUB-01 / D-82: the demo replay turns one own project's ReportView into an
// ordered terminal-browser sequence, writes nothing, and refuses a view that is
// not Helen's own (plan 07-04).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";
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

  test("marking: one eval step per cited quote right after its page's open step, in check order", () => {
    const steps = buildSteps(view, { ownHost: OWN, reportUrl: REPORT });
    const [u1, u2, u3] = view.collection.urls;
    const q = (url) => view.checks.flatMap((c) => c.quotes).filter((x) => x.url === url).map((x) => x.text);
    assert.deepEqual(q(u1).length, 1);
    assert.deepEqual(q(u2).length, 1);
    assert.deepEqual(
      steps.map((s) => (s.args.includes("eval") ? `eval:${s.quote}` : `open:${s.args.at(-1) === "right" ? s.args[1] : s.args.at(-1)}`)),
      [`open:${u1}`, `eval:${q(u1)[0]}`, `open:${u2}`, `eval:${q(u2)[0]}`, `open:${u3}`, `open:${REPORT}`],
    );
    for (const s of steps.filter((x) => x.args.includes("eval"))) assert.deepEqual(s.args.slice(0, 3), ["action", "--", "eval"]);
  });

  test("hostile quote: it appears in the eval argument only as a JSON string literal, and the script stays inert", () => {
    const hostile = 'He said "stop" \\ then </script><script>globalThis.pwned=1</script> `${globalThis.pwned=2}`  end';
    const mk = (text) => {
      const v = structuredClone(view);
      v.checks[0].quotes = [{ spanId: "sx", text, url: v.collection.urls[0], snapshotHash: null, injectionFlagged: true }];
      for (const c of v.checks.slice(1)) c.quotes = [];
      return buildSteps(v, { ownHost: OWN, reportUrl: REPORT }).find((s) => s.args.includes("eval")).args.at(-1);
    };
    const js = mk(hostile);
    const literal = JSON.stringify(hostile);
    assert.equal(js.split(literal).length, 2, "the quote appears exactly once, as its JSON literal");
    // With the literal taken out, the script is the fixed marker, identical for any quote.
    assert.equal(js.replace(literal, "Q"), mk("benign").replace(JSON.stringify("benign"), "Q"));
    // Run it against an empty page: nothing executes from the quote, and it reports "missing".
    const sandbox = { document: { body: {}, createTreeWalker: () => ({ nextNode: () => null }) }, NodeFilter: { SHOW_TEXT: 4 } };
    sandbox.globalThis = sandbox;
    assert.equal(vm.runInNewContext(js, sandbox), "prism-mark:missing");
    assert.equal(sandbox.pwned, undefined);
  });

  test("not found: the runner's missing result prints a note and the replay continues", async () => {
    const steps = buildSteps(view, { ownHost: OWN, reportUrl: REPORT });
    const calls = [];
    const logged = [];
    const runner = (cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: args.includes("eval") ? '"prism-mark:missing"\n' : "" };
    };
    assert.equal(await run(steps, { runner, pauseMs: 0, log: (l) => logged.push(l) }), 0);
    assert.equal(calls.length, steps.length);
    const evalSteps = steps.flatMap((s, i) => (s.args.includes("eval") ? [i + 1] : []));
    assert.deepEqual(logged.filter((l) => l.startsWith("REPLAY note=")), evalSteps.map((n) => `REPLAY note=quote-not-found step=${n}`));

    const found = [];
    await run(steps, { runner: (c, a) => ({ status: 0, stdout: a.includes("eval") ? "prism-mark:found" : "" }), pauseMs: 0, log: (l) => found.push(l) });
    assert.equal(found.filter((l) => l.startsWith("REPLAY note=")).length, 0);
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
