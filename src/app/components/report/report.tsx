// 07-UI-SPEC "Per-project report": gate first. Disclaimer, then the five
// decisions, then the checks. Every piece of the app's own evaluative text
// carries data-evaluative (the wording test reads those); raw gate statuses
// live only in data-gate-status. Stored text is rendered as React text only.
import type { DeidentifiedView } from "../../../report/deidentify.ts";
import type { CheckView, DecisionView, GateStatus, PublishedValue, ReportView } from "../../../report/view.ts";
import { cn } from "../../../lib/utils";
import { Notice } from "../Notice";
import { Receipt } from "../run/Receipt";

export const day = (iso: string) => iso.slice(0, 10);

export const VERDICT: Record<GateStatus, { short: string; full: string; icon: string; marker: string }> = {
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

export const DEID_FIGCAPTION = "Source page and snapshot withheld in de-identified records.";
export const MASKING_LEGEND =
  "[product] product name · [domain] web address · [repo] code repository · [url] link · ▇▇ a word that could identify the project · … quote shortened to 40 words · [email redacted], [phone redacted], [handle redacted] personal details removed when the page was collected.";

export function ScopeDisclaimer({ collectedAt, masked = false }: { collectedAt: string; masked?: boolean }) {
  return (
    <div data-scope-disclaimer="" data-evaluative="" className="mt-8 max-w-[75ch] rounded-lg border border-foreground bg-muted p-4">
      {masked
        ? `De-identified record for the judges. Do not publish. It describes what one sampled project's own website and repositories publicly evidenced when they were collected on ${day(collectedAt)}. Names, web addresses and distinctive wording are masked. Not publicly evidenced does not mean not done.`
        : `Private record for the judges and the company concerned. Do not publish. It describes only what this project's own website and repositories publicly evidenced when they were collected on ${day(collectedAt)}. No other sources were used. Not publicly evidenced does not mean not done. This is not a certification or a legal assessment.`}
    </div>
  );
}

export const NOTHING_TO_ADD = "Nothing to add for this decision: every required check is publicly evidenced.";
export const ACTION_HEADING = "What would change it";

/** J1: the gap text of each required check that is not publicly evidenced, in gate order. */
export function actionItems(d: DecisionView, checks: AnyCheck[]): { checkId: string; label: string; text: string }[] {
  return d.requiredChecks.flatMap((id) => {
    const c = checks.find((x) => x.checkId === id);
    return c && c.published !== "pass" && c.gapText ? [{ checkId: id, label: c.label, text: c.gapText }] : [];
  });
}

/**
 * J1 (judges' review): each decision leads with its verdict and then what would change it;
 * the checks and quotes behind it follow in a native <details> (closed on screen, printed open).
 */
export function VerdictRow({ d, checks, projectRef, howMade }: { d: DecisionView; checks: AnyCheck[]; projectRef: string; howMade: ReportView["howMade"] }) {
  const v = VERDICT[d.status];
  const actions = actionItems(d, checks);
  const evidence = checks.filter((c) => c.decision === d.decisionId);
  return (
    <li id={decisionAnchor(d.decisionId)} data-verdict-row="" data-decision={d.decisionId} data-gate-status={d.status} className="min-h-12 border-b border-border py-4">
      <div data-verdict-head="">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="font-semibold">{d.label}</h3>
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
        <div data-action="" className="mt-3 max-w-[75ch] border-l-4 border-accent-ink pl-4">
          <p data-evaluative="" className="text-[0.8125rem] font-semibold tracking-[0.04em] uppercase">
            {ACTION_HEADING}
          </p>
          {actions.length === 0 ? (
            <p data-evaluative="" className="mt-1">
              {NOTHING_TO_ADD}
            </p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1">
              {actions.map((a) => (
                <li key={a.checkId} data-action-item={a.checkId}>
                  <span className="font-semibold">{`${a.label.replace(/\.$/, "")}:`}</span> <span data-action-gap="">{a.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="mt-2 text-[0.8125rem] tabular-nums" data-evaluative="">
          {tallyLine(d)}
        </p>
      </div>
      {evidence.length ? (
        <details data-evidence="" className="mt-3">
          <summary data-print-hide="" className="text-[0.8125rem]">
            {`Evidence: ${evidence.length} ${evidence.length === 1 ? "check" : "checks"}, with quotes`}
          </summary>
          <div data-check-group="" className="mt-4 flex flex-col gap-6">
            {evidence.map((c) => (
              <CheckCard key={c.checkId} c={c} projectRef={projectRef} howMade={howMade} />
            ))}
          </div>
        </details>
      ) : null}
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

type AnyCheck = CheckView | DeidentifiedView["checks"][number];
type AnyQuote =CheckView["quotes"][number] | DeidentifiedView["checks"][number]["quotes"][number];

export function QuoteCard({ q, projectRef, checkId }: { q: AnyQuote; projectRef: string; checkId: string }) {
  // A de-identified quote carries no url or snapshot hash: its caption says so and links nowhere.
  const src = "url" in q ? q : null;
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
      {src ? (
        <figcaption className="mt-2 flex flex-col gap-1 text-[0.8125rem]">
          {src.url ? (
            <span data-quote-url="" title={src.url} className="block max-w-full truncate font-mono">
              {src.url}
            </span>
          ) : null}
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {src.snapshotHash ? (
              <a href={snapshotHref(projectRef, src.snapshotHash, checkId, q.spanId)} className="inline-flex items-center gap-1">
                <span className="icon-[lucide--archive] size-4" aria-hidden="true" />
                Open archived snapshot
              </a>
            ) : null}
            {src.url ? (
              <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1">
                <span className="icon-[lucide--external-link] size-4" aria-hidden="true" />
                Live page
              </a>
            ) : null}
          </span>
        </figcaption>
      ) : (
        <figcaption data-withheld="" className="mt-2 text-[0.8125rem] text-muted-foreground">
          {DEID_FIGCAPTION}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * The locator's leading word is dropped when the short name already ends with it or its plural:
 * "GAICC AIMS" + "AIMS artefact: Scope" reads "GAICC AIMS artefact: Scope",
 * "OECD AI Principles" + "Principle 1.3" reads "OECD AI Principles 1.3". Display only.
 */
function chipName(standard: string, locator: string) {
  const name = STANDARD[standard] ?? standard;
  const last = name.split(" ").at(-1);
  const [lead, ...rest] = locator.split(" ");
  return rest.length && (lead === last || `${lead}s` === last) ? `${name} ${rest.join(" ")}` : `${name} ${locator}`;
}

export function CrosswalkChip({ chip }: { chip: CheckView["crosswalk"][number] }) {
  return (
    <span
      data-chip=""
      className={cn("inline-flex rounded-md border border-border px-2 py-0.5 text-[0.8125rem]", chip.informational && "border-dashed")}
    >
      {`${chipName(chip.standard, chip.locator)} · ${chip.relationType}${chip.informational ? " · informational" : ""}`}
    </span>
  );
}

const roleLine = (r: { role: string; modelId: string | null; host: string | null }) =>
  r.modelId ? `${r.role} (${r.modelId}, ${r.host ?? "host not recorded"})` : r.role;

/** 07-UI-SPEC "Basis lines". A confirmed check without its own record names the run's confirmation role. */
export function basisLine(c: AnyCheck,howMade: ReportView["howMade"]): string | null {
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
    // A closed <details> prints only its toggle, so the whole block is screen-only.
    <details data-print-hide="">
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

export function CheckCard({ c, projectRef, howMade }: { c: AnyCheck; projectRef: string; howMade: ReportView["howMade"] }) {
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

/** Identifiable (/p) or de-identified (/j): one anatomy; the masked mode changes only the disclaimer, legend and quote captions. */
export function ReportBody({ view }: { view: ReportView | DeidentifiedView }) {
  const masked = view.view === "deidentified";
  const col = view.collection;
  const gate7 = view.gateSha.replace(/^js:/, "").slice(0, 7);
  return (
    <>
      <ScopeDisclaimer collectedAt={col.collectedAt} masked={masked} />
      <p className="mt-4 text-[0.8125rem] text-muted-foreground tabular-nums">
        Codebook <span className="font-mono">{view.codebookVersion}</span> · Gate <span className="font-mono">{gate7}</span> ·
        Collected {day(col.collectedAt)} · {col.pages} pages
      </p>
      {masked ? (
        <details data-masking-legend="" className="mt-4 max-w-[75ch] text-[0.8125rem]">
          <summary>How this record is masked</summary>
          {/* Placeholders styled as in the quotes, so the legend shows what a redaction looks like. */}
          <p className="mt-2">
            <QuoteText text={MASKING_LEGEND} />
          </p>
        </details>
      ) : null}
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
        <p className="mt-2 max-w-[75ch] text-[0.8125rem] text-muted-foreground">
          Each decision shows the verdict, then what would change it. Open the evidence to see the checks and quotes behind it.
          Chips show how each check maps to a standard: addresses, supports or partial. EU AI Act mappings are informational.
        </p>
        <ul className="mt-4">
          {view.decisions.map((d) => (
            <VerdictRow key={d.decisionId} d={d} checks={view.checks} projectRef={view.projectRef} howMade={view.howMade} />
          ))}
        </ul>
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
      {view.howMade.run?.receipt ? <Receipt receipt={view.howMade.run.receipt} collector={view.howMade.run.collector} /> : null}
    </>
  );
}
