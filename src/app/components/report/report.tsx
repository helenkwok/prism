// 07-UI-SPEC "Per-project report": gate first. Disclaimer, then the five
// decisions, then the checks. Every piece of the app's own evaluative text
// carries data-evaluative (the wording test reads those); raw gate statuses
// live only in data-gate-status. Stored text is rendered as React text only.
import type { CheckView, DecisionView, GateStatus, PublishedValue, ReportView } from "../../../report/view.ts";
import { cn } from "../../../lib/utils";
import { Notice } from "../Notice";

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
export const NOT_RENDERED_SERVER =
  "This server collects pages without rendering, so text that a page loads with scripts may not have been captured.";
export const notRenderedCount = (n: number, pages: number) =>
  `${n} of ${pages} pages were collected without rendering, so text that a page loads with scripts may not have been captured.`;
export const INJECTION_NOTICE =
  "This page contained text addressed to an AI model. It was treated as page text and ignored as an instruction.";
export const NO_QUOTE = "No quote: no public evidence for this check was found on the collected pages.";

const STANDARD: Record<string, string> = {
  iso42001: "ISO/IEC 42001",
  gaicc: "GAICC AIMS",
  nistAiRmf: "NIST AI RMF",
  euAiAct: "EU AI Act",
  oecd: "OECD AI Principles",
};

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

const REDACTION = /(\[(?:email|phone|handle) redacted\]|\[(?:product|domain|repo|url)\]|▇▇)/;

