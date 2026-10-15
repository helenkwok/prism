// COD-06/D-29/D-30: the one-command orchestrator, proven against 10
// synthetic projects with every external call faked. No real network or
// subprocess call happens in this file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadGateFile } from "../../src/pipeline/coding/contract.ts";
import { runPipeline } from "../../src/pipeline/run.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
const gates = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
const gateFile = loadGateFile(gatesPath);

function freshDb() {
  const sqlite = new Database(":memory:");
  return new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSliceProjects(dir, entries) {
  const file = path.join(dir, "slice-projects.json");
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

/** Hand-derived from claim_gate.py's evaluate() — same rule tracer.test.mjs uses. */
function fakeGateStatus(record) {
  const rule = gates.decisions[record.targetDecision];
  const states = rule.requiredChecks.map((c) => record.gateChecks[c.id] ?? "unknown");
  if (states.includes("fail")) return "BLOCKED";
  if (states.some((s) => s === "unknown" || s === "not-applicable")) return "INSUFFICIENT_EVIDENCE";
  return "PASS";
}

function fakeGateSpawnImpl(_command, args) {
  const tmpFile = args[args.length - 1];
  const record = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  const status = fakeGateStatus(record);
  return { status: status === "PASS" ? 0 : 1, stdout: JSON.stringify({ status, targetDecision: record.targetDecision }), stderr: "" };
}

const gateOverrides = { gateSpawnImpl: fakeGateSpawnImpl, pythonPath: "fake-python", gateScriptPath: "fake-gate.py" };

/** Always replies with every check "unknown", spanIds: [] — trivially schema-valid. */
function makeAllUnknownNebiusFetch(counter) {
  return async () => {
    counter.calls += 1;
    const checks = gateFile.checkIds.map((checkId) => ({ checkId, proposedState: "unknown", spanIds: [] }));
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ checks }) } }] });
  };
}

function makeThrowingNebiusFetch(counter) {
  return async () => {
    counter.calls += 1;
    throw new Error("simulated nebius network failure");
  };
}

