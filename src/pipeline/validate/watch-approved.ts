import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED_CAPS, APPROVED_OLLAMA_CAP } from "./approved-budget.ts";

const COUNTS = ["total", "accounted", "cached", "attempted", "valid", "failed", "stopped", "remaining", "awaitingGold", "confirmed", "rejected", "downgraded", "flagged", "excludedA3"] as const;
const STAGE_CAP = APPROVED_CAPS["full-confirm"];
const HOST_CAP = APPROVED_OLLAMA_CAP;
const EPSILON = 1e-9;
type RecordLine = { index: number; value: Record<string, any> };

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function money(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function records(lines: string[], prefix: string): RecordLine[] {
  return lines.flatMap((line, index) => {
    if (!line.startsWith(prefix)) return [];
    try {
      const value = JSON.parse(line.slice(prefix.length));
      return value && typeof value === "object" && !Array.isArray(value) ? [{ index, value }] : [];
    } catch { return []; }
  });
}

/** Only records after the caller's run-start byte offset may be supplied here. */
export function validateLines(input: string | string[]) {
  const lines = typeof input === "string" ? input.split("\n") : input;
  const detailed = (row: RecordLine) => row.value.stage === "full-confirm" && COUNTS.every(key => Number.isSafeInteger(row.value[key]) && row.value[key] >= 0);
  const accounting = records(lines, "ACCOUNTING: ").filter(detailed).at(-1);
  const confirmation = records(lines, "CONFIRMATION: ").filter(detailed).at(-1);
  const budget = records(lines, "BUDGET: ").at(-1);
  const host = records(lines, "HOST_BUDGET: ").at(-1);
  invariant(accounting && confirmation && budget && host, "missing-terminal-lines");
  invariant(host.index > accounting.index && host.index > confirmation.index && budget.index > accounting.index && budget.index > confirmation.index && host.index > budget.index, "missing-terminal-lines");
  const a = accounting.value;
  invariant([...COUNTS, "reason", "ok", "complete"].every(key => a[key] === confirmation.value[key]), "terminal-accounting-mismatch");
  invariant(a.total > 0 && a.valid === a.confirmed + a.rejected + a.downgraded && a.accounted === a.valid + a.failed && a.total === a.accounted + a.stopped && a.remaining === a.total - a.valid && a.cached <= a.valid && a.attempted >= a.valid - a.cached && a.attempted <= a.total - a.cached, "inconsistent-accounting");
  invariant(a.flagged <= a.total && typeof a.ok === "boolean" && typeof a.complete === "boolean" && a.ok === a.complete && (a.reason === null || typeof a.reason === "string"), "invalid-accounting-state");
  invariant(!(a.valid === 0 && a.failed > 0), "no-valid-confirmations");
  invariant(!a.complete || (a.valid === a.total && a.failed === 0 && a.stopped === 0 && a.remaining === 0 && a.awaitingGold === 0 && a.reason === null), "false-completion");
  invariant(a.complete || a.reason !== null || a.failed > 0 || a.awaitingGold > 0, "missing-stop-reason");
  for (const [row, cap] of [[budget.value, STAGE_CAP], [host.value, HOST_CAP]] as const) {
    invariant(money(row.estimated) && money(row.spent) && money(row.cap) && row.cap > 0 && row.cap <= cap && row.spent <= row.cap + EPSILON, "budget-overspend");
  }
  invariant(host.value.host === "ollama" && host.value.spent + EPSILON >= budget.value.spent, "host-budget-mismatch");
  return { status: a.complete ? "complete" as const : "partial" as const, complete: a.complete as boolean, reason: a.reason as string | null, total: a.total as number, accounted: a.accounted as number, valid: a.valid as number, failed: a.failed as number, remaining: a.remaining as number, stopped: a.stopped as number, cap: budget.value.cap as number, spent: budget.value.spent as number, stageCap: budget.value.cap as number, stageSpent: budget.value.spent as number, hostCap: host.value.cap as number, hostSpent: host.value.spent as number, verifiedPrintedLines: true as const };
}

type LedgerTotals = { stageSpent: number | null; stageReserved: number | null; hostSpent: number | null; hostReserved: number | null; verified: boolean };
function ledgerTotals(file: string): LedgerTotals {
  const unknown: LedgerTotals = { stageSpent: null, stageReserved: null, hostSpent: null, hostReserved: null, verified: false };
  try {
    const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
    const stage = ledger.stages?.["full-confirm"];
    if (!stage || !money(stage.spent) || !money(stage.reserved) || !money(stage.cap) || stage.cap > STAGE_CAP || stage.spent + stage.reserved > stage.cap + EPSILON) return unknown;
    let hostSpent = 0; let hostReserved = 0;
    for (const key of ["gold", "second-coder", "spike", "full-confirm"]) {
      const row = ledger.stages?.[key];
      if (!row) continue;
      if (!money(row.spent) || !money(row.reserved)) return unknown;
      hostSpent += row.spent; hostReserved += row.reserved;
    }
    return { stageSpent: stage.spent, stageReserved: stage.reserved, hostSpent, hostReserved, verified: hostSpent + hostReserved <= HOST_CAP + EPSILON };
  } catch { return unknown; }
}

export type WatchOptions = { dataDir?: string; offset: number; pid?: number; pollMs?: number; deathGraceMs?: number; log?: (line: string) => void; isAlive?: (pid: number) => boolean };

/** Passive observer: reads only the aggregate log, approved ledger and PID lock. */
export function watchApproved(options: WatchOptions): Promise<Record<string, unknown>> {
  invariant(Number.isSafeInteger(options.offset) && options.offset >= 0, "explicit-run-offset-required");
  if (options.pid !== undefined) invariant(Number.isSafeInteger(options.pid) && options.pid > 0, "invalid-run-pid");
  const dataDir = options.dataDir ?? path.join(os.homedir(), ".prism-data");
  const validation = path.join(dataDir, "validation");
  const ledgerPath = path.join(validation, "approved-budget-2026-10-23.json");
  const logPath = path.join(validation, "approved-full-confirm.log");
  const reportPath = path.join(validation, "full-confirm-report.json");
  const alive = options.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
  const log = options.log ?? console.log;
  let pid = options.pid;
  let deadSince: number | null = null;
  return new Promise(resolve => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let finished = false;
    const finish = (report: Record<string, unknown>) => {
      if (finished) return;
      finished = true; if (timer) clearInterval(timer);
      fs.mkdirSync(validation, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(reportPath, "w", 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify({ ...report, observedAt: new Date().toISOString(), runOffset: options.offset, pid: pid ?? null }, null, 2) + "\n"); }
      finally { fs.closeSync(fd); }
      log(`REPORT: ${JSON.stringify(report)}`); resolve(report);
    };
    const poll = () => {
      if (finished) return;
      const ledger = ledgerTotals(ledgerPath);
      let text = "";
      const incomplete = (status: string, reason: string) => {
        const latest = records(text.split("\n"), "CONFIRMATION: ").filter(row => row.value.stage === "full-confirm" && Number.isSafeInteger(row.value.valid) && Number.isSafeInteger(row.value.total) && row.value.valid >= 0 && row.value.valid <= row.value.total).at(-1)?.value;
        return { status, complete: false, reason, valid: latest?.valid ?? null, failed: null, total: latest?.total ?? null, remaining: latest ? latest.total - latest.valid : null, cap: STAGE_CAP, spent: ledger.stageSpent, hostCap: HOST_CAP, verifiedPrintedLines: false, ...ledger };
      };
      try {
        const bytes = fs.readFileSync(logPath);
        if (bytes.length < options.offset) { finish(incomplete("interrupted", "log-truncated")); return; }
        text = bytes.subarray(options.offset).toString("utf8");
      } catch { /* A missing or unflushed log is never evidence of success. */ }
      try {
        const result = validateLines(text);
        const consistent = ledger.verified && Math.abs(ledger.stageSpent! - result.stageSpent) <= EPSILON && Math.abs(ledger.hostSpent! - result.hostSpent) <= EPSILON;
        const settled = consistent && ledger.stageReserved! <= EPSILON && ledger.hostReserved! <= EPSILON;
        finish({ ...result, status: settled ? result.status : "incomplete", complete: result.complete && settled, reason: !consistent ? "ledger-not-verified" : !settled ? "unsettled-reservations" : result.reason, stageReserved: ledger.stageReserved, hostReserved: ledger.hostReserved, verifiedLedger: consistent });
        return;
      } catch (error) {
        if ((error as Error).message !== "missing-terminal-lines") { finish(incomplete("invalid", (error as Error).message)); return; }
      }
      if (pid === undefined) {
        try { const lock = fs.readFileSync(`${ledgerPath}.lock`, "utf8").trim(); if (/^[1-9]\d*$/.test(lock) && Number.isSafeInteger(Number(lock))) pid = Number(lock); } catch { /* Retain an already known PID after lock removal. */ }
      }
      if (pid !== undefined && alive(pid)) { deadSince = null; return; }
      deadSince ??= Date.now();
      if (Date.now() - deadSince >= (options.deathGraceMs ?? 30_000)) finish(incomplete("interrupted", pid === undefined ? "stage-lock-missing" : "process-ended-without-terminal-lines"));
    };
    poll();
    if (!finished) timer = setInterval(poll, options.pollMs ?? 15_000);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  invariant(value("--offset") !== undefined, "explicit-run-offset-required");
  await watchApproved({ offset: Number(value("--offset")), pid: value("--pid") === undefined ? undefined : Number(value("--pid")), dataDir: value("--data-dir") });
}
