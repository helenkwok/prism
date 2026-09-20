#!/usr/bin/env node
// Verifies the vendored claim gate against its pin (decision D-19, FND-02).
//
//   node scripts/verify-vendor.mjs                     offline: disk matches PIN.json
//   node scripts/verify-vendor.mjs --remote            offline, then every pinned file
//                                                      fetched at the pinned commit, plus a
//                                                      re-check that the tag still resolves to it
//   node scripts/verify-vendor.mjs --dir <path>        check another vendor directory
//   node scripts/verify-vendor.mjs --pin-from <checkout> --tag <name>
//                                                      (re)vendor the file set from a checkout at
//                                                      that tag and write PIN.json
//
// Exit 0 clean, 1 on any difference or mismatch, 2 on a usage or I/O error.
//
// Why two modes: an offline check proves only that the copy matches the manifest.
// Whoever changes a file can change the manifest with it and still pass. The remote
// mode compares the manifest against the upstream bytes at the pinned commit, and
// re-resolves the tag, because a tag can be moved.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_VENDOR_DIR = path.join(REPO_ROOT, "vendor", "ai-output-to-value");
export const UPSTREAM_URL = "https://github.com/AlreadyOpen/ai-output-to-value";

/**
 * The vendored set, at upstream's own relative paths. The gate resolves its schemas
 * from its parent folder, so the layout is part of the contract. Only the Python
 * evaluator is vendored for runtime use; the JS gate is not.
 */
export const VENDORED_PATHS = [
  "LICENSE",
  "requirements-claim-gate.txt",
  "schemas/v1/claim.schema.json",
  "schemas/v1/decision-gates.json",
  "scripts/claim_gate.py",
  "tests/fixtures/claim-gate-conformance.json",
];

const SHA_RE = /^[0-9a-f]{40}$/;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const toPosix = (p) => p.split(path.sep).join("/");

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(toPosix(path.relative(base, full)));
  }
  return out;
}

function safeRelative(rel) {
  return (
    typeof rel === "string" &&
    rel !== "" &&
    !path.isAbsolute(rel) &&
    !rel.includes("\\") &&
    !rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "")
  );
}

