// Static checks of scripts/vm-deploy.sh (plan 07-12c). The script runs on the VM as root,
// so these tests read it rather than run it (bash -n aside).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";

const FILE = "scripts/vm-deploy.sh";
const src = fs.readFileSync(FILE, "utf8");
// One logical line per command: join backslash continuations.
const lines = src.replace(/\\\n\s*/g, " ").split("\n");
const runs = lines.filter((l) => /\bdocker run\b/.test(l));
const fnBody = (name) => new RegExp(`${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? "";

test("vm-deploy.sh parses", () => {
  const r = spawnSync("bash", ["-n", FILE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("every docker run names a prism-* container and caps CPU and memory", () => {
  assert.ok(runs.length >= 8, `found ${runs.length} docker run lines`);
  for (const l of runs) {
    assert.match(l, /--name "?prism-[a-z-]+/, l);
    assert.match(l, /--cpus=\S+/, l);
    assert.match(l, /--memory=\S+/, l);
  }
});

test("every run of the app image runs as uid 10001", () => {
  assert.match(src, /^APP_UID=10001$/m);
  const appRuns = runs.filter((l) => /"\$img"|"prism-app:\$sha"|--name prism-app\b/.test(l));
  assert.ok(appRuns.length >= 7, `found ${appRuns.length} app-image runs`);
  for (const l of appRuns) assert.ok(l.includes('--user "$APP_UID:$APP_UID"'), l);
});

test("only Caddy publishes a port, and only 443/tcp; the app publishes none", () => {
  const app = runs.find((l) => /--name prism-app\b/.test(l));
  assert.ok(app);
  assert.doesNotMatch(app, /\s(-p|--publish)\b/);
  for (const l of runs) {
    const ports = [...l.matchAll(/\s(?:-p|--publish)[ =]"?(\d[^\s"]*)/g)].map((m) => m[1]);
    if (/--name prism-caddy\b/.test(l)) assert.deepEqual(ports, ["443:443/tcp"]);
    else assert.deepEqual(ports, [], l);
  }
});

test("the Caddy image appears only pinned by version and index digest", () => {
  const refs = [...src.matchAll(/(?<![\w/-])caddy:[^\s"')]+/g)].map((m) => m[0]);
  assert.ok(refs.length >= 1);
  for (const r of refs) assert.match(r, /^caddy:2\.11\.7-alpine@sha256:[0-9a-f]{64}$/);
  const caddyRun = runs.find((l) => /--name prism-caddy\b/.test(l));
  assert.ok(caddyRun?.includes('"$CADDY_IMAGE"'));
});

test("check needs an explicit sha7 and never falls back to the current deployment", () => {
  const check = fnBody("cmd_check");
  assert.match(check.split("\n")[0], /^\s*sha_arg "\$\{1:-\}"$/);
  assert.doesNotMatch(check, /current/);
  assert.match(fnBody("sha_arg"), /\^\[0-9a-f\]\{7,40\}\$/);
});

test("no secret reaches argv through -e, and nothing prints the secrets directory", () => {
  assert.doesNotMatch(src, /(?:-e|--env)[ =]"?[A-Z_]*(?:SECRET|KEY|PASSWORD)[A-Z_]*=/);
  for (const l of lines) {
    if (/\$SECRETS|\/srv\/prism\/secrets/.test(l)) assert.doesNotMatch(l, /\b(cat|head|tail|less|more|xxd|od|base64|strings)\b/, l);
  }
});

test("the script never persists firewall rules", () => {
  assert.doesNotMatch(src, /netfilter-persistent|iptables-save|rules\.v4|ip6tables-save/);
});

test("production never sets the fixture runner, and the app trusts only Caddy's fixed address", () => {
  assert.doesNotMatch(src, /-e PRISM_LIVE_RUNNER/);
  assert.match(src, /^CADDY_IP=172\.30\.0\.2$/m);
  assert.ok(src.includes("-e PRISM_TRUSTED_PROXY_HEADER=x-forwarded-for -e PRISM_TRUSTED_PROXY_IPS=$CADDY_IP"));
  const caddyRun = runs.find((l) => /--name prism-caddy\b/.test(l));
  assert.ok(caddyRun.includes('--ip "$CADDY_IP"'));
  // Dynamic addresses never include Caddy's fixed one.
  assert.match(src, /--ip-range 172\.30\.0\.128\/25/);
});
