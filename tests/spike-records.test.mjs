import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNumbersOnly,
  extractJsonBlock,
  replaceJsonBlock,
  validateRecord,
} from "../scripts/lib/spike-record.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "scripts/check-spike-records.mjs");

const created = [];
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prism-spk-"));
  created.push(d);
  return d;
}

// ---- fixtures --------------------------------------------------------------

function matrixEntry(model, output_mode, thinking) {
  return {
    model,
    output_mode,
    thinking,
    n: 20,
    json_parse_rate: 1,
    zod_valid_rate: 0.95,
    span_resolve_rate: 0.9,
    schema_valid_rate: 0.95,
    retry_rate: 0.05,
    finish_reasons: { stop: 20 },
    latency_ms: { p50: 4200, p95: 9100 },
    tokens: { in: 6000, out: 800 },
    cost_usd: 0.04,
  };
}

function nebius(overrides = {}) {
  const models = ["nvidia/model-a", "nvidia/model-b", "nvidia/model-c"];
  const matrix = [];
  for (const m of models) for (const mode of ["json_schema", "json_object"]) for (const t of ["on", "off"]) matrix.push(matrixEntry(m, mode, t));
  return {
    record: "nebius",
    status: "final",
    updated: "2026-09-20",
    catalogue: [
      {
        id: "nvidia/model-a",
        host: "api.tokenfactory.nebius.com",
        context_length: 1000000,
        quantization: "fp4",
        pricing: { in: 1, out: 3 },
        supported_features: ["json_mode"],
        regions: ["us-central1"],
        status: "featured",
      },
    ],
    matrix,
    escape_probe: [{ model: "nvidia/model-a", output_mode: "json_schema", survived: true }],
    batch: { submitted_at: "2026-09-20T10:00:00Z", completed_at: "2026-09-20T11:00:00Z", final_status: "completed", per_model: { "nvidia/model-a": "ok" }, price_ratio: 0.5 },
    zdr: { status: "on", checked_on: "2026-09-20" },
    credits: { ai_cloud_coverage: "unknown", checked_on: "2026-09-20" },
    rate_limits: { rpm: 60 },
    pinned: {
      model: "nvidia/model-a",
      output_mode: "json_schema",
      thinking: "off",
      base_url: "https://api.tokenfactory.nebius.com/v1/",
      mode: "real-time",
      retry_rate: 0.04,
      streak: { n: 50, max_consecutive_valid: 50 },
    },
    fallbacks: { batch: "not-needed", zdr: "not-needed" },
    ...overrides,
  };
}

function tavilyProject(type_class, overrides = {}) {
  return {
    type_class,
    preflight: { robots_blocked: false, redirect_hops: 0, boundary_ok: true },
    map: { urls_returned: 20 },
    extract: { results: 18, failed: 1, empty: 1, advanced_retries: 1 },
    leakage: { raw_offsite_in_map: 3, raw_offsite_in_results: 0, after_filter: 0 },
    credits: { per_call: 12, formula: 12, account_delta: 12, total: 12 },
    wall_ms: 8000,
    ...overrides,
  };
}

function tavily(overrides = {}) {
  return {
    record: "tavily",
    status: "final",
    updated: "2026-09-20",
    credit_balance_checked: { checked_on: "2026-09-20", credits_or_usd: 1000 },
    criterion: { id: "A", outcome: "met" },
    projects: ["own-domain", "shared-host", "repo-only", "spa", "redirect"].map((t) => tavilyProject(t)),
    controls: { allow_external_true: { offsite_results: 7 }, search_fallback: { results: 5 } },
    aggregate: { median_credits: 12, p95_credits: 20, max_credits: 22 },
    blocks_phase2_collector: false,
    corpus_pages: 90,
    ...overrides,
  };
}

function docker(overrides = {}) {
  return {
    record: "docker-app",
    status: "final",
    updated: "2026-09-20",
    base_image: { tag: "node:24-slim", digest: "sha256:" + "a".repeat(64) },
    image_bytes: 400000000,
    build_seconds: 210,
    smoke: {
      sign_in_200: true,
      seeded_sign_in: true,
      session_page: true,
      pdf_magic: true,
      sign_up_disabled: true,
      gate_in_image: true,
      non_root: true,
      boot_fails_without_secret: true,
    },
    verifier: { kind: "ci", run_id: "123456" },
    versions: { node: "24.14.0", python: "3.13.5" },
    takumi_fallback_needed: false,
    ...overrides,
  };
}

