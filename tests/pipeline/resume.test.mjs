// COD-06 resumability: proves kill-and-rerun resumes from cached stage
// output, keyed by (projectId, stage, input), existence- not truthiness-
// checked, and never collided across projects.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { readCached, stageCacheKey, withStageCache, writeCached } from "../../src/pipeline/cache/stage-cache.ts";

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prism-stage-cache-"));
}

describe("withStageCache (COD-06)", () => {
  test("a second call with the same projectId/stage/input calls compute only once and reports fromCache:true", async () => {
    const cacheDir = tempCacheDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { ok: true };
    };

    const first = await withStageCache(cacheDir, "proj-1", "collect", { url: "a" }, compute);
    const second = await withStageCache(cacheDir, "proj-1", "collect", { url: "a" }, compute);

    assert.equal(calls, 1);
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.deepEqual(second.value, first.value);
  });

  test("the same stage/input with two different projectId values produce two different keys and two separate computes", async () => {
    const cacheDir = tempCacheDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { calls };
    };

    const a = await withStageCache(cacheDir, "proj-A", "collect", { url: "same" }, compute);
    const b = await withStageCache(cacheDir, "proj-B", "collect", { url: "same" }, compute);

    assert.equal(calls, 2);
    assert.equal(a.fromCache, false);
    assert.equal(b.fromCache, false);
    assert.notEqual(
      stageCacheKey("proj-A", "collect", { url: "same" }),
      stageCacheKey("proj-B", "collect", { url: "same" }),
    );
  });

  test("a compute that resolves to [] or {} is cached and read back as fromCache:true, not re-run", async () => {
    const cacheDir = tempCacheDir();

    let emptyArrayCalls = 0;
    const computeEmptyArray = async () => {
      emptyArrayCalls += 1;
      return [];
    };
    await withStageCache(cacheDir, "proj-1", "map", {}, computeEmptyArray);
    const secondArray = await withStageCache(cacheDir, "proj-1", "map", {}, computeEmptyArray);
    assert.equal(emptyArrayCalls, 1, "compute must not be called again for a cached empty array");
    assert.equal(secondArray.fromCache, true);
    assert.deepEqual(secondArray.value, []);

    let emptyObjectCalls = 0;
    const computeEmptyObject = async () => {
      emptyObjectCalls += 1;
      return {};
    };
    await withStageCache(cacheDir, "proj-1", "extract", {}, computeEmptyObject);
    const secondObject = await withStageCache(cacheDir, "proj-1", "extract", {}, computeEmptyObject);
    assert.equal(emptyObjectCalls, 1, "compute must not be called again for a cached empty object");
    assert.equal(secondObject.fromCache, true);
    assert.deepEqual(secondObject.value, {});
  });

  test("changing one field of input changes the key and causes a cache miss", async () => {
    const cacheDir = tempCacheDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { calls };
    };

    await withStageCache(cacheDir, "proj-1", "collect", { url: "a", depth: 1 }, compute);
    const changed = await withStageCache(cacheDir, "proj-1", "collect", { url: "a", depth: 2 }, compute);

    assert.equal(calls, 2);
    assert.equal(changed.fromCache, false);
  });

  test("readCached is existence-based: a written empty value is a hit, a never-written key is a miss", () => {
    const cacheDir = tempCacheDir();
    const key = stageCacheKey("proj-1", "segment", { text: "" });

    const beforeWrite = readCached(cacheDir, key);
    assert.equal(beforeWrite.hit, false);

    writeCached(cacheDir, key, []);
    const afterWrite = readCached(cacheDir, key);
    assert.equal(afterWrite.hit, true);
    assert.deepEqual(afterWrite.value, []);
  });

  test("killing the pipeline mid-run and rerunning resumes from cached stage outputs for completed project/stage pairs with no duplicate external calls", async () => {
    const cacheDir = tempCacheDir();
    const projects = ["proj-1", "proj-2", "proj-3"];
    const callLog = [];

    async function runStage(projectId, stage, input) {
      const compute = async () => {
        callLog.push(`${projectId}:${stage}`);
        return { projectId, stage, input };
      };
      return withStageCache(cacheDir, projectId, stage, input, compute);
    }

    // First "run": only proj-1 and proj-2 finish the "collect" stage before the kill.
    await runStage("proj-1", "collect", { n: 1 });
    await runStage("proj-2", "collect", { n: 2 });
    // simulated kill here — proj-3 never ran

    // Rerun from scratch: every project asks for "collect" again.
    callLog.length = 0;
    await runStage("proj-1", "collect", { n: 1 });
    await runStage("proj-2", "collect", { n: 2 });
    await runStage("proj-3", "collect", { n: 3 });

    assert.deepEqual(callLog, ["proj-3:collect"], "only the project never completed before the kill should re-run its stage");
  });
});
