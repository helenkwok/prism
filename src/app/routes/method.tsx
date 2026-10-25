// APP-03 / SC4 / 07-UI-SPEC "Method audit": agreement with the independent
// labeller, how projects were selected, the codebook and the confirmation
// records. Admin and judges only (07-03 Q3: hidden from company accounts); the
// loader's getMethodView opens with requireRole("admin", "judge"), so a company
// gets the 403 page. Confirmation rows arrive already reduced to one identity
// per row (title or pseudonym), decided on the server per viewer.
import type { ReactNode } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FIXTURE_NOTICE, Notice } from "../components/Notice";
import { CrosswalkChip } from "../components/report/report";
import { getMethodView } from "../server/report-fns.ts";
import type { CodebookEntry } from "../../report/method-view.ts";
import type { RoleLine } from "../../report/view.ts";
import { withBase } from "../lib/base";

export const Route = createFileRoute("/method")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  validateSearch: (s: Record<string, unknown>): { page?: number } => {
    const n = Number(s.page);
    return Number.isInteger(n) && n > 1 ? { page: n } : {};
  },
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => getMethodView({ data: { page: deps.page } }),
  component: MethodAudit,
});

export const NOT_LOADED = "Agreement figures appear here once validation is complete.";

const h2 = "mt-12 text-[1.25rem] leading-[1.2] font-semibold";
const th = "px-2 py-1 text-left text-[0.8125rem] font-semibold tracking-[0.04em] uppercase";
const td = "border-t border-border px-2 py-1 align-top";
const STATE_WORDS = {
  pass: "publicly evidenced (artefact linked)",
  claimed: "claimed, no artefact linked",
  fail: "own page shows the check is not met",
};
const roleLine = (r: RoleLine) => (r.modelId ? `${r.role} (${r.modelId}, ${r.host ?? "host not recorded"})` : r.role);
const two = (x: number) => x.toFixed(2);