const asMd = (obj, prose = "Numbers only.\n") => "# Record\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n\n" + prose;

function cliRun(dir, ...args) {
  const res = spawnSync("node", [CLI, "--dir", dir, ...args], { encoding: "utf8" });
  return { status: res.status, stderr: res.stderr };
}

// ---- record contract -------------------------------------------------------

describe("record contract: valid fixtures", () => {
  test("valid final nebius, tavily and docker-app fixtures pass", () => {
    assert.deepEqual(validateRecord("nebius", nebius(), { requireFinal: true }), []);
    assert.deepEqual(validateRecord("tavily", tavily(), { requireFinal: true }), []);
    assert.deepEqual(validateRecord("docker-app", docker(), { requireFinal: true }), []);
  });

  test("a pending record needs only record, status and updated", () => {
    assert.deepEqual(validateRecord("nebius", { record: "nebius", status: "pending", updated: "2026-09-20" }), []);
  });

  test("a wrong record name or status is named", () => {
    const v = validateRecord("nebius", { record: "tavily", status: "done", updated: "yesterday" });
    assert.ok(v.some((m) => m.startsWith("record:")), v.join("\n"));
    assert.ok(v.some((m) => m.startsWith("status:")), v.join("\n"));
    assert.ok(v.some((m) => m.startsWith("updated:")), v.join("\n"));
  });

  test("requireFinal rejects a pending record and names status", () => {
    const v = validateRecord("nebius", { record: "nebius", status: "pending", updated: "2026-09-20" }, { requireFinal: true });
    assert.deepEqual(v, ["status: must be final"]);
  });
});

describe("record contract: malformed final fixtures fail and name the rule", () => {
  test("nebius matrix with 11 entries fails", () => {
    const o = nebius();
    o.matrix.pop();
    const v = validateRecord("nebius", o);
    assert.ok(v.some((m) => m.startsWith("matrix: must contain exactly 12 entries (found 11)")), v.join("\n"));
  });

  test("nebius matrix with a duplicated configuration fails", () => {
    const o = nebius();
    o.matrix[1] = structuredClone(o.matrix[0]);
    const v = validateRecord("nebius", o);
    assert.ok(v.some((m) => /matrix\[1\].*duplicates/.test(m)), v.join("\n"));
  });

  test("nebius with no nvidia/ catalogue entry fails", () => {
    const o = nebius();
    o.catalogue[0].id = "other/model";
    o.pinned.model = "other/model";
    const v = validateRecord("nebius", o);
    assert.ok(v.some((m) => m.includes("catalogue: must contain at least one entry whose id starts with nvidia/")), v.join("\n"));
  });

  test("nebius with a missing key names it, and a bad enum names the allowed values", () => {
    const o = nebius();
    delete o.zdr;
    o.batch.final_status = "running";
    o.matrix[0].thinking = "maybe";
    const v = validateRecord("nebius", o);
    assert.ok(v.some((m) => m.startsWith("zdr:")), v.join("\n"));
    assert.ok(v.some((m) => m.startsWith("batch.final_status: must be one of completed")), v.join("\n"));
    assert.ok(v.some((m) => m.startsWith("matrix[0].thinking: must be one of on, off")), v.join("\n"));
  });

  test("nebius pinned model must be one of the matrix models", () => {
    const o = nebius();
    o.pinned.model = "nvidia/never-measured";
    const v = validateRecord("nebius", o);
    assert.ok(v.some((m) => m.startsWith("pinned.model: must equal the model of a matrix entry")), v.join("\n"));
  });

  test("nebius rates outside 0..1 fail, and null is allowed only when n is 0", () => {
    const bad = nebius();
    bad.matrix[0].zod_valid_rate = 1.5;
    assert.ok(validateRecord("nebius", bad).some((m) => m.startsWith("matrix[0].zod_valid_rate")));
    const nullWithData = nebius();
    nullWithData.matrix[0].json_parse_rate = null;
    assert.ok(validateRecord("nebius", nullWithData).some((m) => m.startsWith("matrix[0].json_parse_rate")));
    const notRunnable = nebius();
    Object.assign(notRunnable.matrix[0], { n: 0, json_parse_rate: null, zod_valid_rate: null, span_resolve_rate: null, schema_valid_rate: null, retry_rate: null });
    assert.deepEqual(validateRecord("nebius", notRunnable), []);
  });

  test("tavily with 4 projects fails", () => {
    const o = tavily();
    o.projects.pop();
    const v = validateRecord("tavily", o);
    assert.ok(v.some((m) => m.startsWith("projects: must contain exactly 5 entries (found 4)")), v.join("\n"));
  });

  test("tavily with a repeated type_class fails", () => {
    const o = tavily();
    o.projects[4].type_class = "own-domain";
    const v = validateRecord("tavily", o);
    assert.ok(v.some((m) => /projects\[4\]\.type_class: duplicates/.test(m)), v.join("\n"));
  });

  test("tavily after_filter above zero with blocks_phase2_collector false fails; true passes", () => {
    const o = tavily();
    o.projects[0].leakage.after_filter = 2;
    const v = validateRecord("tavily", o);
    assert.ok(v.some((m) => m.startsWith("blocks_phase2_collector: must be true")), v.join("\n"));
    o.blocks_phase2_collector = true;
    assert.deepEqual(validateRecord("tavily", o), []);
  });

  test("tavily missing credits.account_delta key value type is named", () => {
    const o = tavily();
    o.projects[2].credits.account_delta = "n/a";
    const v = validateRecord("tavily", o);
    assert.ok(v.some((m) => m.startsWith("projects[2].credits.account_delta: must be a number or null")), v.join("\n"));
  });

  test("docker-app with a non-boolean or missing smoke key fails naming it", () => {
    const o = docker();
    o.smoke.non_root = "yes";
    delete o.smoke.pdf_magic;
    const v = validateRecord("docker-app", o);
    assert.ok(v.some((m) => m.startsWith("smoke.non_root: must be a boolean")), v.join("\n"));
    assert.ok(v.some((m) => m.startsWith("smoke.pdf_magic: must be a boolean")), v.join("\n"));
  });

  test("docker-app with a bad verifier kind fails naming it", () => {
    const v = validateRecord("docker-app", docker({ verifier: { kind: "manual", run_id: "1" } }));
    assert.ok(v.some((m) => m.startsWith("verifier.kind: must be one of ci, local")), v.join("\n"));
  });

  test("a long string (pasted page text) fails even in a pending record", () => {
    const v = validateRecord("tavily", { record: "tavily", status: "pending", updated: "2026-09-20", note: "x".repeat(300) });
    assert.ok(v.some((m) => m.includes("string longer than 200 characters")), v.join("\n"));
  });
});

