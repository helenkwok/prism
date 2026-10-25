// 07-UI-SPEC "Snapshot view": the archived text of one page with the cited
// spans marked by exact match. Guarded like the report (getSnapshot opens with
// requireProjectAccess("identifiable")). The archived HTML is never embedded;
// the stored text is rendered as React text only.
import { useEffect } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FIXTURE_NOTICE, Notice } from "../components/Notice";
import { checkAnchor, day } from "../components/report/report";
import { markSpans } from "../../report/marks.ts";
import { getSnapshot } from "../server/report-fns.ts";
import { withBase } from "../lib/base";

export const SNAPSHOT_NOTICE = "Archived text as collected. Links, images and scripts are not reproduced.";

export const Route = createFileRoute("/p/$projectId_/snapshot/$hash")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  validateSearch: (s: Record<string, unknown>): { check?: string } =>
    typeof s.check === "string" && /^[a-z0-9-]{1,64}$/.test(s.check) ? { check: s.check } : {},
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: ({ params }) => getSnapshot({ data: { projectId: params.projectId, hash: params.hash } }),
  component: SnapshotPage,
});

function SnapshotPage() {
  const snap = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const { check } = Route.useSearch();
  const checkId = check && snap.spans.some((s) => s.checkIds.includes(check)) ? check : snap.spans[0]?.checkIds[0];
  const back = withBase(`/p/${encodeURIComponent(projectId)}${checkId ? `#${checkAnchor(checkId)}` : ""}`);

  // The browser scrolls to #span-<id>; focus follows it so keyboard and screen-reader users land there too.
  useEffect(() => {
    const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (target?.tagName === "MARK") target.focus();
  }, []);

  const backLink = (
    <a href={back} data-back="">
      Back to the check
    </a>
  );
  return (
    <article data-snapshot="">
      {snap.fixture ? (
        <Notice variant="fixture" className="mb-8">
          {FIXTURE_NOTICE}
        </Notice>
      ) : null}
      <p className="text-[0.8125rem] font-semibold tracking-[0.12em] text-accent-ink uppercase">PRISM · Private report</p>
      <h1 className="mt-2 text-[2rem] leading-[1.15] font-semibold">Archived page</h1>
      <p className="mt-4">{backLink}</p>
      <dl data-snapshot-meta="" className="mt-4 grid grid-cols-1 gap-x-4 text-[0.8125rem] sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold">Page</dt>
        <dd className="font-mono break-all">{snap.url}</dd>
        <dt className="font-semibold">Archived</dt>
        <dd>{day(snap.archivedAt)}</dd>
        <dt className="font-semibold">Hash</dt>
        <dd className="font-mono">{snap.hash.slice(0, 12)}</dd>
      </dl>
      <Notice variant="info" className="mt-4">
        {SNAPSHOT_NOTICE}
      </Notice>
      <div data-snapshot-text="" className="mt-8 max-w-[75ch] whitespace-pre-wrap">
        {markSpans(snap.text, snap.spans).map((seg, i) =>
          seg.spanId ? (
            <mark
              key={i}
              id={`span-${seg.spanId}`}
              tabIndex={-1}
              className="rounded-[2px] bg-[color-mix(in_oklch,var(--accent-ink)_20%,transparent)] text-foreground"
            >
              {seg.text}
            </mark>
          ) : (
            seg.text
          ),
        )}
      </div>
      <p className="mt-8">{backLink}</p>
    </article>
  );
}
