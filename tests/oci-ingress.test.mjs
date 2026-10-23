// scripts/oci-ingress.sh against a fake `oci` executable first on PATH.
// The fake keeps its security list in a JSON file and logs every call, so the
// tests can check what the script updated, what it restored, and that no
// `ocid1.` identifier reaches stdout or stderr. No network, no real OCI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "oci-ingress.sh");

// Kebab-case, as the real CLI prints rules.
const RULE_22 = {
  description: null, "icmp-options": null, "is-stateless": false, protocol: "6",
  source: "0.0.0.0/0", "source-type": "CIDR_BLOCK",
  "tcp-options": { "destination-port-range": { max: 22, min: 22 }, "source-port-range": null },
  "udp-options": null,
};
const RULE_ICMP = {
  description: null, "icmp-options": { code: 4, type: 3 }, "is-stateless": false, protocol: "1",
  source: "0.0.0.0/0", "source-type": "CIDR_BLOCK", "tcp-options": null, "udp-options": null,
};
const RULE_ICMP_VCN = {
  description: null, "icmp-options": { code: null, type: 3 }, "is-stateless": false, protocol: "1",
  source: "10.0.0.0/16", "source-type": "CIDR_BLOCK", "tcp-options": null, "udp-options": null,
};
const RULE_443 = {
  description: "existing", "icmp-options": null, "is-stateless": false, protocol: "6",
  source: "0.0.0.0/0", "source-type": "CIDR_BLOCK",
  "tcp-options": { "destination-port-range": { max: 443, min: 443 }, "source-port-range": null },
  "udp-options": null,
};

