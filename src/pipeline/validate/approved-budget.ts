import fs from "node:fs";
import path from "node:path";
import { DollarBudget, type BudgetState } from "../coding/spend-guards.ts";

export const APPROVED_CAPS = { signoff: 3.50, recode: 3.80, gold: 4.50, "second-coder": .75, spike: .50, "full-confirm": 5 } as const;
export type ApprovedStage = keyof typeof APPROVED_CAPS;
type Ledger = { approval: string; stages: Partial<Record<ApprovedStage, BudgetState>> };
const hostOf = (stage: ApprovedStage) => stage === "signoff" || stage === "recode" ? "token-factory" : "ollama";

/** Persist reservations before HTTP; on resume unresolved reservations count as spent. */
export function openApprovedBudget(dataDir: string, stage: ApprovedStage) {
  const dir = path.join(dataDir, "validation");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "approved-budget-2026-10-23.json");
  const lockFile = `${file}.lock`;
  const lock = fs.openSync(lockFile, "wx", 0o600);
  fs.writeFileSync(lock, String(process.pid));
  try {
    const ledger: Ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { approval: "2026-10-23", stages: {} };
    if (ledger.approval !== "2026-10-23") throw new Error("budget approval mismatch");
    const charged = (state?: BudgetState) => state ? state.spent + state.reserved : 0;
    for (const [key, state] of Object.entries(ledger.stages)) {
      // Helen's explicit cap increase retains every prior charge and reservation.
      if (key === "recode" && state?.cap === 3.50) state.cap = APPROVED_CAPS.recode;
      if (!(key in APPROVED_CAPS) || !state || state.cap !== APPROVED_CAPS[key as ApprovedStage] ||
          ![state.estimated, state.spent, state.reserved].every(n => Number.isFinite(n) && n >= 0)) throw new Error("invalid persisted budget");
    }
    const host = hostOf(stage);
    const hostSpent = Object.entries(ledger.stages).reduce((sum, [key, state]) => sum + (hostOf(key as ApprovedStage) === host ? charged(state) : 0), 0);
    const parent = new DollarBudget(host === "ollama" ? 10.75 : 3.80, { initialSpent: hostSpent });
    const persist = (state: BudgetState) => {
      ledger.stages[stage] = state;
      const next = `${file}.next`;
      const fd = fs.openSync(next, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(next, file);
    };
    const budget = new DollarBudget(APPROVED_CAPS[stage], { parent, initialSpent: charged(ledger.stages[stage]), onChange: persist });
    persist({ ...budget.snapshot(), reserved: 0 });
    let released = false;
    return { budget, parent, host, file, release() { if (!released) { released = true; fs.closeSync(lock); fs.unlinkSync(lockFile); } } };
  } catch (error) {
    fs.closeSync(lock); fs.unlinkSync(lockFile); throw error;
  }
}