describe("runPipeline (COD-06, D-29, D-30)", () => {
  test("10 synthetic projects: isolation of a thrown-evidence failure, D-29 thin-evidence skip, no abort", async () => {
    const cacheDir = tempDir("prism-run-cache-");
    const dataDir = tempDir("prism-run-data-");
    const db = freshDb();

    const tavilyCalls = { map: 0, extract: 0 };
    const githubCalls = { n: 0 };
    const nebiusCounter = { calls: 0 };

    const projects = [];
    for (let n = 1; n <= 8; n += 1) {
      projects.push({ n, hn_id: `hn-${n}`, title: `Project ${n}`, final_url: `https://proj${n}.example.test/` });
    }
    // n=9: thin evidence — map and extract both return nothing usable.
    projects.push({ n: 9, hn_id: "hn-9-thin", title: "Project 9 (thin)", final_url: "https://proj9-thin.example.test/" });
    // n=10: a GitHub-hosted project whose GitHub fetch throws a genuine network failure.
    projects.push({ n: 10, hn_id: "hn-10-fail", title: "Project 10 (fails)", final_url: "https://github.com/octo/repo10" });

    const sliceProjectsPath = writeSliceProjects(dataDir, projects);

    const tavilyFetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/map")) {
        tavilyCalls.map += 1;
        if (body.url.includes("proj9-thin")) return jsonResponse({ results: [], usage: { credits: 1 } });
        return jsonResponse({ results: [body.url], usage: { credits: 1 } });
      }
      // /extract
      tavilyCalls.extract += 1;
      if (body.urls.some((u) => u.includes("proj9-thin"))) return jsonResponse({ results: [], usage: { credits: 0 } });
      return jsonResponse({
        results: body.urls.map((u) => ({
          url: u,
          raw_content: `# ${u}\n\nThis is real page content about the project, long enough to pass the minimum-length extraction threshold.`,
        })),
        usage: { credits: 1 },
      });
    };

    const githubFetchImpl = async () => {
      githubCalls.n += 1;
      throw new Error("simulated github network failure");
    };

    const nebiusFetchImpl = makeAllUnknownNebiusFetch(nebiusCounter);

    const accounting = await runPipeline({
      sliceProjectsPath,
      apiKeys: { tavily: "fake-tavily-key", nebius: "fake-nebius-key", github: "fake-github-token" },
      concurrency: 3,
      cacheDir,
      db,
      gatesPath,
      overrides: { tavilyFetchImpl, githubFetchImpl, nebiusFetchImpl, ...gateOverrides },
    });

    assert.equal(accounting.ranProjects, 10, "every synthetic project must be attempted — the batch never aborts early");
    assert.equal(accounting.succeeded, 9);
    assert.equal(accounting.failed, 1);

    const failed = accounting.outcomes.find((o) => o.n === 10);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /simulated github network failure/);

    // The other 9 (including the thin-evidence project) must all succeed.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const o = accounting.outcomes.find((x) => x.n === n);
      assert.equal(o.status, "ok", `project n=${n} must succeed`);
    }

    // Project 9's code stage must skip the live Nebius call (D-29/D-30): the
    // Nebius fake must have been called for every succeeding project EXCEPT 9.
    assert.equal(nebiusCounter.calls, 8, "nebius must be called once per non-thin, non-failed project (8), never for the thin one");

    // Project 9's record must exist with every required check present, not missing.
    const rows9 = await db.selectFrom("pipeline_check_states").select(["check_id", "filtered_state"]).where("project_n", "=", 9).execute();
    assert.equal(rows9.length, gateFile.checkIds.length, "the thin-evidence project's record must cover every check, not be empty or missing");
    for (const row of rows9) {
      assert.ok(["pass", "fail", "unknown", "claimed"].includes(row.filtered_state));
    }

    // Project 10 never reached the record stage.
    const rows10 = await db.selectFrom("pipeline_project_results").select(["project_n"]).where("project_n", "=", 10).execute();
    assert.equal(rows10.length, 0, "a failed project must not leave a partial record row");
  });

  test("kill-and-resume: evidence/redact/segment are served from cache on the second call; code/filter/claims/record re-run", async () => {
    const cacheDir = tempDir("prism-run-kill-cache-");
    const dataDir = tempDir("prism-run-kill-data-");

    const project = { n: 1, hn_id: "hn-kill-1", title: "Kill-resume project", final_url: "https://killresume.example.test/" };
    const sliceProjectsPath = writeSliceProjects(dataDir, [project]);

    const tavilyCalls = { map: 0, extract: 0 };
    const tavilyFetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/map")) {
        tavilyCalls.map += 1;
        return jsonResponse({ results: [body.url], usage: { credits: 1 } });
      }
      tavilyCalls.extract += 1;
      return jsonResponse({
        results: body.urls.map((u) => ({ url: u, raw_content: `# ${u}\n\nEnough real content to pass the minimum-length threshold for extraction.` })),
        usage: { credits: 1 },
      });
    };

    const nebiusCounter = { calls: 0 };

    // --- First "run": the code stage is killed (its fetch always throws). ---
    const db1 = freshDb();
    const firstAccounting = await runPipeline({
      sliceProjectsPath,
      apiKeys: { tavily: "fake-tavily-key", nebius: "fake-nebius-key", github: "fake-github-token" },
      cacheDir,
      db: db1,
      gatesPath,
      overrides: { tavilyFetchImpl, nebiusFetchImpl: makeThrowingNebiusFetch(nebiusCounter), ...gateOverrides },
    });
    const firstOutcome = firstAccounting.outcomes[0];
    assert.equal(firstOutcome.status, "failed", "the simulated kill must surface as this project's own failure");
    assert.equal(tavilyCalls.map, 1);
    assert.equal(tavilyCalls.extract, 1);
    assert.equal(nebiusCounter.calls, 1, "the code stage was attempted once before the simulated kill");

    const tavilyCallsAfterFirstRun = { ...tavilyCalls };

    // --- Second, fresh run: everything works now. ---
    const db2 = freshDb();
    const secondAccounting = await runPipeline({
      sliceProjectsPath,
      apiKeys: { tavily: "fake-tavily-key", nebius: "fake-nebius-key", github: "fake-github-token" },
      cacheDir, // same cache directory — the whole point of this test
      db: db2,
      gatesPath,
      overrides: { tavilyFetchImpl, nebiusFetchImpl: makeAllUnknownNebiusFetch(nebiusCounter), ...gateOverrides },
    });
    const secondOutcome = secondAccounting.outcomes[0];
    assert.equal(secondOutcome.status, "ok");

    // evidence/redact/segment: no new Tavily calls, and each reports fromCache:true.
    assert.deepEqual(tavilyCalls, tavilyCallsAfterFirstRun, "no new Tavily calls on the resumed run — evidence must be served from cache");
    assert.equal(secondOutcome.boundaryFromCache, true);
    assert.equal(secondOutcome.evidenceFromCache, true);
    assert.equal(secondOutcome.redactFromCache, true);
    assert.equal(secondOutcome.segmentFromCache, true);

    // code/filter/claims+gate/record: must actually run this time (not cached, since they never completed before the kill).
    assert.equal(secondOutcome.codeFromCache, false);
    assert.equal(secondOutcome.filterFromCache, false);
    assert.equal(secondOutcome.claimsFromCache, false);
    assert.equal(secondOutcome.recordFromCache, false);
    assert.equal(nebiusCounter.calls, 2, "the code stage must be attempted again on the resumed run (1 failed attempt + 1 successful attempt)");

    const rows = await db2.selectFrom("pipeline_project_results").select(["project_n"]).execute();
    assert.equal(rows.length, 1, "the resumed run must record the project it completes");
  });
});
