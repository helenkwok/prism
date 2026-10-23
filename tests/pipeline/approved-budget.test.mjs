import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { openApprovedBudget } from "../../src/pipeline/validate/approved-budget.ts";

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
