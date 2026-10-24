import { APPROVED_CAPS } from "./approved-budget.ts";

/** The reported included balance must fund the entire remaining authorized run, without top-ups. */
export function assertIncludedCredit(approval: any, projectedTotal: number, spent: number): { available: number; projectedRemaining: number } {
  const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!approval || approval.version !== 1 || approval.approvalDate !== "2026-10-24" || approval.source !== "user-dashboard" ||
      approval.provider !== "ollama" || approval.model !== "nemotron-3-ultra:cloud" || approval.thinking !== true ||
      approval.funding !== "included-only" || approval.autoReload !== false || approval.creditPurchaseAllowed !== false ||
      approval.oauthGrantAllowed !== false || approval.refillAfterDeadline !== true || approval.runCap !== APPROVED_CAPS["full-confirm"] ||
      !amount(approval.includedBalanceUsd) || !amount(approval.runSpentAtBalanceUsd) || !amount(spent) || !amount(projectedTotal) ||
      spent + 1e-9 < approval.runSpentAtBalanceUsd || projectedTotal + 1e-9 < spent) throw new Error("current included-credit approval required");
  const available = approval.includedBalanceUsd - (spent - approval.runSpentAtBalanceUsd);
  const projectedRemaining = projectedTotal - spent;
  if (available + 1e-9 < projectedRemaining || available + 1e-9 < APPROVED_CAPS["full-confirm"] - spent) {
    const error = new Error("included credit cannot fund the remaining approved run without purchased credit");
    error.name = "IncludedCreditExceededError"; throw error;
  }
  return { available, projectedRemaining };
}