const FAKE_OCI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const st = process.env.FAKE_OCI_STATE;
const s = JSON.parse(fs.readFileSync(st, "utf8"));
const a = process.argv.slice(2);
s.calls.push(a.slice(0, 3).join(" "));
const out = (o) => process.stdout.write(JSON.stringify(o));
const kebab = (v) => Array.isArray(v) ? v.map(kebab) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), kebab(x)])) : v;
const cmd = a.slice(0, 3).join(" ");
if (cmd === "compute instance list") out({ data: [{ id: "ocid1.instance.oc1..fakeinst", "display-name": "prism-app", "lifecycle-state": "RUNNING" }] });
else if (cmd === "compute instance list-vnics") out({ data: [{ id: "ocid1.vnic.oc1..fakevnic", "subnet-id": "ocid1.subnet.oc1..fakesub" }] });
else if (cmd === "network subnet get") out({ data: { id: "ocid1.subnet.oc1..fakesub", "security-list-ids": ["ocid1.securitylist.oc1..fakesl"] } });
else if (cmd === "network security-list get") out({ data: { id: "ocid1.securitylist.oc1..fakesl", "ingress-security-rules": s.rules } });
else if (cmd === "network security-list update") {
  const i = a.indexOf("--ingress-security-rules");
  let rules = kebab(JSON.parse(fs.readFileSync(a[i + 1].replace(/^file:\/\//, ""), "utf8")));
  s.updates += 1;
  if (s.updates === 1 && s.mode === "drop-saved") rules = rules.filter((r) => r.protocol !== "1");
  if (s.updates === 1 && s.mode === "drop22") rules = rules.filter((r) => !(r["tcp-options"] && r["tcp-options"]["destination-port-range"] && r["tcp-options"]["destination-port-range"].min === 22));
  if (s.updates === 1 && s.mode === "grow2") rules = [...rules, rules[rules.length - 1]];
  s.rules = rules;
  out({ data: { id: "ocid1.securitylist.oc1..fakesl", "ingress-security-rules": rules } });
} else { process.stderr.write("fake oci: unknown " + cmd + "\n"); process.exit(3); }
fs.writeFileSync(st, JSON.stringify(s));
`;

function setup(rules, mode = "normal") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-ingress-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "oci"), FAKE_OCI, { mode: 0o755 });
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ rules, mode, calls: [], updates: 0 }));
  const config = path.join(dir, "config");
  fs.writeFileSync(config, "[DEFAULT]\nuser=ocid1.user.oc1..fakeuser\ntenancy=ocid1.tenancy.oc1..faketen\nregion=ap-sydney-1\n");
  const stateRoot = path.join(dir, "scratch");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_OCI_STATE: state,
    OCI_CLI_CONFIG_FILE: config,
    PRISM_OCI_STATE_ROOT: stateRoot,
  };
  const run = (mode) => spawnSync("bash", [script, mode], { env, encoding: "utf8" });
  const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
  return { dir, stateRoot, run, read };
}

function noOcid(r) {
  assert.doesNotMatch(r.stdout, /ocid1\./, "stdout leaked an ocid1. identifier");
  assert.doesNotMatch(r.stderr, /ocid1\./, "stderr leaked an ocid1. identifier");
}

const updateCalls = (s) => s.calls.filter((c) => c === "network security-list update").length;

test("apply saves before.json (600 in a 700 dir), adds one stateful TCP 443 rule and reports", () => {
  const t = setup([RULE_22, RULE_ICMP, RULE_ICMP_VCN]);
  const r = t.run("apply");
  noOcid(r);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OCI_INGRESS before=3 after=4 saved_rules_present=true port22=present port443=present$/m);
  const s = t.read();
  assert.equal(updateCalls(s), 1);
  assert.equal(s.rules.length, 4);
  const added = s.rules[3];
  assert.equal(added.protocol, "6");
  assert.equal(added.source, "0.0.0.0/0");
  assert.equal(added["is-stateless"], false);
  assert.deepEqual(added["tcp-options"]["destination-port-range"], { max: 443, min: 443 });
  const [dirName] = fs.readdirSync(t.stateRoot);
  assert.match(dirName, /^\d{4}-\d{2}-\d{2}-oci-ingress$/);
  const sd = path.join(t.stateRoot, dirName);
  assert.equal(fs.statSync(sd).mode & 0o777, 0o700);
  const before = path.join(sd, "before.json");
  assert.equal(fs.statSync(before).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(before, "utf8")).length, 3);
});

for (const [mode, why] of [
  ["drop-saved", "lost a saved rule"],
  ["drop22", "lost the TCP 22 rule"],
  ["grow2", "grew by two"],
]) {
  test(`apply restores before.json and exits non-zero when the update ${why}`, () => {
    const t = setup([RULE_22, RULE_ICMP, RULE_ICMP_VCN], mode);
    const r = t.run("apply");
    noOcid(r);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /^OCI_INGRESS restored$/m);
    const s = t.read();
    assert.equal(updateCalls(s), 2, "one update, then one restore");
    assert.equal(s.rules.length, 3);
    assert.deepEqual(s.rules, [RULE_22, RULE_ICMP, RULE_ICMP_VCN]);
  });
}

test("apply makes no update when a TCP 443 rule from 0.0.0.0/0 exists", () => {
  const t = setup([RULE_22, RULE_443]);
  const r = t.run("apply");
  noOcid(r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(updateCalls(t.read()), 0);
  assert.match(r.stdout, /^OCI_INGRESS already-open before=2 after=2 saved_rules_present=true port22=present port443=present$/m);
  const c = t.run("check");
  noOcid(c);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^OCI_INGRESS already-open before=2 after=2 saved_rules_present=true port22=present port443=present$/m);
  assert.equal(updateCalls(t.read()), 0);
});

test("check fails when the list changed after an already-open apply", () => {
  const t = setup([RULE_22, RULE_443]);
  assert.equal(t.run("apply").status, 0);
  const s = t.read();
  s.rules = [RULE_22, RULE_443, RULE_ICMP];
  fs.writeFileSync(path.join(t.dir, "state.json"), JSON.stringify(s));
  const c = t.run("check");
  assert.notEqual(c.status, 0);
  assert.match(c.stdout, /^OCI_INGRESS already-open before=2 after=3 /m);
});

test("check is read-only and prints the OCI_INGRESS fields from the saved state", () => {
  const t = setup([RULE_22, RULE_ICMP, RULE_ICMP_VCN]);
  assert.equal(t.run("apply").status, 0);
  const r = t.run("check");
  noOcid(r);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OCI_INGRESS before=3 after=4 saved_rules_present=true port22=present port443=present$/m);
  assert.equal(updateCalls(t.read()), 1, "check added no update call");
});

test("an unknown mode exits non-zero without calling oci", () => {
  const t = setup([RULE_22]);
  const r = t.run("open-everything");
  assert.notEqual(r.status, 0);
  assert.equal(t.read().calls.length, 0);
});
