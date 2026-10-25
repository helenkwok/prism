import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateLines, watchApproved } from "../../src/pipeline/validate/watch-approved.ts";

const complete = { stage: "full-confirm", total: 10, accounted: 10, cached: 2, attempted: 8, valid: 10, failed: 0, stopped: 0, remaining: 0, awaitingGold: 0, confirmed: 1, rejected: 8, downgraded: 1, flagged: 1, excludedA3: 1, reason: null, ok: true, complete: true };
const partial = { ...complete, accounted: 4, cached: 1, attempted: 5, valid: 4, stopped: 6, remaining: 6, confirmed: 1, rejected: 3, downgraded: 0, reason: "BudgetExceededError", ok: false, complete: false };
function lines(out = complete, { stageSpent = 4, hostSpent = 7, stageCap = 5 } = {}) {
  return [`BUDGET: ${JSON.stringify({ estimated: 0, spent: 0, cap: stageCap })}`, `CONFIRMATION: ${JSON.stringify(out)}`, `ACCOUNTING: ${JSON.stringify(out)}`, `BUDGET: ${JSON.stringify({ estimated: 6, spent: stageSpent, cap: stageCap })}`, `HOST_BUDGET: ${JSON.stringify({ host: "ollama", estimated: 10, spent: hostSpent, cap: 10.75 })}`].join("\n") + "\n";
}
function fixture(text, reserved = 0) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-observer-"));
  const validation = path.join(dataDir, "validation"); fs.mkdirSync(validation);
  fs.writeFileSync(path.join(validation, "approved-full-confirm.log"), text);
  fs.writeFileSync(path.join(validation, "approved-budget-2026-10-23.json"), JSON.stringify({ approval: "2026-10-23", stages: { gold: { spent: 2, reserved: 0 }, "second-coder": { spent: 0.5, reserved: 0 }, spike: { spent: 0.5, reserved: 0 }, "full-confirm": { spent: 4, reserved, cap: 5 } } }));
  fs.writeFileSync(path.join(validation, "approved-budget-2026-10-23.json.lock"), "123\n");
  return { dataDir, validation };
}

test("printed identities prove completion or an explicitly partial cap stop", () => {
  const done = validateLines(lines()); assert.equal(done.complete, true); assert.equal(done.verifiedPrintedLines, true);
  const stopped = validateLines(lines(partial)); assert.equal(stopped.status, "partial"); assert.equal(stopped.complete, false); assert.equal(stopped.valid, 4); assert.equal(stopped.remaining, 6); assert.equal(stopped.reason, "BudgetExceededError");
  const increased = validateLines(lines(complete, { stageCap: 7.5, stageSpent: 7.094495, hostSpent: 10.094495 })); assert.equal(increased.complete, true); assert.equal(increased.stageCap, 7.5);
  assert.throws(() => validateLines(lines(complete, { stageCap: 7.5, stageSpent: 7.51, hostSpent: 10.51 })), /budget-overspend/);
});

test("all failed, over budget, missing terminal and inconsistent accounting never validate", () => {
  assert.throws(() => validateLines(lines({ ...complete, valid: 0, confirmed: 0, rejected: 0, downgraded: 0, failed: 10, cached: 0, attempted: 10, remaining: 10, ok: false, complete: false, reason: "InvalidConfirmationError" })), /no-valid-confirmations/);
  assert.throws(() => validateLines(lines(complete, { stageSpent: 5.01 })), /budget-overspend/);
  assert.throws(() => validateLines(lines(complete, { hostSpent: 10.76 })), /budget-overspend/);
  assert.throws(() => validateLines(lines().split("HOST_BUDGET:")[0]), /missing-terminal-lines/);
  assert.throws(() => validateLines(lines({ ...partial, accounted: 5 })), /inconsistent-accounting/);
  const mismatch = lines().replace(`ACCOUNTING: ${JSON.stringify(complete)}`, `ACCOUNTING: ${JSON.stringify({ ...complete, cached: 3 })}`);
  assert.throws(() => validateLines(mismatch), /terminal-accounting-mismatch/);
  assert.throws(() => validateLines(lines({ ...complete, total: 0 })), /inconsistent-accounting/);
});

