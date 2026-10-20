// Gold labeller spike (D-62, D-65): label 5 pilot projects under each option,
// write results under ~/.prism-data/spikes/gold-labeller/ (never pipeline_gold_*).
//
//   node scripts/spikes/gold-labeller.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir, getDb } from "../../src/app/server/db.ts";
import { withStageCache } from "../../src/pipeline/cache/stage-cache.ts";
import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import { applyQuoteOrUnknownFilter } from "../../src/pipeline/coding/filter.ts";
import {
  buildChatBody,
  createClient,
  isQuotaResponse,
  PINNED_BASE_URL,
  QuotaStop,
} from "../../src/pipeline/coding/nebius-client.ts";
import { codeProjectWithRetry } from "../../src/pipeline/coding/retry.ts";
import { projectSpans } from "../../src/pipeline/confirm/confirm.ts";
import { buildCodingMessages, chunkSpans, CODING_MAX_TOKENS, mergeChunkCodings } from "../../src/pipeline/run.ts";
import { readKey } from "../../src/pipeline/run.ts";
import { ollamaClient, OLLAMA_BASE_URL } from "../../src/pipeline/validate/providers.ts";
import { screenCandidate } from "../../src/pipeline/select/screen-model.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPIKE_ROOT = path.join(os.homedir(), ".prism-data", "spikes", "gold-labeller");

async function topPilotProjects(db, n = 5) {
  const rows = await db
    .selectFrom("pipeline_check_states")
    .select(["project_n"])
    .where("project_n", ">=", 1)
    .where("project_n", "<=", 20)
    .where("filtered_state", "in", ["pass", "claimed"])
    .execute();
  const counts = new Map();
  for (const r of rows) counts.set(r.project_n, (counts.get(r.project_n) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([projectN, positives]) => ({ projectN, positives }));
}

async function listTokenFactoryModels(key) {
  const res = await fetch(`${PINNED_BASE_URL}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) return { status: res.status, ids: [] };
  const j = await res.json();
  return { status: res.status, ids: (j.data ?? []).map((m) => m.id) };
}

async function listOllamaTags() {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!res.ok) return [];
  const j = await res.json();
  return (j.models ?? []).map((m) => m.name);
}

function makeCallOnce(codebook, spansById, role, client, cacheDir, hnId) {
  return async (_c, _cfg, jsonSchema, checkIds, spanIds) => {
    const spans = spanIds.map((id) => ({ id, text: spansById.get(id) ?? "" }));
    const body = buildChatBody({
      model: role.model,
      messages: buildCodingMessages(checkIds, codebook, jsonSchema, spans),
      mode: "json_schema",
      schema: { name: "gate_checks", schema: jsonSchema, strict: true },
      thinking: false,
      ...(typeof role.reasoning === "string" ? { reasoningEffort: role.reasoning } : {}),
      maxTokens: CODING_MAX_TOKENS,
    });
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const t0 = Date.now();
    const { value } = await withStageCache(
      cacheDir,
      hnId,
      "gold-spike",
      { provider: role.provider, model: role.model, reasoning: role.reasoning, requestHash },
      async () => {
        const res = await client.request("/chat/completions", { method: "POST", body });
        if (isQuotaResponse(res)) throw new QuotaStop(res.status, `quota ${res.status}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const content = res.json?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("missing content");
        return content;
      },
    );
    void t0;
    return value;
  };
}

