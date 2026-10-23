// The identifiable report page's markup (ReportPage in src/app/routes/p.$projectId.tsx) over the
// synthetic P01 view that build.mjs exports. Shared by the Worker and the container probe.
import { FIXTURE_NOTICE, Notice } from "../../../src/app/components/Notice";
import { ReportBody } from "../../../src/app/components/report/report";
import type { ReportView } from "../../../src/report/view.ts";
import p01 from "./.build/p01-view.json";

const view = p01 as unknown as ReportView;

export function ReportPage() {
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

export const SYNTHETIC_PASSWORD = "synthetic-probe-password-42";
export const HEALTH_BODY = "prism-cpu-probe ok";
