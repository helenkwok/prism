// APP-03 / D-81 / 07-UI-SPEC: the de-identified record, addressed by pseudonym
// only. The loader's server function opens with requireProjectAccess("deidentified"),
// so a company (never given this view) or an unknown pseudonym is a real 403.
// The page renders only the stored de-identified row: no title, URL, host,
// snapshot link or HN id exists in it to leak.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FIXTURE_NOTICE, Notice } from "../components/Notice";
import { ReportBody } from "../components/report/report";
import { getDeidentifiedReport } from "../server/report-fns.ts";

export const Route = createFileRoute("/j/$pseudonym")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: ({ params }) => getDeidentifiedReport({ data: { pseudonym: params.pseudonym } }),
  component: DeidentifiedPage,
});

function DeidentifiedPage() {
  const view = Route.useLoaderData();
  return (
    <article data-report="deidentified">
      {view.fixture ? (
        <Notice variant="fixture" className="mb-8">
          <span data-evaluative="">{FIXTURE_NOTICE}</span>
        </Notice>
      ) : null}
      <p className="text-[0.8125rem] font-semibold tracking-[0.12em] text-accent-ink uppercase">PRISM · De-identified record</p>
      <h1 className="mt-2 text-[2rem] leading-[1.15] font-semibold">De-identified project {view.projectRef}</h1>
      <ReportBody view={view} />
    </article>
  );
}