// ---- numbers-only guard ----------------------------------------------------

describe("numbers-only guard", () => {
  const rulesOf = (md) => {
    try {
      assertNumbersOnly(md);
      return [];
    } catch (err) {
      return err.violations.map((v) => v.rule);
    }
  };

  test("a project-style https URL fails; a provider docs URL passes", () => {
    assert.deepEqual(rulesOf("see https://some-project.example.org/pricing"), ["url-not-on-provider-allow-list"]);
    assert.deepEqual(rulesOf("see https://docs.tavily.com/documentation/api-credits"), []);
    assert.deepEqual(rulesOf("see https://api.tokenfactory.us-central1.nebius.com/v1/"), []);
    assert.deepEqual(rulesOf("frame https://hn.algolia.com/api/v1/search_by_date"), []);
  });

  test("an allow-listed host as a suffix of another host does not pass", () => {
    assert.deepEqual(rulesOf("https://docs.tavily.com.evil.example/x"), ["url-not-on-provider-allow-list"]);
  });

  test("an email address fails", () => {
    assert.deepEqual(rulesOf("contact founder@startup.io for details"), ["email-address"]);
  });

  test("package pins and image digests are not mistaken for emails", () => {
    assert.deepEqual(rulesOf("takumi-pdf@0.14.3 and node:24-slim@sha256:" + "a".repeat(64)), []);
  });

  test("an API key assignment fails, whatever its value", () => {
    assert.deepEqual(rulesOf("NEBIUS_API_KEY=abc123"), ["api-key-assignment"]);
    assert.deepEqual(rulesOf('"TAVILY_API_KEY": "set"'), ["api-key-assignment"]);
    assert.deepEqual(rulesOf("the env var NEBIUS_API_KEY was present"), []);
  });

  test("a bearer token and key-shaped strings fail", () => {
    assert.ok(rulesOf("Authorization: Bearer abcdefgh12345678").includes("bearer-token"));
    assert.ok(rulesOf("key tvly-abcdefghijk1234").includes("key-or-token-shape"));
    assert.ok(rulesOf("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig").includes("key-or-token-shape"));
  });

  test("violation output never echoes the offending text", () => {
    try {
      assertNumbersOnly("visit https://secret-project.example.org now");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(!err.message.includes("secret-project"));
      assert.match(err.message, /line 1/);
    }
  });
});