function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse tabular-nums">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-muted">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Codebook({ entries }: { entries: CodebookEntry[] }) {
  return (
    <section aria-labelledby="codebook" data-codebook="">
      <h2 id="codebook" className={h2}>
        Codebook
      </h2>
      <div className="mt-4 flex flex-col gap-2">
        {entries.map((e) => (
          <details key={e.checkId} data-codebook-entry={e.checkId} className="rounded-xl border border-border bg-card p-4">
            <summary className="font-semibold">
              {e.label} · <span className="font-normal">{e.decisionLabel}</span>
            </summary>
            <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">Definition</dt>
              <dd className="max-w-[75ch]">{e.operationalDefinition}</dd>
              <dt className="font-semibold">{STATE_WORDS.pass}</dt>
              <dd className="max-w-[75ch]">{e.passRule}</dd>
              <dt className="font-semibold">{STATE_WORDS.claimed}</dt>
              <dd className="max-w-[75ch]">{e.claimedRule}</dd>
              <dt className="font-semibold">{STATE_WORDS.fail}</dt>
              <dd className="max-w-[75ch]">{e.failRule}</dd>
            </dl>
            {e.crosswalk.length ? (
              <p className="mt-4 flex flex-wrap gap-2">
                {e.crosswalk.map((chip) => (
                  <CrosswalkChip key={`${chip.standard}-${chip.locator}`} chip={chip} />
                ))}
              </p>
            ) : null}
            <div className="mt-4">
              <p className="text-[0.8125rem] font-semibold tracking-[0.04em] uppercase">What would close this gap</p>
              <p className="max-w-[75ch]">{e.gapText}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function Pager({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Confirmation record pages" className="mt-4 flex items-center gap-4">
      {page > 1 ? <a href={withBase(page === 2 ? "/method" : `/method?page=${page - 1}`)}>Previous</a> : null}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? <a href={withBase(`/method?page=${page + 1}`)}>Next</a> : null}
    </nav>
  );
}

function MethodAudit() {
  const m = Route.useLoaderData();
  return (
    <article data-method="">
      {m.loaded && m.fixture ? (
        <Notice variant="fixture" className="mb-8">
          <span data-evaluative="">{FIXTURE_NOTICE}</span>
        </Notice>
      ) : null}
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">Method audit</h1>

      <section aria-labelledby="agreement">
        <h2 id="agreement" className={h2}>
          Agreement with the independent labeller
        </h2>
        {m.loaded ? (
          <Table label="Agreement with the independent labeller, per check" head={["Check", "AC1 (95% CI)", "Pass precision (c of m)", "Labeller (model id, host)"]}>
            {m.agreement.rows.map((r) => (
              <tr key={r.checkId} data-agreement={r.checkId} data-state={r.state}>
                <td className={td}>{r.label}</td>
                {r.state === "released" && r.ac1 !== null && r.ac1CI && r.precision ? (
                  <>
                    <td className={td}>{`${two(r.ac1)} (${two(r.ac1CI[0])}–${two(r.ac1CI[1])})`}</td>
                    <td className={td}>{`${r.precision.c} of ${r.precision.m}`}</td>
                  </>
                ) : (
                  <td className={td} colSpan={2} data-explicit-state="">
                    {r.text}
                  </td>
                )}
                <td className={`${td} font-mono`}>{`${m.agreement.labeller.modelId ?? "not recorded"}, ${m.agreement.labeller.host ?? "host not recorded"}`}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p data-not-loaded="" className="mt-4">
            {NOT_LOADED}
          </p>
        )}
      </section>

      {m.loaded ? (
        <section aria-labelledby="selection">
          <h2 id="selection" className={h2}>
            How projects were selected
          </h2>
          <Table label="How projects were selected" head={["Stage", "Projects"]}>
            {m.prisma.map((p) => (
              <tr key={p.label} data-prisma="">
                <td className={td}>{p.label}</td>
                <td className={td}>{p.count.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </Table>
        </section>
      ) : null}

      <Codebook entries={m.codebook} />

      {m.loaded ? (
        <>
          <section aria-labelledby="confirmations">
            <h2 id="confirmations" className={h2}>
              Confirmation records
            </h2>
            <p className="mt-2 text-[0.8125rem] text-muted-foreground">
              A project you cannot open identifiably is shown only by its pseudonym. {m.confirmations.total} records.
            </p>
            <Table label="Confirmation records" head={["Project", "Check", "Proposed", "Decision", "Role", "Model", "Time"]}>
              {m.confirmations.rows.map((r, i) => (
                <tr key={i} data-confirmation="" data-identifiable={r.identifiable ? "true" : "false"}>
                  <td className={td}>{r.project}</td>
                  <td className={td}>{r.checkLabel}</td>
                  <td className={td}>{STATE_WORDS[r.proposed]}</td>
                  <td className={td}>{r.decision}</td>
                  <td className={td}>{r.role}</td>
                  <td className={`${td} font-mono`}>{r.modelId ?? "—"}</td>
                  <td className={td}>{r.decidedAt}</td>
                </tr>
              ))}
            </Table>
            <Pager page={m.confirmations.page} pages={m.confirmations.pages} />
          </section>
          <section aria-labelledby="how-made">
            <h2 id="how-made" className={h2}>
              How this report was made
            </h2>
            <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">Coding</dt>
              <dd>{roleLine(m.howMade.coding)}</dd>
              <dt className="font-semibold">Confirmation</dt>
              <dd>{roleLine(m.howMade.confirmation)}</dd>
              <dt className="font-semibold">Agreement</dt>
              <dd>{`Agreement with an independent labeller: ${roleLine(m.howMade.labeller)}`}</dd>
              <dt className="font-semibold">Codebook</dt>
              <dd className="font-mono">{m.howMade.codebookVersion}</dd>
              <dt className="font-semibold">Gate</dt>
              <dd>
                Deterministic gate, <span className="font-mono">{m.howMade.gateSha.replace(/^js:/, "").slice(0, 7)}</span>
              </dd>
            </dl>
          </section>
        </>
      ) : null}
    </article>
  );
}
