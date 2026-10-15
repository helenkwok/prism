// D-26/D-27 coverage: 5 reused + 5 seeded-drawn, deterministic, no duplicates,
// skip on robots-blocked/out-of-boundary. No network: frame and preflight are
// both injected fixtures.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { selectSliceProjects } from "../../src/pipeline/select/slice-projects.ts";

const created = [];
function tmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-slice-test-"));
  created.push(dir);
  return dir;
}

function reusedFixture(dataDir) {
  const reused = [1, 2, 3, 4, 5].map((i) => ({
    hn_id: `r${i}`,
    title: `Show HN: reused AI project ${i}`,
    entry_url: `https://reused${i}.example.com/`,
    final_url: `https://reused${i}.example.com/`,
    boundary: { host: `reused${i}.example.com` },
    type_class: "own-domain",
    created_at: `2025-10-0${i}T00:00:00.000Z`,
  }));
  const spikesDir = path.join(dataDir, "spikes");
  fs.mkdirSync(spikesDir, { recursive: true });
  const file = path.join(spikesDir, "projects.json");
  fs.writeFileSync(file, JSON.stringify(reused));
  return { reused, file };
}

const ROBOTS_BLOCKED = new Set(["p-blocked-1", "p-blocked-2"]);
const BOUNDARY_BAD = new Set(["p-oob-1", "p-oob-2"]);
const UNUSABLE = new Set(["p-null-1"]);

function makeFakePreflight() {
  const calls = [];
  const fn = async ({ id }) => {
    calls.push(id);
    if (UNUSABLE.has(id)) return null;
    return {
      entry_url: `https://${id}.example.com/`,
      final_url: `https://${id}.example.com/`,
      boundary: { host: `${id}.example.com` },
      type_class: "own-domain",
      preflight: {
        robots_blocked: ROBOTS_BLOCKED.has(id),
        boundary_ok: !BOUNDARY_BAD.has(id),
      },
    };
  };
  return { fn, calls };
}

function makeFrame(duplicateReusedId) {
  const posts = [
    // excluded: duplicates a reused project's hn_id, even though it matches AI_TITLE
    { id: duplicateReusedId, title: "Show HN: another AI tool", url: "https://dup.example.com/", created_at: "2026-01-01T00:00:00.000Z" },
    // excluded: does not match AI_TITLE
    { id: "n1", title: "Show HN: a plain website builder", url: "https://plain1.example.com/", created_at: "2026-01-02T00:00:00.000Z" },
    { id: "n2", title: "Show HN: a recipe tracker", url: "https://plain2.example.com/", created_at: "2026-01-03T00:00:00.000Z" },
    // eligible: AI-matching, not a reused duplicate
    ...["p-clean-1", "p-clean-2", "p-clean-3", "p-clean-4", "p-clean-5", "p-blocked-1", "p-blocked-2", "p-oob-1", "p-oob-2", "p-null-1"].map(
      (id, i) => ({
        id,
        title: `Show HN: an AI agent for task ${i}`,
        url: `https://${id}.example.com/`,
        created_at: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    ),
  ];
  return { posts };
}

describe("selectSliceProjects (D-26/D-27)", () => {
  let previousDataDir;
  let dataDir;

  before(() => {
    previousDataDir = process.env.PRISM_DATA_DIR;
  });

  beforeEach(() => {
    dataDir = tmpDataDir();
    process.env.PRISM_DATA_DIR = dataDir;
  });

  after(() => {
    if (previousDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = previousDataDir;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("produces exactly 10 entries: 5 unchanged phase1-spike + 5 phase2-drawn", async () => {
    const { reused, file } = reusedFixture(dataDir);
    const frame = makeFrame("r3");
    const { fn: preflight } = makeFakePreflight();

    const result = await selectSliceProjects({ frame, reusedProjectsPath: file, preflight });

    assert.equal(result.length, 10);
    const spikeEntries = result.filter((p) => p.source === "phase1-spike");
    const drawnEntries = result.filter((p) => p.source === "phase2-drawn");
    assert.equal(spikeEntries.length, 5);
    assert.equal(drawnEntries.length, 5);

    for (let i = 0; i < 5; i++) {
      assert.deepEqual(
        { hn_id: spikeEntries[i].hn_id, title: spikeEntries[i].title, entry_url: spikeEntries[i].entry_url, final_url: spikeEntries[i].final_url, boundary: spikeEntries[i].boundary, type_class: spikeEntries[i].type_class, created_at: spikeEntries[i].created_at },
        { hn_id: reused[i].hn_id, title: reused[i].title, entry_url: reused[i].entry_url, final_url: reused[i].final_url, boundary: reused[i].boundary, type_class: reused[i].type_class, created_at: reused[i].created_at },
      );
    }

    const drawnIds = new Set(drawnEntries.map((p) => p.hn_id));
    for (const id of ["p-blocked-1", "p-blocked-2", "p-oob-1", "p-oob-2", "p-null-1", "r3", "n1", "n2"]) {
      assert.equal(drawnIds.has(id), false, `${id} must not appear among the drawn projects`);
    }

    const writtenPath = path.join(dataDir, "pipeline", "slice-projects.json");
    const written = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    assert.equal(written.length, 10);
    assert.deepEqual(written.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a pool candidate duplicating a reused hn_id is excluded before preflight ever runs", async () => {
    const { file } = reusedFixture(dataDir);
    const frame = makeFrame("r3");
    const { fn: preflight, calls } = makeFakePreflight();

    await selectSliceProjects({ frame, reusedProjectsPath: file, preflight });

    assert.equal(calls.includes("r3"), false, "preflight must never be called for a reused-duplicate candidate");
  });

  test("robots_blocked and boundary_ok:false candidates are skipped and consume no drawn slot", async () => {
    const { file } = reusedFixture(dataDir);
    const frame = makeFrame("r3");
    const { fn: preflight } = makeFakePreflight();

    const result = await selectSliceProjects({ frame, reusedProjectsPath: file, preflight });
    const drawnIds = result.filter((p) => p.source === "phase2-drawn").map((p) => p.hn_id);

    assert.equal(drawnIds.length, 5);
    assert.deepEqual(new Set(drawnIds), new Set(["p-clean-1", "p-clean-2", "p-clean-3", "p-clean-4", "p-clean-5"]));
  });

  test("same seed, same inputs: two runs produce byte-identical n-ordering", async () => {
    const { file } = reusedFixture(dataDir);
    const frame = makeFrame("r3");
    const { fn: preflightA } = makeFakePreflight();
    const { fn: preflightB } = makeFakePreflight();

    const resultA = await selectSliceProjects({ frame, reusedProjectsPath: file, preflight: preflightA });
    const resultB = await selectSliceProjects({ frame, reusedProjectsPath: file, preflight: preflightB });

    assert.deepEqual(resultA, resultB);
  });
});