describe("json block helpers", () => {
  test("extractJsonBlock reads the FIRST fenced json block only", () => {
    const md = "text\n```json\n{\"a\":1}\n```\nmore\n```json\n{\"a\":2}\n```\n";
    assert.deepEqual(extractJsonBlock(md), { a: 1 });
  });

  test("replaceJsonBlock swaps the block and preserves prose before and after", () => {
    const md = "# Title\n\nintro\n\n```json\n{\"a\":1}\n```\n\ntrailing commentary 42\n";
    const out = replaceJsonBlock(md, { a: 2, b: [1, 2] });
    assert.deepEqual(extractJsonBlock(out), { a: 2, b: [1, 2] });
    assert.ok(out.startsWith("# Title\n\nintro\n\n"));
    assert.ok(out.endsWith("\n```\n\ntrailing commentary 42\n"));
  });

  test("a missing or malformed block throws", () => {
    assert.throws(() => extractJsonBlock("no block here"), /no fenced json block/);
    assert.throws(() => extractJsonBlock("```json\n{nope}\n```\n"), /not valid JSON/);
  });
});

// ---- CLI -------------------------------------------------------------------

describe("check-spike-records CLI", () => {
  test("a directory with valid final records passes with and without --require-final", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "nebius.md"), asMd(nebius()));
    fs.writeFileSync(path.join(d, "tavily.md"), asMd(tavily()));
    fs.writeFileSync(path.join(d, "docker-app.md"), asMd(docker()));
    assert.equal(cliRun(d).status, 0);
    const r = cliRun(d, "--require-final");
    assert.equal(r.status, 0, r.stderr);
  });

  test("--require-final fails when a record is missing, naming it", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "nebius.md"), asMd(nebius()));
    const r = cliRun(d, "--require-final");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tavily\.md: record is missing/);
    assert.match(r.stderr, /docker-app\.md: record is missing/);
  });

  test("--require-final fails when a record is still pending, while plain lint passes", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "nebius.md"), asMd(nebius()));
    fs.writeFileSync(path.join(d, "tavily.md"), asMd(tavily()));
    fs.writeFileSync(path.join(d, "docker-app.md"), asMd({ record: "docker-app", status: "pending", updated: "2026-09-20" }));
    assert.equal(cliRun(d).status, 0);
    const r = cliRun(d, "--require-final");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docker-app\.md: status: must be final/);
  });

  test("an empty or missing directory lints clean, but fails --require-final", () => {
    const d = tmpDir();
    assert.equal(cliRun(d).status, 0);
    assert.equal(cliRun(path.join(d, "does-not-exist")).status, 0);
    assert.equal(cliRun(d, "--require-final").status, 1);
  });

  test("a project URL in the prose of an otherwise valid record fails, naming file and line", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "tavily.md"), asMd(tavily(), "Probed https://acme-project.example.org today.\n"));
    const r = cliRun(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tavily\.md: numbers-only guard: url-not-on-provider-allow-list \(line \d+\)/);
    assert.ok(!r.stderr.includes("acme-project"));
  });

  test("a final record failing the contract is named by file and key", () => {
    const d = tmpDir();
    const o = tavily();
    o.projects.pop();
    fs.writeFileSync(path.join(d, "tavily.md"), asMd(o));
    const r = cliRun(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tavily\.md: projects: must contain exactly 5 entries \(found 4\)/);
  });

  test("a record file with no json block is reported", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "docker-app.md"), "# nothing here\n");
    const r = cliRun(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docker-app\.md: no fenced json block found/);
  });

  test("an unrelated markdown file gets the numbers-only guard but no contract", () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "README.md"), "Notes on the folder.\n");
    assert.equal(cliRun(d).status, 0);
    fs.writeFileSync(path.join(d, "README.md"), "See https://some-project.example.org\n");
    assert.equal(cliRun(d).status, 1);
  });

  test("an unknown flag is a usage error", () => {
    assert.equal(cliRun(tmpDir(), "--nope").status, 2);
  });

  test("any real spikes/*.md in the repository satisfy the pending-mode contract", () => {
    const real = path.join(REPO_ROOT, "spikes");
    if (!fs.existsSync(real)) return; // vacuous until the spike plans write records; 01-13 enforces --require-final
    const r = spawnSync("node", [CLI], { encoding: "utf8", cwd: REPO_ROOT });
    assert.equal(r.status, 0, r.stderr);
  });
});
