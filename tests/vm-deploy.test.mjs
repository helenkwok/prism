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

test("plan 06-08: Caddy mounts the findings site read-only and serves it statically at prism's root; TLS-ALPN-01 only", () => {
  const caddyRun = runs.find((l) => /--name prism-caddy\b/.test(l));
  assert.ok(caddyRun.includes('-v "$FINDINGS:/srv/findings:ro"'), caddyRun);
  assert.match(fnBody("cmd_caddy"), /^\s*sha_arg "\$\{1:-\}"$/m);
  const caddyfile = fs.readFileSync("deploy/Caddyfile", "utf8");
  const prism = /prism\.helenkwok\.dev \{\n([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
  const findings = /\thandle @findings \{\n([\s\S]*?)\n\t\}/.exec(prism)?.[1] ?? "";
  assert.match(prism, /disable_http_challenge/);
  assert.match(prism, /@app path \/app \/app\/\*/);
  assert.match(findings, /root \* \/srv\/findings\/current\/client/);
  assert.match(findings, /file_server/);
  assert.doesNotMatch(findings, /reverse_proxy/);
  // The old findings host only redirects to the same path on prism.helenkwok.dev.
  const old = /findings\.helenkwok\.dev \{\n([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
  assert.match(old, /disable_http_challenge/);
  assert.match(old, /redir https:\/\/prism\.helenkwok\.dev\{uri\} permanent/);
  assert.doesNotMatch(old, /reverse_proxy|file_server/);
  assert.match(caddyfile, /auto_https disable_redirects/);
});
