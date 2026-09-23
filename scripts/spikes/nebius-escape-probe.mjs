#!/usr/bin/env node
// String-escape probe (FND-05, D-21, plan 01-10 Task 2).
//
//   node --env-file=<private env file> scripts/spikes/nebius-escape-probe.mjs
//
// For each of the three candidate models x each output mode (json_schema,
// json_object), asks the model to echo one exact character sequence through
// a one-field free-text schema, and reports whether it survived the round
// trip. The output contract used in the matrix carries only enums and span
// ids, so this defect (a single third-party report, 2026-09-16, of Token
// Factory dropping string escapes) cannot corrupt evidence there; this probe
// only measures whether the defect exists. Merges `escape_probe` into
// spikes/nebius.md (one entry per model x mode).

import fs from "node:fs";
import path from "node:path";

import { extractJsonBlock, replaceJsonBlock } from "../lib/spike-record.mjs";
import { pickCandidateModels } from "./lib/candidates.mjs";
import { buildChatBody, createClient } from "./lib/nebius.mjs";
import { spikeDirs } from "./lib/paths.mjs";

const RECORD_PATH = "spikes/nebius.md";
const KEY = process.env.NEBIUS_API_KEY ?? "";
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "";

// The exact target sequence, built by concatenation (not a JS-escaped
// literal) so there is no risk of miscounting backslashes: a, \, n, b,
// space, ", q, ", space, \, \  (11 characters; two literal backslashes at
// the end, per the research doc's "a\nb "q" \\" written character by
// character, not as a JS escape to be evaluated).
const TARGET = ["a", "\\", "n", "b", " ", '"', "q", '"', " ", "\\", "\\"].join("");

const ESCAPE_SCHEMA = {
  name: "escape_probe",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  strict: true,
};

function log(obj) {
  console.log(JSON.stringify(obj));
}

function recordTarget(dirs) {
  return path.join(dirs.root, RECORD_PATH);
}

function loadCatalogue(dirs) {
  const target = recordTarget(dirs);
  if (!fs.existsSync(target)) throw new Error(`${RECORD_PATH} does not exist; run nebius-catalogue.mjs first`);
  const obj = extractJsonBlock(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(obj.catalogue) || obj.catalogue.length === 0) {
    throw new Error(`${RECORD_PATH} has no catalogue; run nebius-catalogue.mjs first`);
  }
  return obj.catalogue;
}

function promptFor(mode) {
  const instruction =
    "Reply with JSON only, one field named value, whose value is EXACTLY this 11-character sequence and nothing " +
    "else (no extra quoting, no explanation): the letter a, then a backslash, then the letter n, then the letter " +
    "b, then a space, then a double quote, then the letter q, then a double quote, then a space, then two " +
    "backslashes.";
  const schemaNote = mode === "json_schema" ? "" : ' Respond as a JSON object: {"value": "..."}.';
  return [
    { role: "system", content: instruction + schemaNote },
    { role: "user", content: "Echo the sequence now." },
  ];
}

async function probeOne(client, dirs, candidate, mode) {
  const body = buildChatBody({
    model: candidate.id,
    messages: promptFor(mode),
    mode,
    schema: mode === "json_schema" ? ESCAPE_SCHEMA : undefined,
    thinking: false,
    maxTokens: 200,
  });
  const res = await client.request("/chat/completions", { method: "POST", body });
  const choice = res.json?.choices?.[0];
  const content = choice?.message?.content ?? "";
  let parsedValue = null;
  let jsonParses = false;
  try {
    const parsed = JSON.parse(content);
    jsonParses = true;
    parsedValue = typeof parsed?.value === "string" ? parsed.value : null;
  } catch {
    jsonParses = false;
  }
  const survived = jsonParses && parsedValue === TARGET;

  fs.writeFileSync(
    path.join(dirs.spikes, "nebius-runs", `escape-${candidate.label}-${mode}.json`),
    JSON.stringify({ model: candidate.id, output_mode: mode, status: res.status, response: res.json, content }, null, 2),
    { mode: 0o600 },
  );

  return {
    model: candidate.id,
    output_mode: mode,
    survived,
    json_parses: jsonParses,
    finish_reason: choice?.finish_reason ?? null,
    checked_on: new Date().toISOString().slice(0, 10),
  };
}

function mergeEscapeProbe(existing, entries) {
  const out = Array.isArray(existing) ? [...existing] : [];
  for (const entry of entries) {
    const key = (e) => `${e.model}|${e.output_mode}`;
    const idx = out.findIndex((e) => key(e) === key(entry));
    if (idx >= 0) out[idx] = entry;
    else out.push(entry);
  }
  return out;
}

async function main() {
  if (!KEY || !BASE_URL) {
    console.error("NEBIUS_API_KEY and NEBIUS_BASE_URL must be set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written
  fs.mkdirSync(path.join(dirs.spikes, "nebius-runs"), { recursive: true, mode: 0o700 });

  const catalogue = loadCatalogue(dirs);
  const candidates = pickCandidateModels(catalogue);
  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY, concurrency: 4 });

  const entries = [];
  for (const candidate of candidates) {
    for (const mode of ["json_schema", "json_object"]) {
      const entry = await probeOne(client, dirs, candidate, mode);
      log(entry);
      entries.push(entry);
    }
  }

  const target = recordTarget(dirs);
  const md = fs.readFileSync(target, "utf8");
  const obj = extractJsonBlock(md);
  obj.updated = new Date().toISOString().slice(0, 10);
  obj.escape_probe = mergeEscapeProbe(obj.escape_probe, entries);
  fs.writeFileSync(target, replaceJsonBlock(md, obj));

  log({ record_written: RECORD_PATH, escape_probe_entries: obj.escape_probe.length });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
