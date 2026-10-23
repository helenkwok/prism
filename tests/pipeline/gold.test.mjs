// VAL-01 gold labeller: coding path, provider independence, insert-only rows.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../../src/pipeline/coding/contract.ts";
import { buildChatBody, isQuotaResponse, QuotaStop } from "../../src/pipeline/coding/nebius-client.ts";
import { projectSpans, spansDigest } from "../../src/pipeline/confirm/confirm.ts";
import { buildCodingMessages } from "../../src/pipeline/run.ts";
import {
  a7Section,
  a7Signed,
  A7_ITEMS,
  ensureGoldSchema,
  labelProject,
  runGoldCli,
} from "../../src/pipeline/validate/gold.ts";
import {
  assertIndependent,
  ollamaClient,
  ROLE_CONFIG,
  roleClient,
} from "../../src/pipeline/validate/providers.ts";
import { ARTCRAFT_HN_ID, GOLD_SEED } from "../../src/pipeline/select/draw-sample.ts";
import { sortPilotCandidates } from "../../src/pipeline/select/pilot-draw.ts";
import { QuotaStop as QuotaStopClass } from "../../src/pipeline/coding/nebius-client.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const codebook = loadCodebook(path.join(repoRoot, "codebook.md"));
const gateFile = loadGateFile(resolveGatesPath(undefined, repoRoot));
const contract = buildContract(gateFile.checkIds);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProjectTree(dataDir, projectN, texts) {
  const manDir = path.join(dataDir, "pipeline", "manifests");
  const snapDir = path.join(dataDir, "pipeline", "snapshots");
  fs.mkdirSync(manDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });
  const hashes = texts.map((t, i) => {
    const h = crypto.createHash("sha256").update(`snap-${projectN}-${i}`).digest("hex").slice(0, 16);
    fs.writeFileSync(path.join(snapDir, `${h}.json`), JSON.stringify({ redactedText: t, url: `https://ex.test/${i}` }));
    return h;
  });
  fs.writeFileSync(
    path.join(manDir, `${projectN}.json`),
    JSON.stringify({ snapshotHashesInCollectionOrder: hashes, hnId: String(1000 + projectN) }),
  );
}

function keyedUnknownReply() {
  const checks = Object.fromEntries(contract.checkIds.map((id) => [id, { proposedState: "unknown", spanIds: [] }]));
  return JSON.stringify({ checks });
}

describe("buildChatBody reasoning_effort (D-62)", () => {
  test("reasoningEffort low adds reasoning_effort; without it body matches baseline fields", () => {
    const messages = [{ role: "user", content: "hi" }];
    const schema = { name: "x", schema: { type: "object" } };
    const base = buildChatBody({ model: "m", messages, mode: "json_schema", schema });
    assert.equal("reasoning_effort" in base, false);
    const withEffort = buildChatBody({ model: "m", messages, mode: "json_schema", schema, reasoningEffort: "low" });
    assert.equal(withEffort.reasoning_effort, "low");
    const { reasoning_effort: _, ...rest } = withEffort;
    assert.deepEqual(rest, base);
  });
});

describe("QuotaStop / isQuotaResponse (D-64)", () => {
  test("402 and non-OK body naming quota are quota; OK 200 is never quota from body text", () => {
    assert.equal(isQuotaResponse({ status: 402 }), true);
    assert.equal(isQuotaResponse({ status: 500, text: "insufficient credit remaining" }), true);
    assert.equal(isQuotaResponse({ status: 200, ok: true, text: "insufficient credit remaining" }), false);
    assert.equal(isQuotaResponse({ status: 200, text: "ok" }), false);
    const e = new QuotaStop(402, "out");
    assert.ok(e instanceof Error);
    assert.equal(e.name, "QuotaStop");
  });
});

describe("assertIndependent / roleClient (A6, D-65)", () => {
  test("gold refuses coder/confirmer families; accepts glm; auditor refuses screener and gold families", () => {
    assert.throws(() => assertIndependent("gold", "deepseek-ai/DeepSeek-V4-Flash-0731"), /A6/);
    assert.throws(() => assertIndependent("gold", "nvidia/Nemotron-3-Ultra-550b-a55b"), /A6/);
    assertIndependent("gold", "glm-5.3:cloud");
    assert.throws(() => assertIndependent("auditor", "nvidia/Nemotron-3_5-Lightning"), /A6/);
    assert.throws(() => assertIndependent("auditor", "glm-5.3:cloud"), /A6/);
    assertIndependent("auditor", "kimi-k3:cloud");
  });

  test("roleClient refuses openrouter/free", () => {
    assert.throws(
      () => roleClient("gold", { roleSpec: { provider: "ollama", model: "openrouter/free", reasoning: "low" } }),
      /openrouter\/free/,
    );
  });
});