async function labelSpike({ dataDir, cacheDir, projectN, hnId, codebook, contract, role, client }) {
  const spans = projectSpans(dataDir, projectN);
  const spansById = new Map(spans.map((s) => [s.id, s.text]));
  const chunks = chunkSpans(spans);
  const callOnce = makeCallOnce(codebook, spansById, role, client, cacheDir, hnId);
  const perChunk = [];
  const meta = { chunks: chunks.length, schema_invalid_retries: 0, finish_reasons: [], latencies_ms: [], usage: [] };
  for (const chunk of chunks) {
    let attempts = 0;
    const wrapped = async (...args) => {
      attempts += 1;
      const t0 = Date.now();
      try {
        const text = await callOnce(...args);
        meta.latencies_ms.push(Date.now() - t0);
        return text;
      } catch (e) {
        meta.latencies_ms.push(Date.now() - t0);
        throw e;
      }
    };
    const result = await codeProjectWithRetry({
      client,
      cfg: {},
      contract,
      spanIds: chunk.map((s) => s.id),
      callOnce: wrapped,
    });
    if (!result.valid || result.allUnknown) {
      meta.schema_invalid_retries += attempts;
      return { ok: false, reason: "retry-exhausted", meta, spans: spans.map((s) => s.id), labels: [] };
    }
    meta.schema_invalid_retries += Math.max(0, attempts - 1);
    perChunk.push(result.data.checks);
  }
  const merged = mergeChunkCodings(contract.checkIds, perChunk);
  const filtered = applyQuoteOrUnknownFilter(merged, spans.map((s) => s.id));
  return {
    ok: true,
    meta,
    spans: spans.map((s) => ({ id: s.id, text: s.text })),
    labels: filtered.map((c) => ({
      checkId: c.checkId,
      state: c.proposedState,
      spanIds: c.spanIds,
    })),
  };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const dataDir = resolveDataDir();
  const db = getDb();
  const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
  const contract = buildContract(loadGateFile(resolveGatesPath(undefined, repoRoot)).checkIds);
  const cacheDir = path.join(dataDir, "pipeline", "cache");
  const pilots = await topPilotProjects(db, 5);
  if (pilots.length < 5) throw new Error(`need 5 pilot projects with positives, got ${pilots.length}`);

  const nebius = readKey("NEBIUS_API_KEY", "nebius.key");
  if (!nebius) throw new Error("nebius.key missing");
  const tfModels = await listTokenFactoryModels(nebius);
  const ollamaTags = await listOllamaTags();
  const flashTf = tfModels.ids.find((id) => /GLM-5\.3-Flash/i.test(id) || /glm-5\.3-flash/i.test(id));
  const flashOllama = ollamaTags.find((n) => /glm-5\.3-flash/i.test(n));
  const openrouterKeyPath = path.join(os.homedir(), "Library/Application Support/prism/openrouter.key");
  const hasOpenrouter = fs.existsSync(openrouterKeyPath);

  /** @type {{ id: string, role: { provider: string, model: string, reasoning: any }, client: any }[]} */
  const options = [
    {
      id: "a-tf-glm-low",
      role: { provider: "token-factory", model: "zai-org/GLM-5.3", reasoning: "low" },
      client: createClient({ baseUrl: PINNED_BASE_URL, apiKey: nebius, concurrency: 2 }),
    },
    {
      id: "b-ollama-glm-low",
      role: { provider: "ollama", model: "glm-5.3:cloud", reasoning: "low" },
      client: ollamaClient({}),
    },
    {
      id: "c-ollama-glm-medium",
      role: { provider: "ollama", model: "glm-5.3:cloud", reasoning: "medium" },
      client: ollamaClient({}),
    },
  ];
  if (flashTf) {
    options.push({
      id: "d-tf-glm-flash",
      role: { provider: "token-factory", model: flashTf, reasoning: "low" },
      client: createClient({ baseUrl: PINNED_BASE_URL, apiKey: nebius, concurrency: 2 }),
    });
  } else if (flashOllama) {
    options.push({
      id: "d-ollama-glm-flash",
      role: { provider: "ollama", model: flashOllama, reasoning: "low" },
      client: ollamaClient({}),
    });
  } else {
    options.push({ id: "d-flash-unavailable", role: null, client: null, skip: "GLM-5.3-Flash not listed on Token Factory or the local Ollama daemon" });
  }
  if (hasOpenrouter) {
    options.push({
      id: "e-openrouter-gemma-free",
      role: { provider: "openrouter", model: "google/gemma-4-31b-it:free", reasoning: false },
      client: null,
      skip: "openrouter adapter not wired for this spike; key present but option skipped",
    });
  } else {
    options.push({ id: "e-openrouter-skipped", role: null, client: null, skip: "openrouter.key absent" });
  }

  fs.mkdirSync(SPIKE_ROOT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(SPIKE_ROOT, "_meta.json"),
    JSON.stringify(
      {
        pilots,
        tf_glm_ids: tfModels.ids.filter((id) => /glm/i.test(id)),
        ollama_glm_ids: ollamaTags.filter((n) => /glm/i.test(n)),
        flashTf: flashTf ?? null,
        flashOllama: flashOllama ?? null,
        hasOpenrouter,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const summary = { options: {} };

  for (const opt of options) {
    const dir = path.join(SPIKE_ROOT, opt.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (opt.skip || !opt.role) {
      summary.options[opt.id] = { skip: opt.skip };
      fs.writeFileSync(path.join(dir, "SKIP.json"), JSON.stringify({ skip: opt.skip }), { mode: 0o600 });
      console.log(`OPTION ${opt.id}: skip — ${opt.skip}`);
      continue;
    }
    const latencies = [];
    let quota = null;
    let labelled = 0;
    for (const { projectN } of pilots) {
      const man = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "manifests", `${projectN}.json`), "utf8"));
      const hnId = String(man.hnId ?? man.id ?? projectN);
      try {
        const result = await labelSpike({
          dataDir,
          cacheDir,
          projectN,
          hnId,
          codebook,
          contract,
          role: opt.role,
          client: opt.client,
        });
        latencies.push(...result.meta.latencies_ms);
        fs.writeFileSync(path.join(dir, `${projectN}.json`), JSON.stringify({ projectN, role: opt.role, result }, null, 2), {
          mode: 0o600,
        });
        if (result.ok) labelled += 1;
        console.log(`OPTION ${opt.id} project ${projectN}: ${result.ok ? "ok" : result.reason}`);
      } catch (err) {
        if (err instanceof QuotaStop || err?.name === "QuotaStop") {
          quota = { status: err.status, message: err.message };
          fs.writeFileSync(path.join(dir, "QUOTA.json"), JSON.stringify(quota), { mode: 0o600 });
          console.log(`OPTION ${opt.id}: QuotaStop — ${err.message}`);
          break;
        }
        fs.writeFileSync(
          path.join(dir, `${projectN}.error.json`),
          JSON.stringify({ error: String(err?.message ?? err) }),
          { mode: 0o600 },
        );
        console.log(`OPTION ${opt.id} project ${projectN}: error ${err?.message}`);
      }
    }
    summary.options[opt.id] = {
      role: opt.role,
      labelled,
      median_latency_ms: median(latencies),
      quota,
    };
  }

  // Auditor smoke: kimi-k3 via ollama on one pilot
  try {
    const client = ollamaClient({});
    const p = pilots[0].projectN;
    const man = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "manifests", `${p}.json`), "utf8"));
    const decision = await screenCandidate(
      client,
      1,
      { title: man.title ?? "pilot", url: man.url ?? "https://example.com" },
      { model: "kimi-k3:cloud", thinking: true, attempts: 2 },
    );
    summary.auditor_smoke = { projectN: p, decision };
    console.log(`AUDITOR smoke: ${JSON.stringify(decision)}`);
  } catch (err) {
    summary.auditor_smoke = { error: String(err?.message ?? err) };
    console.log(`AUDITOR smoke error: ${err?.message}`);
  }

  fs.writeFileSync(path.join(SPIKE_ROOT, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`SPIKE-DONE ${SPIKE_ROOT}`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
