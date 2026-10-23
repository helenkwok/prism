#!/usr/bin/env node
// Build the CPU probe Worker (plan 07-11a) into cf's Build Output Specification, so it deploys
// with `cf deploy --prebuilt` and needs neither Vite nor Wrangler. Run from the repo root:
//   node scripts/probes/worker-cpu/build.mjs
// 1. materializes the synthetic corpus into a temp DB and exports P01's identifiable view;
// 2. bundles worker.tsx with the project's Rsbuild (rsbuild.probe.config.ts);
// 3. writes scripts/probes/worker-cpu/.cloudflare/output/v0/{config.json, workers/default/...}.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const build = path.join(here, ".build");
const out = path.join(here, ".cloudflare", "output", "v0");

fs.rmSync(build, { recursive: true, force: true });
fs.rmSync(path.join(here, ".cloudflare"), { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-probe-"));
const dbFile = path.join(tmp, "prism.sqlite");
execFileSync(process.execPath, ["scripts/materialize-views.mjs", "--fixture", "tests/fixtures/report/synthetic-corpus.json", "--db", dbFile, "--js-gate"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const db = new Database(dbFile, { readonly: true });
const row = db.prepare("SELECT json FROM app_report_view WHERE project_ref = 'P01' AND view = 'identifiable'").get();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (!row) throw new Error("probe build: no synthetic P01 identifiable view");
if (JSON.parse(row.json).fixture !== true) throw new Error("probe build: P01 view is not marked synthetic");
fs.writeFileSync(path.join(build, "p01-view.json"), row.json);

execFileSync(path.join(root, "node_modules", ".bin", "rsbuild"), ["build", "-c", "scripts/probes/worker-cpu/rsbuild.probe.config.ts"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const bundleDir = path.join(build, "bundle");
const js = fs.readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
if (js.length !== 1 || js[0] !== "index.js") throw new Error(`probe build: expected one index.js, got ${js.join(",")}`);

const workerDir = path.join(out, "workers", "default");
fs.mkdirSync(path.join(workerDir, "bundle"), { recursive: true });
fs.copyFileSync(path.join(bundleDir, "index.js"), path.join(workerDir, "bundle", "index.js"));
const config = JSON.parse(fs.readFileSync(path.join(here, "worker.config.json"), "utf8"));
// A partial manifest names only the main module; cf resolves the rest from bundle/.
config.manifest = { type: "partial", mainModule: "index.js", modules: {} };
fs.writeFileSync(path.join(workerDir, "worker.config.json"), JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(out, "config.json"), JSON.stringify({ buildContext: { isPreview: false } }, null, 2));
console.log(`PROBE_BUILD ok bundle_bytes=${fs.statSync(path.join(workerDir, "bundle", "index.js")).size}`);
