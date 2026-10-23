// APP-04 / 07-UI-SPEC: the identifiable per-project report, gate first. The
// loader's server function opens with requireProjectAccess("identifiable"), so
// a refused or missing project is a real 403 with the one 403 page.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FIXTURE_NOTICE, Notice } from "../components/Notice";
import { ReportBody } from "../components/report/report";
import { getIdentifiableReport } from "../server/report-fns.ts";

export const Route = createFileRoute("/p/$projectId")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: ({ params }) => getIdentifiableReport({ data: { projectId: params.projectId } }),
  component: ReportPage,
});

function ReportPage() {
  const view = Route.useLoaderData();
  return (
    <article data-report="identifiable">
      {view.fixture ? (
        <Notice variant="fixture" className="mb-8">
          <span data-evaluative="">{FIXTURE_NOTICE}</span>
        </Notice>
      ) : null}
      <p className="text-[0.8125rem] font-semibold tracking-[0.12em] text-accent-ink uppercase">PRISM · Private report</p>
      <h1 className="mt-2 text-[2rem] leading-[1.15] font-semibold">{view.title}</h1>
      <ReportBody view={view} />
    </article>
  );
}
