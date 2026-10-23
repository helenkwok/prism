// APP-01 / 07-UI-SPEC "Project list": the role-scoped list, server-rendered from
// listProjects (the server filters; this page only renders what it is sent).
import type { ReactNode } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FIXTURE_NOTICE, Notice } from "../components/Notice";
import { listProjects } from "../server/list-fns.ts";
import type { DeidentifiedRow, IdentifiableRow, ProjectList } from "../server/list-fns.ts";

export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { page?: number } => {
    const n = Number(s.page);
    return Number.isInteger(n) && n > 1 ? { page: n } : {};
  },
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => listProjects({ data: { page: deps.page } }),
  component: Home,
});

const WHY: Record<string, string> = {
  own: "Owner's project",
  "opt-in": "Opted in",
  "well-known": "Well-known company (protocol §11)",
};

const decisions = (k: number | null) => (k === null ? "—" : `Publicly evidenced for ${k} of 5`);

const th = "px-2 py-1 text-left text-[0.8125rem] font-semibold tracking-[0.04em] uppercase";
const td = "border-t border-border px-2 py-1 align-top";

function Table({ label, caption, head, children }: { label: string; caption: string; head: string[]; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-4 overflow-x-auto" data-table-wrapper="">
      <table className="w-full min-w-[560px] border-collapse tabular-nums">
        <caption className="sr-only">{caption}</caption>
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

function AdminTable({ rows }: { rows: IdentifiableRow[] }) {
  return (
    <Table label="All projects" caption="All projects the access table knows" head={["Project", "Access", "Decisions", "Updated", "Review"]}>
      {rows.map((r) => (
        <tr key={r.projectId}>
          <td className={td}>
            <a href={`/p/${encodeURIComponent(r.projectId)}`}>{r.title}</a>
          </td>
          <td className={td}>
            {r.basis ?? "de-identified only"}
            {r.sponsorHold ? <span className="ml-2 rounded-md border border-border px-2 py-0.5 text-[0.8125rem]">sponsor hold</span> : null}
          </td>
          <td className={td}>{decisions(r.passCount)}</td>
          <td className={td}>{r.updated ?? "—"}</td>
          <td className={td}>{r.reviewN ? <a href={`/review/${r.reviewN}`}>Review trail</a> : null}</td>
        </tr>
      ))}
    </Table>
  );
}

function IdentifiableTable({ rows, why }: { rows: IdentifiableRow[]; why: boolean }) {
  const head = why ? ["Project", "Why identifiable", "Decisions", "Updated"] : ["Project", "Decisions", "Updated"];
  return (
    <Table label="Identifiable records" caption="Identifiable records" head={head}>
      {rows.map((r) => (
        <tr key={r.projectId}>
          <td className={td}>
            <a href={`/p/${encodeURIComponent(r.projectId)}`}>{r.title}</a>
          </td>
          {why ? <td className={td}>{r.basis ? WHY[r.basis] : null}</td> : null}
          <td className={td}>{decisions(r.passCount)}</td>
          <td className={td}>{r.updated ?? "—"}</td>
        </tr>
      ))}
    </Table>
  );
}

function DeidentifiedTable({ rows }: { rows: DeidentifiedRow[] }) {
  return (
    <Table label="De-identified records" caption="De-identified records" head={["Project", "Decisions", "Collected"]}>
      {rows.map((r) => (
        <tr key={r.pseudonym}>
          <td className={td}>
            <a href={`/j/${encodeURIComponent(r.pseudonym)}`}>Project {r.pseudonym}</a>
          </td>
          <td className={td}>{decisions(r.passCount)}</td>
          <td className={td}>{r.collected ?? "—"}</td>
        </tr>
      ))}
    </Table>
  );
}

function Empty({ role }: { role: string }) {
  return (
    <section className="mt-8">
      <h2 className="text-[1.25rem] leading-[1.2] font-semibold">No records yet</h2>
      {role === "company" ? (
        <p className="mt-2">No project is linked to this account yet. Ask the person who issued your account.</p>
      ) : (
        <>
          <p className="mt-2">
            Records appear here once the sample's results are confirmed and loaded. The method audit is available now.
          </p>
          <p className="mt-2 flex gap-4">
            <a href="/method">Open the method audit</a>
            {role === "admin" ? <a href="/run">Run PRISM on one URL</a> : null}
          </p>
        </>
      )}
    </section>
  );
}

function Pager({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="mt-8 flex items-center gap-4">
      {page > 1 ? <a href={page === 2 ? "/" : `/?page=${page - 1}`}>Previous</a> : null}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? <a href={`/?page=${page + 1}`}>Next</a> : null}
    </nav>
  );
}

function Home() {
  const list: ProjectList = Route.useLoaderData();
  const h2 = "mt-12 text-[1.25rem] leading-[1.2] font-semibold";
  const ident = list.identifiable;
  const deid = list.deidentified;
  const empty = ident.total === 0 && (deid?.total ?? 0) === 0;
  return (
    <>
      {list.fixture ? <Notice variant="fixture" className="mb-8">{FIXTURE_NOTICE}</Notice> : null}
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">Your projects</h1>
      {empty ? (
        <Empty role={list.role} />
      ) : list.role === "judge" && deid ? (
        <>
          <h2 className={h2}>Identifiable records</h2>
          {ident.rows.length ? <IdentifiableTable rows={ident.rows} why /> : <p className="mt-4">None on this page.</p>}
          <h2 className={h2}>De-identified records</h2>
          {deid.rows.length ? <DeidentifiedTable rows={deid.rows} /> : <p className="mt-4">None on this page.</p>}
        </>
      ) : list.role === "admin" ? (
        <AdminTable rows={ident.rows} />
      ) : (
        <IdentifiableTable rows={ident.rows} why={false} />
      )}
      <Pager page={list.page} pages={list.pages} />
    </>
  );
}