describe("ollamaClient adapter", () => {
  test("translates buildChatBody into /api/chat with format, think, options", async () => {
    let seen;
    const client = ollamaClient({
      baseUrl: "http://ollama.test",
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body) };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ message: { content: '{"ok":true}' }, done: true, done_reason: "stop" }),
        };
      },
    });
    const schema = { name: "gate_checks", schema: { type: "object" }, strict: true };
    const body = buildChatBody({
      model: "glm-5.3:cloud",
      messages: [{ role: "user", content: "x" }],
      mode: "json_schema",
      schema,
      thinking: false,
      reasoningEffort: "low",
      maxTokens: 100,
      temperature: 0,
    });
    const res = await client.request("/chat/completions", { method: "POST", body });
    assert.equal(seen.url, "http://ollama.test/api/chat");
    assert.equal(seen.body.stream, false);
    assert.deepEqual(seen.body.format, schema.schema);
    assert.equal(seen.body.think, "low");
    assert.equal(seen.body.options.num_predict, 100);
    assert.equal(seen.body.options.temperature, 0);
    assert.equal(res.json.choices[0].message.content, '{"ok":true}');
    assert.equal(res.json.choices[0].finish_reason, "stop");
  });
});

describe("labelProject", () => {
  test("writes 24 gold rows + labelled outcome; messages equal buildCodingMessages; attributed; idempotent", async () => {
    const dataDir = tempDir("prism-gold-data-");
    const cacheDir = tempDir("prism-gold-cache-");
    writeProjectTree(dataDir, 1, [
      "We ship a reproducible CLI for audits.\n\nStatus page is public.",
      "Second page with more product claims about the API.",
    ]);
    const spans = projectSpans(dataDir, 1);
    const digest = spansDigest(spans);
    assert.ok(spans.length >= 2);
    assert.equal(digest.length, 64);

    const captured = [];
    const client = {
      request: async (_p, { body }) => {
        captured.push(body);
        return { ok: true, status: 200, json: { choices: [{ message: { content: keyedUnknownReply() } }] } };
      },
    };
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureGoldSchema(db);
    // Proposal in check_states must not leak into gold prompt.
    await db.schema
      .createTable("pipeline_check_states")
      .ifNotExists()
      .addColumn("project_n", "integer")
      .addColumn("check_id", "text")
      .addColumn("filtered_state", "text")
      .addColumn("span_ids_json", "text")
      .execute();
    await db
      .insertInto("pipeline_check_states")
      .values({
        project_n: 1,
        check_id: contract.checkIds[0],
        filtered_state: "pass",
        span_ids_json: JSON.stringify([spans[0].id]),
      })
      .execute();

    const role = ROLE_CONFIG.gold;
    const outcome = await labelProject({
      db,
      dataDir,
      cacheDir,
      projectN: 1,
      hnId: "1001",
      codebook,
      codebookVersion: "v1.0",
      contract,
      role,
      client,
    });
    assert.equal(outcome.outcome, "labelled");
    const labels = await db.selectFrom("pipeline_gold_labels").selectAll().execute();
    assert.equal(labels.length, 24);
    for (const row of labels) {
      assert.ok(row.provider);
      assert.ok(row.model_id);
      assert.ok(row.reasoning != null && row.reasoning !== "");
    }

    const body0 = captured[0];
    assert.ok(body0.messages);
    const chunkSpansUsed = spans.filter((s) => body0.messages[1].content.includes(`${s.id}:`));
    assert.deepEqual(
      body0.messages,
      buildCodingMessages(contract.checkIds, codebook, contract.jsonSchema, chunkSpansUsed),
    );
    assert.ok(!JSON.stringify(body0.messages).includes("Proposed state"));

    const callsBefore = captured.length;
    const again = await labelProject({
      db,
      dataDir,
      cacheDir,
      projectN: 1,
      hnId: "1001",
      codebook,
      codebookVersion: "v1.0",
      contract,
      role,
      client,
    });
    assert.equal(again.outcome, "labelled");
    assert.equal((await db.selectFrom("pipeline_gold_labels").selectAll().execute()).length, 24);
    assert.equal(captured.length, callsBefore);

    await assert.rejects(
      () =>
        db
          .insertInto("pipeline_gold_labels")
          .values({
            project_n: 1,
            check_id: contract.checkIds[0],
            codebook_version: "v1.0",
            labeller_id: `agent:${role.provider}:${role.model}`,
            labeller_kind: "agent",
            provider: role.provider,
            model_id: role.model,
            reasoning: "low",
            raw_state: "pass",
            filtered_state: "pass",
            span_ids_json: "[]",
            input_digest: digest,
            labelled_at: "t",
          })
          .execute(),
      /UNIQUE|constraint|PRIMARY/i,
    );
  });

  test("retry-exhausted chunk writes zero gold rows and no-gold outcome", async () => {
    const dataDir = tempDir("prism-gold-nogold-");
    const cacheDir = tempDir("prism-gold-nogold-cache-");
    writeProjectTree(dataDir, 2, ["Only one short page about widgets."]);
    let calls = 0;
    const client = {
      request: async () => {
        calls += 1;
        return { ok: true, status: 200, json: { choices: [{ message: { content: '{"decision":"nope"}' } }] } };
      },
    };
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    const outcome = await labelProject({
      db,
      dataDir,
      cacheDir,
      projectN: 2,
      hnId: "1002",
      codebook,
      codebookVersion: "v1.0",
      contract,
      role: ROLE_CONFIG.gold,
      client,
    });
    assert.equal(outcome.outcome, "no-gold");
    assert.equal(outcome.reason, "retry-exhausted");
    // Invalid replies must never enter the successful-chunk cache.
    assert.equal(calls, 3);
    assert.equal((await db.selectFrom("pipeline_gold_labels").selectAll().execute()).length, 0);
  });
});