/** Quote text as React text; redaction placeholders get their own span. */
function QuoteText({ text }: { text: string }) {
  return (
    <>
      {text.split(REDACTION).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="redaction rounded-sm bg-muted px-1 text-muted-foreground">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function snapshotHref(projectRef: string, hash: string, checkId: string, spanId: string) {
  return `/p/${encodeURIComponent(projectRef)}/snapshot/${hash}?check=${encodeURIComponent(checkId)}#span-${spanId}`;
}

export function QuoteCard({ q, projectRef, checkId }: { q: CheckView["quotes"][number]; projectRef: string; checkId: string }) {
  return (
    <figure data-quote-card="" data-span={q.spanId} className="border-l-4 border-border bg-card pl-4">
      <blockquote className="max-w-[75ch]">
        <QuoteText text={q.text} />
      </blockquote>
      {q.injectionFlagged ? (
        <Notice variant="info" className="mt-2 p-2 text-[0.8125rem]">
          <span data-injection="" data-evaluative="">
            {INJECTION_NOTICE}
          </span>
        </Notice>
      ) : null}
      <figcaption className="mt-2 flex flex-col gap-1 text-[0.8125rem]">
        {q.url ? (
          <span data-quote-url="" title={q.url} className="block max-w-full truncate font-mono">
            {q.url}
          </span>
        ) : null}
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {q.snapshotHash ? (
            <a href={snapshotHref(projectRef, q.snapshotHash, checkId, q.spanId)} className="inline-flex items-center gap-1">
              <span className="icon-[lucide--archive] size-4" aria-hidden="true" />
              Open archived snapshot
            </a>
          ) : null}
          {q.url ? (
            <a href={q.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1">
              <span className="icon-[lucide--external-link] size-4" aria-hidden="true" />
              Live page
            </a>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

export function CrosswalkChip({ chip }: { chip: CheckView["crosswalk"][number] }) {
  return (
    <span
      data-chip=""
      className={cn("inline-flex rounded-md border border-border px-2 py-0.5 text-[0.8125rem]", chip.informational && "border-dashed")}
    >
      {`${STANDARD[chip.standard] ?? chip.standard} ${chip.locator} · ${chip.relationType}${chip.informational ? " · informational" : ""}`}
    </span>
  );
}

const roleLine = (r: { role: string; modelId: string | null; host: string | null }) =>
  r.modelId ? `${r.role} (${r.modelId}, ${r.host ?? "host not recorded"})` : r.role;

/** 07-UI-SPEC "Basis lines". A confirmed check without its own record names the run's confirmation role. */
export function basisLine(c: CheckView, howMade: ReportView["howMade"]): string | null {
  switch (c.basis) {
    case "confirmed": {
      const rec = c.confirmations.findLast((r) => r.decision === "confirmed");
      if (!rec) return `Confirmed by the ${roleLine(howMade.confirmation)}.`;
      return `Confirmed by the ${roleLine({ role: rec.role, modelId: rec.modelId, host: howMade.confirmation.host })} on ${day(rec.decidedAt)}.`;
    }
    case "downgraded":
      return "Proposed as publicly evidenced; changed to claimed at confirmation.";
    case "rejected":
      return "Proposed as publicly evidenced; not confirmed.";
    case "unconfirmed":
      return "Awaiting confirmation.";
    case "stale":
      return "Confirmation is out of date: the collected evidence changed after it was confirmed.";
    default:
      return null;
  }
}

const cell = "border-t border-border px-2 py-1 align-top";

function ConfirmationRecords({ rows }: { rows: CheckView["confirmations"] }) {
  if (rows.length === 0) return null;
  return (
    <details>
      <summary className="text-[0.8125rem]">Confirmation records ({rows.length})</summary>
      <div className="mt-2 overflow-x-auto" role="region" aria-label="Confirmation records" tabIndex={0}>
        <table className="w-full border-collapse text-[0.8125rem] tabular-nums">
          <caption className="sr-only">Confirmation records for this check</caption>
          <thead className="bg-muted">
            <tr>
              {["Decision", "Role", "Model", "Time"].map((h) => (
                <th key={h} scope="col" className="px-2 py-1 text-left font-semibold tracking-[0.04em] uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className={cell}>{r.decision}</td>
                <td className={cell}>{r.role}</td>
                <td className={cn(cell, "font-mono")}>{r.modelId ?? "—"}</td>
                <td className={cell}>{r.decidedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function CheckCard({ c, projectRef, howMade }: { c: CheckView; projectRef: string; howMade: ReportView["howMade"] }) {
  const s = STATE[stateKey(c.published)];
  const basis = basisLine(c, howMade);
  return (
    <article
      id={checkAnchor(c.checkId)}
      data-check-card=""
      data-check={c.checkId}
      data-state={stateKey(c.published)}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 className="font-semibold">{c.label}</h4>
        <Badge marker={s.marker} title={c.published === null ? AWAITING_TITLE : undefined}>
          {s.text}
        </Badge>
      </div>
      {basis ? (
        <p data-basis="" data-evaluative="" className="text-[0.8125rem] text-muted-foreground">
          {basis}
        </p>
      ) : null}
      {c.quotes.length === 0 ? (
        <p data-no-quote="" data-evaluative="">
          {NO_QUOTE}
        </p>
      ) : (
        c.quotes.map((q) => <QuoteCard key={q.spanId} q={q} projectRef={projectRef} checkId={c.checkId} />)
      )}
      {c.crosswalk.length > 0 ? (
        <p className="flex flex-wrap gap-2">
          {c.crosswalk.map((chip) => (
            <CrosswalkChip key={`${chip.standard}-${chip.locator}`} chip={chip} />
          ))}
        </p>
      ) : null}
      {c.published !== "pass" && c.gapText ? (
        <div data-gap="">
          <p className="text-[0.8125rem] font-semibold tracking-[0.04em] uppercase">What would close this gap</p>
          <p className="max-w-[75ch]">{c.gapText}</p>
        </div>
      ) : null}
      <ConfirmationRecords rows={c.confirmations} />
    </article>
  );
}

export function ReportBody({ view }: { view: ReportView }) {
  const col = view.collection;
  const gate7 = view.gateSha.replace(/^js:/, "").slice(0, 7);
  return (
    <>
      <ScopeDisclaimer collectedAt={col.collectedAt} />
      <p className="mt-4 text-[0.8125rem] text-muted-foreground tabular-nums">
        Codebook <span className="font-mono">{view.codebookVersion}</span> · Gate <span className="font-mono">{gate7}</span> ·
        Collected {day(col.collectedAt)} · {col.pages} pages
      </p>
      {!col.renderAvailable || col.notRendered > 0 ? (
        <Notice variant="info" className="mt-4">
          <span data-not-rendered="" data-evaluative="">
            {col.renderAvailable ? notRenderedCount(col.notRendered, col.pages) : NOT_RENDERED_SERVER}
          </span>
        </Notice>
      ) : null}
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
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">
          Chips show how each check maps to a standard: addresses, supports or partial. EU AI Act mappings are informational.
        </p>
        {view.decisions.map((d) => (
          <div key={d.decisionId} className="mt-8">
            <h3 id={decisionAnchor(d.decisionId)} className="font-semibold">
              {d.label}
            </h3>
            <div className="mt-4 flex flex-col gap-6">
              {view.checks
                .filter((c) => c.decision === d.decisionId)
                .map((c) => (
                  <CheckCard key={c.checkId} c={c} projectRef={view.projectRef} howMade={view.howMade} />
                ))}
            </div>
          </div>
        ))}
      </section>
      <section aria-labelledby="how-made" className="mt-12">
        <h2 id="how-made" className="text-[1.25rem] font-semibold">
          How this report was made
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="font-semibold">Coding</dt>
          <dd>{roleLine(view.howMade.coding)}</dd>
          <dt className="font-semibold">Confirmation</dt>
          <dd>{roleLine(view.howMade.confirmation)}</dd>
          <dt className="font-semibold">Gate</dt>
          <dd>
            Deterministic gate, <span className="font-mono">{gate7}</span>
          </dd>
          <dt className="font-semibold">Collection</dt>
          <dd>Own website and own repositories only. robots.txt checked first.</dd>
          <dt className="font-semibold">Human edits</dt>
          <dd>{view.howMade.humanEdits}</dd>
        </dl>
      </section>
    </>
  );
}