test("terminal observer writes one private aggregate report without altering its ledger", async () => {
  const f = fixture(lines()); const printed = [];
  const ledgerPath = path.join(f.validation, "approved-budget-2026-10-23.json"); const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
  const report = await watchApproved({ dataDir: f.dataDir, offset: 0, pid: 123, log: line => printed.push(line) });
  assert.equal(report.complete, true); assert.equal(report.verifiedPrintedLines, true); assert.equal(report.verifiedLedger, true);
  assert.equal(printed.length, 1); assert.ok(printed[0].startsWith("REPORT: "));
  const reportPath = path.join(f.validation, "full-confirm-report.json");
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).valid, 10);
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
});

test("a current-run offset excludes an old successful terminal and preserves reservations after interruption", async () => {
  const old = lines(); const current = `CONFIRMATION: ${JSON.stringify({ stage: "full-confirm", valid: 1, total: 10 })}\n`;
  const f = fixture(old + current, 0.25); const printed = [];
  const report = await watchApproved({ dataDir: f.dataDir, offset: Buffer.byteLength(old), deathGraceMs: 0, isAlive: () => false, log: line => printed.push(line) });
  assert.equal(report.status, "interrupted"); assert.equal(report.complete, false); assert.equal(report.verifiedPrintedLines, false); assert.equal(report.valid, 1); assert.equal(report.remaining, 9); assert.equal(report.stageReserved, 0.25); assert.equal(report.hostReserved, 0.25); assert.equal(printed.length, 1);
});

test("unknown reservations remain unknown and cannot produce verified completion", async () => {
  const f = fixture(lines()); fs.writeFileSync(path.join(f.validation, "approved-budget-2026-10-23.json"), "{}");
  const report = await watchApproved({ dataDir: f.dataDir, offset: 0, log: () => {} });
  assert.equal(report.complete, false); assert.equal(report.status, "incomplete"); assert.equal(report.stageReserved, null); assert.equal(report.hostReserved, null); assert.equal(report.verifiedLedger, false);
});

test("floating-point reservation residue preserves the verified partial stop reason", async () => {
  const f = fixture(lines({ ...partial, reason: "TooLargeError" }));
  const ledgerPath = path.join(f.validation, "approved-budget-2026-10-23.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.stages.gold.reserved = 1.6306400674181987e-16;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const report = await watchApproved({ dataDir: f.dataDir, offset: 0, log: () => {} });
  assert.equal(report.status, "partial"); assert.equal(report.reason, "TooLargeError");
  assert.equal(report.complete, false); assert.equal(report.verifiedLedger, true);
  assert.equal(report.hostReserved, 1.6306400674181987e-16);
});

test("a significant outstanding reservation remains incomplete", async () => {
  const f = fixture(lines(partial), 0.25);
  const report = await watchApproved({ dataDir: f.dataDir, offset: 0, log: () => {} });
  assert.equal(report.status, "incomplete"); assert.equal(report.reason, "unsettled-reservations");
  assert.equal(report.complete, false); assert.equal(report.stageReserved, 0.25); assert.equal(report.verifiedLedger, true);
});

test("dead-process grace accepts terminal records flushed shortly afterwards", async () => {
  const f = fixture(""); let reported = 0;
  const running = watchApproved({ dataDir: f.dataDir, offset: 0, pid: 123, pollMs: 5, deathGraceMs: 100, isAlive: () => false, log: () => reported++ });
  await new Promise(resolve => setTimeout(resolve, 10)); fs.appendFileSync(path.join(f.validation, "approved-full-confirm.log"), lines());
  const report = await running; assert.equal(report.complete, true); assert.equal(reported, 1);
});