describe("a7Section / a7Signed helpers", () => {
  test("a7Signed false when missing, rejected, or digest mismatch; true when all approved", async () => {
    const dir = tempDir("prism-a7-");
    const protocolPath = path.join(dir, "PROTOCOL.md");
    const signoffPath = path.join(dir, "signoff.jsonl");
    const section =
      "## Addendum 2026-10-20 (A7)\n\n### A7.1\nText\n\n### A7.2\nMore\n";
    fs.writeFileSync(protocolPath, `# Protocol\n\n## 13. End\n\n${section}`);
    assert.ok(a7Section(fs.readFileSync(protocolPath, "utf8")).startsWith("## Addendum 2026-10-20 (A7)"));
    assert.equal(await a7Signed({ protocolPath, signoffPath }), false);
    const digest = crypto.createHash("sha256").update(a7Section(fs.readFileSync(protocolPath, "utf8"))).digest("hex");
    fs.writeFileSync(
      signoffPath,
      A7_ITEMS.map((item) => JSON.stringify({ item, decision: "approved", docDigest: digest })).join("\n") + "\n",
    );
    assert.equal(await a7Signed({ protocolPath, signoffPath }), true);
    fs.appendFileSync(signoffPath, JSON.stringify({ item: A7_ITEMS[0], decision: "rejected", docDigest: digest }) + "\n");
    assert.equal(await a7Signed({ protocolPath, signoffPath }), false);
    fs.writeFileSync(protocolPath, `# Protocol\n\n## 13. End\n\n## Addendum 2026-10-20 (A7)\n\nChanged\n`);
    assert.equal(await a7Signed({ protocolPath, signoffPath: path.join(dir, "signoff.jsonl") }), false);
  });
});

function writeSignedA7(dir) {
  const protocolPath = path.join(dir, "PROTOCOL.md");
  const signoffPath = path.join(dir, "signoff.jsonl");
  const section = "## Addendum 2026-10-20 (A7)\n\n### A7.1 Gold\nbody\n";
  fs.writeFileSync(protocolPath, `# P\n\n${section}`);
  const digest = crypto.createHash("sha256").update(a7Section(fs.readFileSync(protocolPath, "utf8"))).digest("hex");
  fs.writeFileSync(
    signoffPath,
    A7_ITEMS.map((item) => JSON.stringify({ item, decision: "approved", docDigest: digest })).join("\n") + "\n",
  );
  return { protocolPath, signoffPath };
}

