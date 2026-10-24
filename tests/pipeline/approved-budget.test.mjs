import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { APPROVED_CAPS, APPROVED_OLLAMA_CAP, migrateApprovedStageCap, openApprovedBudget } from "../../src/pipeline/validate/approved-budget.ts";

test("stage and combined caps survive reservations and process resumes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-budget-test-"));
  let run = openApprovedBudget(dir, "gold");
  assert.throws(() => openApprovedBudget(dir, "spike"), /EEXIST/);
  run.budget.reserve(4); run.budget.settle(4, 3);
  run.budget.reserve(.5); run.release();
  run = openApprovedBudget(dir, "gold");
  assert.equal(run.budget.spent, 3.5);
  assert.equal(run.parent.spent, 3.5);
  assert.throws(() => run.budget.reserve(1.01), /budget exceeded/);
  run.release();
  run = openApprovedBudget(dir, "spike");
  assert.equal(run.parent.spent, 3.5);
  assert.throws(() => run.budget.reserve(.51), /budget exceeded/);
  run.release();
});

test("signoff and recoding share the total approved primary-host cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-budget-test-"));
  let run = openApprovedBudget(dir, "signoff");
  run.budget.recordSpent(.02); run.release();
  run = openApprovedBudget(dir, "recode");
  assert.equal(run.parent.spent, .02);
  assert.throws(() => run.budget.reserve(3.79), /budget exceeded/);
  run.budget.reserve(3.78); run.release();
});

test("the approved cap increase preserves spend and unresolved reservations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-budget-test-"));
  const validation = path.join(dir, "validation"); fs.mkdirSync(validation);
  fs.writeFileSync(path.join(validation, "approved-budget-2026-10-23.json"), JSON.stringify({ approval: "2026-10-23", stages: { recode: { cap: 3.5, spent: 1.4, reserved: .02, estimated: 8 } } }));
  const run = openApprovedBudget(dir, "recode");
  assert.equal(run.budget.cap, 3.8);
  assert.equal(run.budget.spent, 1.42);
  assert.equal(run.parent.spent, 1.42);
  run.release();
});

test("a terminated run lease can resume without losing pending charges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-budget-test-"));
  const run = openApprovedBudget(dir, "gold");
  run.budget.reserve(.03);
  run.release();
  const dead = spawnSync(process.execPath, ["-e", ""]);
  fs.writeFileSync(`${run.file}.lock`, String(dead.pid));
  const resumed = openApprovedBudget(dir, "gold");
  assert.equal(resumed.budget.spent, .03);
  assert.equal(resumed.parent.spent, .03);
  resumed.release();
});

test("the confirmation migration changes only its approved prior cap", () => {
  const previous = { cap: 5, spent: .3006193, reserved: .02, estimated: 8 };
  for (const cap of [5, 7]) {
    const state = { ...previous, cap }; migrateApprovedStageCap("full-confirm", state);
    assert.deepEqual(state, { ...previous, cap: 7.5 });
  }
  for (const [stage, cap] of [["gold", 5], ["spike", .5], ["full-confirm", 5.01], ["full-confirm", 7.01]]) {
    const unchanged = { ...previous, cap }; migrateApprovedStageCap(stage, unchanged);
    assert.deepEqual(unchanged, { ...previous, cap });
  }
  assert.equal(APPROVED_CAPS.gold, 4.5); assert.equal(APPROVED_CAPS["second-coder"], .75); assert.equal(APPROVED_CAPS.spike, .5); assert.equal(APPROVED_OLLAMA_CAP, 10.75);
});

test("resuming the increased confirmation cap retains all charges and cumulative estimates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirm-budget-")); const validation = path.join(dir, "validation"); fs.mkdirSync(validation);
  const previous = { cap: 7, spent: .3006193, reserved: .02, estimated: 8 };
  const file = path.join(validation, "approved-budget-2026-10-23.json");
  fs.writeFileSync(file, JSON.stringify({ approval: "2026-10-23", stages: { "full-confirm": previous, gold: { cap: 4.5, spent: 2, reserved: 0, estimated: 3 } } }));
  const run = openApprovedBudget(dir, "full-confirm");
  assert.equal(run.budget.cap, APPROVED_CAPS["full-confirm"]); assert.equal(run.budget.spent, previous.spent + previous.reserved); assert.equal(run.budget.estimated, 8); assert.equal(run.parent.estimated, 11);
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(ledger.stages["full-confirm"], { cap: 7.5, spent: previous.spent + previous.reserved, reserved: 0, estimated: 8 });
  assert.deepEqual(ledger.stages.gold, { cap: 4.5, spent: 2, reserved: 0, estimated: 3 });
  assert.throws(() => run.budget.reserve(7.51 - run.budget.spent), /budget exceeded/); run.release();
});

test("the increased stage cap cannot bypass the unchanged shared limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirm-shared-")); const validation = path.join(dir, "validation"); fs.mkdirSync(validation);
  fs.writeFileSync(path.join(validation, "approved-budget-2026-10-23.json"), JSON.stringify({ approval: "2026-10-23", stages: { gold: { cap: 4.5, spent: 4, reserved: 0, estimated: 4 }, "full-confirm": { cap: 5, spent: .3, reserved: 0, estimated: .4 } } }));
  const run = openApprovedBudget(dir, "full-confirm");
  assert.equal(run.parent.cap, 10.75); assert.throws(() => run.budget.reserve(6.46), /budget exceeded/);
  run.release();
});
