import fs from "node:fs";
import path from "node:path";
import { DollarBudget, type BudgetState } from "../coding/spend-guards.ts";

export const APPROVED_CAPS = { signoff: 3.50, recode: 3.80, gold: 4.50, "second-coder": .75, spike: .50, "full-confirm": 7.50, "irrelevant-probe": 1 } as const;
export const APPROVED_OLLAMA_CAP = 10.75;
export type ApprovedStage = keyof typeof APPROVED_CAPS;
type Ledger = { approval: string; stages: Partial<Record<ApprovedStage, BudgetState>> };
const hostOf = (stage: ApprovedStage) => stage === "signoff" || stage === "recode" ? "token-factory" : "ollama";

/** Only the explicitly approved prior caps migrate; every accounting field is preserved. */
export function migrateApprovedStageCap(stage: string, state: BudgetState): void {
  if (stage === "recode" && state.cap === 3.50) state.cap = APPROVED_CAPS.recode;
  if (stage === "full-confirm" && (state.cap === 5 || state.cap === 7)) state.cap = APPROVED_CAPS["full-confirm"];
}

/** Persist reservations before HTTP; on resume unresolved reservations count as spent. */
export function openApprovedBudget(dataDir: string, stage: ApprovedStage) {
  const dir = path.join(dataDir, "validation");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "approved-budget-2026-10-23.json");
  const lockFile = `${file}.lock`;
  let lock: number;
  try { lock = fs.openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const before = fs.statSync(lockFile);
    const owner = Number(fs.readFileSync(lockFile, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("invalid budget lease owner");
    let alive = true;
    try { process.kill(owner, 0); } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      alive = false;
    }
    if (alive) throw error;
    if (fs.statSync(lockFile).ino !== before.ino) throw new Error("budget lease changed during recovery");
    fs.unlinkSync(lockFile);
    lock = fs.openSync(lockFile, "wx", 0o600);
  }
  fs.writeFileSync(lock, String(process.pid));
  try {
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { approval: "2026-10-23", stages: {} };
    if (ledger.approval !== "2026-10-23") throw new Error("budget approval mismatch");
    const charged = (state?: BudgetState) => state ? state.spent + state.reserved : 0;
    for (const [key, state] of Object.entries(ledger.stages)) {
      // Helen's explicit cap increase retains every prior charge and reservation.
      if (state) migrateApprovedStageCap(key, state);
      if (!(key in APPROVED_CAPS) || !state || state.cap !== APPROVED_CAPS[key as ApprovedStage] ||
          ![state.estimated, state.spent, state.reserved].every(n => Number.isFinite(n) && n >= 0)) throw new Error("invalid persisted budget");
    }
    const host = hostOf(stage);
    const hostSpent = Object.entries(ledger.stages).reduce((sum, [key, state]) => sum + (hostOf(key as ApprovedStage) === host ? charged(state) : 0), 0);
    const parent = new DollarBudget(host === "ollama" ? APPROVED_OLLAMA_CAP : 3.80, { initialSpent: hostSpent });
    parent.estimated = Object.entries(ledger.stages).reduce((sum, [key, state]) => sum + (hostOf(key as ApprovedStage) === host ? state!.estimated : 0), 0);
    const persist = (state: BudgetState) => {
      ledger.stages[stage] = state;
      const next = `${file}.next`;
      const fd = fs.openSync(next, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(next, file);
    };
    const budget = new DollarBudget(APPROVED_CAPS[stage], { parent, initialSpent: charged(ledger.stages[stage]), onChange: persist });
    budget.estimated = ledger.stages[stage]?.estimated ?? 0;
    persist({ ...budget.snapshot(), reserved: 0 });
    let released = false;
    return { budget, parent, host, file, release() { if (!released) { released = true; fs.closeSync(lock); fs.unlinkSync(lockFile); } } };
  } catch (error) {
    fs.closeSync(lock); fs.unlinkSync(lockFile); throw error;
  }
}