describe("runGoldCli", () => {
  test("refuses with A7 not signed before any client call", async () => {
    const dataDir = tempDir("prism-gold-cli-a7-");
    const protocolPath = path.join(dataDir, "PROTOCOL.md");
    const signoffPath = path.join(dataDir, "signoff.jsonl");
    fs.writeFileSync(protocolPath, "## Addendum 2026-10-20 (A7)\n\nx\n");
    fs.writeFileSync(signoffPath, "");
    fs.mkdirSync(path.join(dataDir, "pipeline"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), JSON.stringify([{ n: 1, hn_id: "1" }]));
    let clientCalls = 0;
    const lines = [];
    const { exitCode, summary } = await runGoldCli({
      argv: ["--projects", path.join(dataDir, "pipeline", "sample-projects.json")],
      dataDir,
      protocolPath,
      signoffPath,
      repoRoot,
      client: {
        request: async () => {
          clientCalls += 1;
          return { ok: true, status: 200, json: { choices: [{ message: { content: keyedUnknownReply() } }] } };
        },
      },
      log: (l) => lines.push(l),
      err: () => {},
    });
    assert.equal(exitCode, 1);
    assert.equal(clientCalls, 0);
    assert.match(lines.join("\n"), /A7 not signed/);
    assert.equal(summary.stopped, "A7 not signed");
  });

  test("gold-seed order, excluded-a3, noEvidence, no-spans, QuotaStop stop, re-run skip", async () => {
    const dataDir = tempDir("prism-gold-cli-");
    const { protocolPath, signoffPath } = writeSignedA7(dataDir);
    fs.mkdirSync(path.join(dataDir, "pipeline", "manifests"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "pipeline", "snapshots"), { recursive: true });
    // Three ids: artcraft, one with spans, one with empty manifest (no spans), plus one missing manifest
    const entries = [
      { n: 10, hn_id: "aaa" },
      { n: 20, hn_id: ARTCRAFT_HN_ID },
      { n: 30, hn_id: "bbb" },
      { n: 40, hn_id: "ccc" },
    ];
    const expectedOrder = sortPilotCandidates(
      entries.map((e) => ({ id: e.hn_id, n: e.n, hn_id: e.hn_id })),
      GOLD_SEED,
    ).map((x) => x.n);
    fs.writeFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), JSON.stringify(entries));
    writeProjectTree(dataDir, 10, ["Project aaa with enough text for a span about shipping."]);
    // ArtCraft: manifest present but must get excluded-a3, no labels
    writeProjectTree(dataDir, 20, ["ArtCraft should never be labelled."]);
    // Empty spans: manifest with empty snapshot list
    fs.writeFileSync(
      path.join(dataDir, "pipeline", "manifests", "30.json"),
      JSON.stringify({ snapshotHashesInCollectionOrder: [], hnId: "bbb" }),
    );
    // n=40: no manifest → noEvidence

    let calls = 0;
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
    await ensureGoldSchema(db);
    // concurrency 1: first model call QuotaStops (D-64)
    const first = await runGoldCli({
      argv: ["--projects", path.join(dataDir, "pipeline", "sample-projects.json"), "--concurrency", "1"],
      dataDir,
      db,
      protocolPath,
      signoffPath,
      repoRoot,
      client: {
        request: async () => {
          calls += 1;
          throw new QuotaStopClass(402, "out of credit");
        },
      },
      role: ROLE_CONFIG.gold,
      log: () => {},
      err: () => {},
    });
    assert.equal(first.exitCode, 1);
    assert.ok(first.summary.stopped);
    assert.ok(Number.isInteger(first.summary.completePrefix));
    assert.equal(expectedOrder.length, 4);

    // Finish: fake client succeeds; ArtCraft / no-spans / noEvidence rules apply
    const second = await runGoldCli({
      argv: ["--projects", path.join(dataDir, "pipeline", "sample-projects.json"), "--concurrency", "1"],
      dataDir,
      db,
      protocolPath,
      signoffPath,
      repoRoot,
      client: {
        request: async () => {
          calls += 1;
          return { ok: true, status: 200, json: { choices: [{ message: { content: keyedUnknownReply() } }] } };
        },
      },
      role: ROLE_CONFIG.gold,
      log: () => {},
      err: () => {},
    });
    assert.equal(second.exitCode, 0);
    assert.equal(second.summary.stopped, null);
    assert.equal(second.summary.excludedA3, 1);
    assert.equal(second.summary.noEvidence, 1);
    const a3 = await db.selectFrom("pipeline_gold_outcomes").selectAll().where("outcome", "=", "excluded-a3").execute();
    assert.equal(a3.length, 1);
    assert.equal(a3[0].project_n, 20);
    assert.equal((await db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "=", 20).execute()).length, 0);
    const noSpan = await db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "=", 30).executeTakeFirst();
    assert.equal(noSpan?.outcome, "labelled");
    assert.equal(noSpan?.reason, "no-spans");
    assert.equal((await db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "=", 30).execute()).length, 24);
    const out10 = await db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "=", 10).executeTakeFirst();
    assert.ok(out10);

    // Third run: all digests present → no further model calls
    const callsAfterSecond = calls;
    await runGoldCli({
      argv: ["--projects", path.join(dataDir, "pipeline", "sample-projects.json"), "--concurrency", "1"],
      dataDir,
      db,
      protocolPath,
      signoffPath,
      repoRoot,
      client: {
        request: async () => {
          calls += 1;
          return { ok: true, status: 200, json: { choices: [{ message: { content: keyedUnknownReply() } }] } };
        },
      },
      role: ROLE_CONFIG.gold,
      log: () => {},
      err: () => {},
    });
    assert.equal(calls, callsAfterSecond);
  });
});
