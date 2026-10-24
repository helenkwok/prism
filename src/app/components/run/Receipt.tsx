// J2: the run receipt, on the job page and at the end of a live run's report. Built from the
// usage rows (app_job_usage): model, provider, key source, tokens and list-price dollars. No keys.
import type { RunReceipt } from "../../server/live-options.ts";

const STAGE_WORD: Record<string, string> = { screen: "Screen", collect: "Collect", code: "Code", gate: "Gate", confirm: "Confirm positives", report: "Report" };
const usd = (n: number) => `$${n.toFixed(4)}`;
const int = (n: number) => n.toLocaleString("en-US");
const th = "px-2 py-1 text-left text-[0.8125rem] font-semibold tracking-[0.04em] uppercase";
const td = "border-t border-border px-2 py-1 align-top";

export function Receipt({ receipt, collector }: { receipt: RunReceipt; collector?: string }) {
  return (
    <section aria-labelledby="run-receipt" className="mt-12" data-receipt="">
      <h2 id="run-receipt" className="text-[1.25rem] font-semibold">
        Run receipt
      </h2>
      {collector ? <p className="mt-2">Evidence collector: {collector}.</p> : null}
      {receipt.tavily ? (
        <p className="mt-2 tabular-nums" data-receipt-tavily="">
          Tavily: {receipt.tavily.credits} credits, paid with {receipt.tavily.paidBy}.
        </p>
      ) : null}
      {receipt.lines.length === 0 ? (
        <p className="mt-2">No model calls were made.</p>
      ) : (
        <div role="region" aria-label="Run receipt" tabIndex={0} className="mt-4 overflow-x-auto" data-table-wrapper="">
          <table className="w-full min-w-[640px] border-collapse tabular-nums">
            <caption className="sr-only">Model calls by stage, at list price</caption>
            <thead className="bg-muted">
              <tr>
                {["Stage", "Model", "Provider", "Paid with", "Calls", "Tokens in", "Tokens out", "Cost"].map((h) => (
                  <th key={h} scope="col" className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={`${l.stage}|${l.model}`}>
                  <td className={td}>{STAGE_WORD[l.stage] ?? l.stage}</td>
                  <td className={td}>{l.model}</td>
                  <td className={td}>{l.provider}</td>
                  <td className={td}>{l.paidBy}</td>
                  <td className={td}>{int(l.calls)}</td>
                  <td className={td}>{int(l.tokensIn)}</td>
                  <td className={td}>{int(l.tokensOut)}</td>
                  <td className={td}>{usd(l.usd)}</td>
                </tr>
              ))}
              <tr className="font-semibold" data-receipt-total="">
                <td className={td} colSpan={4}>
                  Total
                </td>
                <td className={td}>{int(receipt.total.calls)}</td>
                <td className={td}>{int(receipt.total.tokensIn)}</td>
                <td className={td}>{int(receipt.total.tokensOut)}</td>
                <td className={td}>{usd(receipt.total.usd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {receipt.lines.length ? (
        <p className="mt-2 text-[0.8125rem]" data-ultra-estimate="">
          Same run with Nemotron 3 Ultra for every model step: {usd(receipt.ultraEstimateUsd)} (estimate: this run's token counts at Ultra's Token Factory list price).
        </p>
      ) : null}
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">Costs are list prices for the tokens each call reported.</p>
    </section>
  );
}