export function readPin(vendorDir) {
  const file = path.join(vendorDir, "PIN.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  let pin;
  try {
    pin = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (!pin || typeof pin !== "object" || !pin.files || typeof pin.files !== "object") {
    throw new Error(`${file} has no files map`);
  }
  return pin;
}

/** Offline check. Returns an array of error strings; empty means clean. */
export function verifyLocal(vendorDir = DEFAULT_VENDOR_DIR) {
  const pin = readPin(vendorDir);
  const errors = [];

  if (typeof pin.commit !== "string" || !SHA_RE.test(pin.commit)) errors.push("PIN.json commit is not a 40-character SHA");
  if (typeof pin.tag !== "string" || pin.tag === "") errors.push("PIN.json tag is empty");

  const listed = Object.keys(pin.files);
  for (const rel of VENDORED_PATHS) {
    if (!listed.includes(rel)) errors.push(`required file not pinned: ${rel}`);
  }

  const onDisk = new Set(walk(vendorDir).filter((p) => p !== "PIN.json"));
  for (const rel of listed) {
    const want = pin.files[rel];
    if (!safeRelative(rel)) {
      errors.push(`unsafe manifest path: ${rel}`);
      continue;
    }
    const full = path.join(vendorDir, rel);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      errors.push(`missing: ${rel}`);
      continue;
    }
    onDisk.delete(rel);
    if (!st.isFile()) {
      errors.push(`not a regular file: ${rel}`);
      continue;
    }
    const buf = fs.readFileSync(full);
    if (!want || sha256(buf) !== want.sha256) errors.push(`hash mismatch: ${rel}`);
    else if (want.bytes !== buf.length) errors.push(`size mismatch: ${rel}`);
  }
  for (const extra of [...onDisk].sort()) errors.push(`unlisted file: ${extra}`);
  return errors;
}

function parseUpstream(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  if (!m) throw new Error(`PIN.json upstream is not a GitHub repository URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

/**
 * Resolve a tag to the commit it points at, asking the remote. For an annotated tag the
 * peeled line (refs/tags/<tag>^{}) carries the commit; the plain line carries the tag object.
 */
export function resolveTagViaGit(upstream, tag) {
  const res = spawnSync("git", ["ls-remote", upstream, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.status !== 0) throw new Error(`git ls-remote failed: ${(res.stderr || "").trim() || res.error?.message}`);
  const lines = res.stdout.split("\n").filter(Boolean).map((l) => l.split(/\s+/));
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const plain = lines.find(([, ref]) => ref === `refs/tags/${tag}`);
  const hit = peeled ?? plain;
  if (!hit) throw new Error(`tag ${tag} not found on ${upstream}`);
  return hit[0];
}

/**
 * Remote check. Both dependencies are injectable so tests need no network.
 * Returns an array of error strings; empty means clean.
 */
export async function verifyRemote(pin, { fetchImpl = globalThis.fetch, resolveTag = resolveTagViaGit } = {}) {
  const errors = [];
  const { owner, repo } = parseUpstream(pin.upstream);

  for (const [rel, want] of Object.entries(pin.files)) {
    if (!safeRelative(rel)) {
      errors.push(`unsafe manifest path: ${rel}`);
      continue;
    }
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${pin.commit}/${rel}`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        errors.push(`remote fetch failed (${res.status}): ${rel}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== want.sha256) errors.push(`remote hash mismatch: ${rel}`);
    } catch (err) {
      errors.push(`remote fetch error: ${rel}: ${err.message}`);
    }
  }

  try {
    const commit = await resolveTag(pin.upstream, pin.tag);
    if (commit !== pin.commit) errors.push(`tag moved: ${pin.tag} now resolves to ${commit}, pinned ${pin.commit}`);
  } catch (err) {
    errors.push(`tag check failed: ${err.message}`);
  }
  return errors;
}

function gitShow(checkout, commit, rel) {
  const res = spawnSync("git", ["-C", checkout, "show", `${commit}:${rel}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git show ${commit}:${rel} failed: ${res.stderr.toString("utf8").trim()}`);
  return res.stdout;
}

/**
 * Vendor the file set from a checkout at a tag, reading exact bytes from git objects
 * (never the working tree, so no line-ending or smudge filter can alter them).
 */
export function pinFrom(checkout, tag, vendorDir = DEFAULT_VENDOR_DIR, now = new Date()) {
  const rev = spawnSync("git", ["-C", checkout, "rev-parse", `${tag}^{commit}`], { encoding: "utf8" });
  if (rev.status !== 0) throw new Error(`cannot resolve tag ${tag} in ${checkout}: ${rev.stderr.trim()}`);
  const commit = rev.stdout.trim();
  if (!SHA_RE.test(commit)) throw new Error(`resolved commit is not a 40-character SHA: ${commit}`);

  const files = {};
  const bytesByPath = {};
  for (const rel of VENDORED_PATHS) {
    const buf = gitShow(checkout, commit, rel);
    bytesByPath[rel] = buf;
    files[rel] = { sha256: sha256(buf), bytes: buf.length };
  }
  const gates = JSON.parse(bytesByPath["schemas/v1/decision-gates.json"].toString("utf8"));

  fs.mkdirSync(vendorDir, { recursive: true });
  fs.rmSync(path.join(vendorDir, "PIN.json"), { force: true });
  for (const rel of VENDORED_PATHS) {
    const full = path.join(vendorDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytesByPath[rel]);
  }
  const pin = {
    upstream: UPSTREAM_URL,
    tag,
    commit,
    gateVersion: gates.version,
    pinnedAt: now.toISOString(),
    files,
  };
  fs.writeFileSync(path.join(vendorDir, "PIN.json"), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

function parseArgs(argv) {
  const opts = { remote: false, dir: DEFAULT_VENDOR_DIR, pinFrom: null, tag: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--remote") opts.remote = true;
    else if (a === "--dir") opts.dir = path.resolve(argv[++i] ?? "");
    else if (a === "--pin-from") opts.pinFrom = path.resolve(argv[++i] ?? "");
    else if (a === "--tag") opts.tag = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (Boolean(opts.pinFrom) !== Boolean(opts.tag)) throw new Error("--pin-from and --tag go together");
  if (opts.pinFrom && opts.remote) throw new Error("--pin-from cannot be combined with --remote");
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`usage error: ${err.message}`);
    return 2;
  }

  try {
    if (opts.pinFrom) {
      const pin = pinFrom(opts.pinFrom, opts.tag, opts.dir);
      console.log(`pinned ${Object.keys(pin.files).length} files at ${pin.tag} (${pin.commit}), gate version ${pin.gateVersion}`);
      return 0;
    }

    const errors = verifyLocal(opts.dir);
    if (opts.remote) errors.push(...(await verifyRemote(readPin(opts.dir))));
    if (errors.length > 0) {
      for (const e of errors) console.error(e);
      console.error(`vendor check FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
      return 1;
    }
    console.log(`vendor check OK${opts.remote ? " (offline and remote)" : " (offline)"}`);
    return 0;
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
