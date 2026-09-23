#!/usr/bin/env node
// One real Nebius structured-output chat call (FND-05, D-21).
//
//   node --env-file=<private env file> scripts/spikes/nebius-hello.mjs
//
// Calls chat/completions on the cheapest candidate (Lightning, from the
// catalogue already written to spikes/nebius.md) with response_format
// json_schema, validates the reply with zod, and prints status, latency,
// finish_reason, usage and the rate-limit headers. Stores the raw reply
// under PRISM_DATA_DIR and merges the observed rate-limit headers into
// spikes/nebius.md. Never prints the key.

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { extractJsonBlock, replaceJsonBlock } from "../lib/spike-record.mjs";
import { buildChatBody, createClient } from "./lib/nebius.mjs";
import { spikeDirs } from "./lib/paths.mjs";

const RECORD_PATH = "spikes/nebius.md";
const KEY = process.env.NEBIUS_API_KEY ?? "";
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "";

const HELLO_SCHEMA = {
  name: "hello_probe",
  schema: {
    type: "object",
    properties: {
      greeting: { type: "string" },
      ok: { type: "boolean" },
    },
    required: ["greeting", "ok"],
    additionalProperties: false,
  },
  strict: true,
};

const HelloReply = z.object({ greeting: z.string(), ok: z.boolean() });

function log(obj) {
  console.log(JSON.stringify(obj));
}

function pickLightningModel(catalogue) {
  const entry = (catalogue ?? []).find((e) => typeof e?.id === "string" && /lightning/i.test(e.id));
  if (!entry) throw new Error("no Lightning model found in spikes/nebius.md catalogue; run nebius-catalogue.mjs first");
  return entry.id;
}

async function main() {
  if (!KEY) {
    console.error("NEBIUS_API_KEY is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
  if (!BASE_URL) {
    console.error("NEBIUS_BASE_URL is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }

  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written
  const target = path.join(dirs.root, RECORD_PATH);
  if (!fs.existsSync(target)) {
    console.error(`${RECORD_PATH} does not exist; run nebius-catalogue.mjs first`);
    process.exit(2);
  }
  const before = extractJsonBlock(fs.readFileSync(target, "utf8"));
  const model = pickLightningModel(before.catalogue);

  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY });
  const body = buildChatBody({
    model,
    messages: [
      { role: "system", content: "Reply only with JSON matching this schema: " + JSON.stringify(HELLO_SCHEMA.schema) },
      { role: "user", content: "Say hello and set ok to true." },
    ],
    mode: "json_schema",
    schema: HELLO_SCHEMA,
    thinking: false, // measured: thinking on exhausts max_tokens before emitting JSON on this model
    maxTokens: 300,
  });

  const res = await client.request("/chat/completions", { method: "POST", body });

  fs.writeFileSync(
    path.join(dirs.spikes, "nebius-hello-raw.json"),
    JSON.stringify({ fetched_at: new Date().toISOString(), model, base_url: BASE_URL, status: res.status, response: res.json }, null, 2),
    { mode: 0o600 },
  );

  if (res.status !== 200 || !res.json) {
    console.error(`hello call failed: status ${res.status}`);
    process.exit(1);
  }

  const choice = res.json.choices?.[0];
  const content = choice?.message?.content ?? "";
  let parsed = null;
  let zodValid = false;
  try {
    parsed = JSON.parse(content);
    HelloReply.parse(parsed);
    zodValid = true;
  } catch {
    zodValid = false;
  }

  const summary = {
    model,
    status: res.status,
    latency_ms: res.latencyMs,
    finish_reason: choice?.finish_reason ?? null,
    zod_valid: zodValid,
    usage: res.json.usage ?? null,
    rate_limit_headers: res.headers,
  };
  log(summary);

  if (!zodValid) {
    console.error("hello call: reply did not validate against the zod schema");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const md = fs.readFileSync(target, "utf8");
  const obj = extractJsonBlock(md);
  obj.updated = today;
  obj.rate_limits = {
    observed_on: today,
    model,
    headers: res.headers,
  };
  fs.writeFileSync(target, replaceJsonBlock(md, obj));

  log({ record_written: RECORD_PATH, rate_limits: obj.rate_limits });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
