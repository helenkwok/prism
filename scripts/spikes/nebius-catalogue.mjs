#!/usr/bin/env node
// Nebius Token Factory model catalogue, both hosts (FND-05, D-21).
//
//   node --env-file=<private env file> scripts/spikes/nebius-catalogue.mjs
//
// Calls GET /models?verbose=true on the docs host (NEBIUS_BASE_URL) and the
// regional host the cookbook recommends for Ultra, keeps entries whose id
// starts nvidia/, saves the raw response under PRISM_DATA_DIR, and merges the
// catalogue plus the observed supported_features vocabulary into
// spikes/nebius.md (numbers, ids and statuses only; the key never appears in
// any output line).

import fs from "node:fs";
import path from "node:path";

import { extractJsonBlock, replaceJsonBlock } from "../lib/spike-record.mjs";
import { createClient } from "./lib/nebius.mjs";
import { spikeDirs } from "./lib/paths.mjs";

const REGIONAL_HOST = "https://api.tokenfactory.us-central1.nebius.com/v1";
const RECORD_PATH = "spikes/nebius.md";
const KEY = process.env.NEBIUS_API_KEY ?? "";

function log(obj) {
  console.log(JSON.stringify(obj));
}

function hostsToQuery() {
  const docsHost = process.env.NEBIUS_BASE_URL;
  if (!docsHost) {
    console.error("NEBIUS_BASE_URL is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
  if (!KEY) {
    console.error("NEBIUS_API_KEY is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
  return [
    { label: "docs", baseUrl: docsHost },
    { label: "regional", baseUrl: REGIONAL_HOST },
  ];
}

async function fetchCatalogue(baseUrl) {
  const client = createClient({ baseUrl, apiKey: KEY });
  const res = await client.request("/models?verbose=true");
  if (res.status !== 200 || !res.json) {
    throw new Error(`catalogue call to ${baseUrl} failed: status ${res.status}`);
  }
  return Array.isArray(res.json.data) ? res.json.data : [];
}

function toRecordEntry(m, hostLabel) {
  return {
    id: m.id,
    host: hostLabel,
    context_length: typeof m.context_length === "number" ? m.context_length : 0,
    quantization: typeof m.quantization === "string" ? m.quantization : null,
    pricing: m.pricing && typeof m.pricing === "object" ? m.pricing : {},
    supported_features: Array.isArray(m.supported_features) ? m.supported_features : [],
    regions: Array.isArray(m.regions) ? m.regions.map((r) => r?.name ?? r?.country_code ?? "unknown") : [],
    status: typeof m.status === "string" && m.status ? m.status : "unknown",
  };
}

function newRecordMd(today) {
  const obj = { record: "nebius", status: "pending", updated: today };
  return (
    "# Nebius spike (FND-05)\n\n" +
    "Numbers only. Keys, raw model output and batch files stay in the private store (D-21).\n\n" +
    "Status: pending. The 12-config matrix, escape probe, pinned model and the zdr fallback state are completed by plan 01-10; this plan records the catalogue, one real structured-output call, the ZDR/credits console facts and the Batch API submission.\n\n" +
    "```json\n" +
    JSON.stringify(obj, null, 2) +
    "\n```\n"
  );
}

async function main() {
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written
  const hosts = hostsToQuery();
  const today = new Date().toISOString().slice(0, 10);

  const entries = [];
  const featureVocab = new Set();
  const rawByHost = {};

  for (const h of hosts) {
    const all = await fetchCatalogue(h.baseUrl);
    const nvidiaModels = all.filter((m) => typeof m.id === "string" && m.id.startsWith("nvidia/"));
    rawByHost[h.label] = all;
    for (const m of nvidiaModels) {
      const entry = toRecordEntry(m, h.label);
      entries.push(entry);
      for (const f of entry.supported_features) featureVocab.add(f);
    }
    log({ host: h.label, total_models: all.length, nvidia_models: nvidiaModels.length });
  }

  fs.writeFileSync(
    path.join(dirs.spikes, "nebius-catalogue-raw.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), hosts: hosts.map((h) => h.label), raw: rawByHost }, null, 2),
    { mode: 0o600 },
  );

  if (entries.length === 0) {
    console.error("catalogue: no nvidia/* model found on either host");
    process.exit(1);
  }

  const target = path.join(dirs.root, RECORD_PATH);
  let md = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : newRecordMd(today);
  const obj = extractJsonBlock(md);
  obj.record = "nebius";
  if (obj.status !== "final") obj.status = "pending";
  obj.updated = today;
  obj.catalogue = entries;
  obj.catalogue_feature_vocabulary = [...featureVocab].sort();
  obj.catalogue_hosts_checked = hosts.map((h) => h.label);
  md = replaceJsonBlock(md, obj);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, md);

  log({
    record_written: RECORD_PATH,
    catalogue_entries: entries.length,
    feature_vocabulary: [...featureVocab].sort(),
    hosts_checked: hosts.map((h) => h.label),
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
