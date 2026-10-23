// 07-UI-SPEC "Per-project report": gate first. Disclaimer, then the five
// decisions, then the checks. Every piece of the app's own evaluative text
// carries data-evaluative (the wording test reads those); raw gate statuses
// live only in data-gate-status. Stored text is rendered as React text only.
import type { CheckView, DecisionView, GateStatus, PublishedValue, ReportView } from "../../../report/view.ts";
import { cn } from "../../../lib/utils";

export const day = (iso: string) => iso.slice(0, 10);

const VERDICT: Record<GateStatus, { short: string; full: string; icon: string; marker: string }> = {
  PASS: {
    short: "Publicly evidenced",
    full: "Publicly evidenced for this decision.",
    icon: "icon-[lucide--circle-check]",
    marker: "bg-chart-blue",
  },
  INSUFFICIENT_EVIDENCE: {
    short: "Not publicly evidenced",
    full: "Not publicly evidenced for this decision. This does not mean it was not done.",
    icon: "icon-[lucide--circle-dashed]",
    marker: "bg-chart-neutral",
  },
  BLOCKED: {
    short: "Required check not met on own pages",
    full: "The project's own pages show a required check is not met.",
    icon: "icon-[lucide--circle-alert]",
    marker: "bg-foreground",
  },
};

const STATE: Record<"pass" | "claimed" | "unknown" | "fail" | "awaiting", { text: string; marker: string }> = {
  pass: { text: "publicly evidenced (artefact linked)", marker: "bg-chart-blue" },
  claimed: { text: "claimed, no artefact linked", marker: "bg-chart-red" },
  unknown: { text: "no public evidence found", marker: "bg-chart-neutral" },
  fail: { text: "own page shows the check is not met", marker: "bg-foreground" },
  awaiting: { text: "awaiting confirmation", marker: "bg-chart-neutral" },
};

export const AWAITING_TITLE =
  "A proposed positive has not been confirmed yet, so the gate treats it as no public evidence found.";

const stateKey = (p: PublishedValue) => p ?? "awaiting";

export const decisionAnchor = (id: string) => `decision-${id}`;
export const checkAnchor = (id: string) => `check-${id}`;

function Badge({ marker, title, children }: { marker: string; title?: string; children: string }) {
  return (
    <span
      data-evaluative=""
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[0.8125rem]"
    >
      <span className={cn("size-1 shrink-0", marker)} aria-hidden="true" />
      {children}
    </span>
  );
}

export function tallyLine(d: DecisionView): string {
  const t = d.tally;
  const terms = [
    [t.pass, "publicly evidenced"],
    [t.claimed, "claimed"],
    [t.unknown, "with no public evidence found"],
    [t.fail, "not met on own pages"],
    [t.awaiting, "awaiting confirmation"],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, words]) => `${n} ${words}`);
  return `Required checks: ${d.requiredChecks.length}. ${terms.join(", ")}.`;
}

export function ScopeDisclaimer({ collectedAt }: { collectedAt: string }) {
  return (
    <div data-scope-disclaimer="" data-evaluative="" className="mt-8 max-w-[75ch] rounded-lg border border-foreground bg-muted p-4">
      Private record for the judges and the company concerned. Do not publish. It describes only what this project's own
      website and repositories publicly evidenced when they were collected on {day(collectedAt)}. No other sources were
      used. Not publicly evidenced does not mean not done. This is not a certification or a legal assessment.
    </div>
  );
}

export function VerdictRow({ d }: { d: DecisionView }) {
  const v = VERDICT[d.status];
  return (
    <li data-verdict-row="" data-decision={d.decisionId} data-gate-status={d.status} className="min-h-12 border-b border-border py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-semibold">{d.label}</span>
        <span className="inline-flex items-center gap-1">
          <span className={cn(v.icon, "size-4")} aria-hidden="true" />
          <Badge marker={v.marker} title={v.full}>
            {v.short}
          </Badge>
        </span>
      </div>
      <p className="mt-1" data-evaluative="">
        {v.full}
      </p>
      <p className="mt-1 text-[0.8125rem] tabular-nums" data-evaluative="">
        {tallyLine(d)}
      </p>
      <p className="mt-1 text-[0.8125rem]">
        <a href={`#${decisionAnchor(d.decisionId)}`}>Show checks</a>
      </p>
    </li>
  );
}

export function CheckCard({ c }: { c: CheckView }) {
  const s = STATE[stateKey(c.published)];
  return (
    <article
      id={checkAnchor(c.checkId)}
      data-check-card=""
      data-check={c.checkId}
      data-state={stateKey(c.published)}
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 className="font-semibold">{c.label}</h4>
        <Badge marker={s.marker} title={c.published === null ? AWAITING_TITLE : undefined}>
          {s.text}
        </Badge>
      </div>
    </article>
  );
}

export function ReportBody({ view }: { view: ReportView }) {
  return (
    <>
      <ScopeDisclaimer collectedAt={view.collection.collectedAt} />
      <p className="mt-4 text-[0.8125rem] text-muted-foreground">
        Codebook <span className="font-mono">{view.codebookVersion}</span> · Gate{" "}
        <span className="font-mono">{view.gateSha.replace(/^js:/, "").slice(0, 7)}</span> · Collected{" "}
        {day(view.collection.collectedAt)} · {view.collection.pages} pages
      </p>
      <section aria-labelledby="decisions" data-decisions="" className="mt-12">
        <h2 id="decisions" className="text-[1.25rem] font-semibold">
          Decisions
        </h2>
        <ul className="mt-4">
          {view.decisions.map((d) => (
            <VerdictRow key={d.decisionId} d={d} />
          ))}
        </ul>
      </section>
      <section aria-labelledby="checks" className="mt-12">
        <h2 id="checks" className="text-[1.25rem] font-semibold">
          Checks
        </h2>
        {view.decisions.map((d) => (
          <div key={d.decisionId} className="mt-8">
            <h3 id={decisionAnchor(d.decisionId)} className="font-semibold">
              {d.label}
            </h3>
            <div className="mt-4 flex flex-col gap-6">
              {view.checks
                .filter((c) => c.decision === d.decisionId)
                .map((c) => (
                  <CheckCard key={c.checkId} c={c} />
                ))}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
