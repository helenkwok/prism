// APP-02 / 07-UI-SPEC "Live run" (/run/$jobId, admin only): the stage list,
// polled every 2 s while the job is queued or running (5 s meta refresh without
// JavaScript), one polite live region for stage transitions, and the end state.
import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Notice } from "../components/Notice";
import { NotFound } from "../components/Forbidden";
import { Receipt } from "../components/run/Receipt";
import { StageList, STATUS, clock } from "../components/run/StageList";
import { buttonVariants } from "../../components/ui/button";
import { getRunStatus } from "../server/run-fns.ts";
import type { RunStatus, StageView } from "../server/live-run.ts";
import { withBase } from "../lib/base";

export const Route = createFileRoute("/run/$jobId")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: ({ params }) => getRunStatus({ data: { jobId: params.jobId } }),
  component: RunStatusPage,
});

const isActive = (s: RunStatus) => s.job.status === "queued" || s.job.status === "running";
const short = (label: string) => label.replace(/ \(.*\)$/, "");
const usd = (n: number) => `$${n.toFixed(2)}`;

/** "Collect: done. 12 pages collected." for each stage whose status changed. */
export function transitions(before: StageView[], after: StageView[]): string {
  return after
    .filter((s, i) => s.status !== before[i]?.status && s.status !== "waiting" && s.status !== "skipped")
    .map((s) => `${short(s.label)}: ${STATUS[s.status].word.toLowerCase()}.${s.message ? ` ${s.message}` : ""}`)
    .join(" ");
}

function RunStatusPage() {
  const initial = Route.useLoaderData();
  return initial ? <RunView initial={initial} /> : <NotFound />;
}

function RunView({ initial }: { initial: RunStatus }) {
  const [status, setStatus] = useState(initial);
  const [announcement, setAnnouncement] = useState("");
  const wasActive = useRef(isActive(initial));
  const linkRef = useRef<HTMLAnchorElement>(null);
  const active = isActive(status);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void getRunStatus({ data: { jobId: status.job.id } }).then((next) => {
        if (!next) return;
        setStatus((prev) => {
          const said = transitions(prev.stages, next.stages);
          if (said) setAnnouncement(said);
          return next;
        });
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [active, status.job.id]);

  // When the run ends while the page is open, focus moves to "Open the report".
  useEffect(() => {
    if (wasActive.current && !active) linkRef.current?.focus();
    wasActive.current = active;
  }, [active]);

  const { job } = status;
  return (
    <>
      {active ? (
        <noscript>
          <meta httpEquiv="refresh" content="5" />
        </noscript>
      ) : null}
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">Live run: {job.host}</h1>
      <p className="mt-2 text-[0.8125rem] text-muted-foreground tabular-nums">
        Started {job.createdAt.slice(0, 10)} {clock(job.createdAt)} · Run budget $0.10 · Spent {usd(job.spentUsd)} · Collector: {job.collector} · Models: {job.provider}, paid with {job.paidBy}
      </p>
      {status.queue ? (
        <p className="mt-4" data-queue="" aria-live="polite">
          {status.queue.position === 0
            ? "Starting now."
            : `Queued: ${status.queue.position} ${status.queue.position === 1 ? "run is" : "runs are"} ahead of this one. Rough wait: about ${Math.max(1, Math.round(status.queue.waitSeconds / 60))} min. This page updates by itself.`}
        </p>
      ) : null}
      <StageList stages={status.stages} />
      <div className="sr-only" aria-live="polite" data-live-region="">
        {announcement}
      </div>
      {active ? null : <EndState status={status} linkRef={linkRef} />}
      {active ? null : <Receipt receipt={status.receipt} collector={job.collector} />}
      {!active && job.demoLeft ? (
        <p className="mt-2 text-[0.8125rem] tabular-nums" data-demo-left="">
          {job.demoLeft}
        </p>
      ) : null}
      <p className="mt-8">
        <a href={withBase("/run")}>Back to live runs</a>
      </p>
    </>
  );
}

function EndState({ status, linkRef }: { status: RunStatus; linkRef: Ref<HTMLAnchorElement> }) {
  const { job, report } = status;
  const stage = job.stopStageLabel ?? "the run";
  const open = report ? (
    <p className="mt-4">
      <a ref={linkRef} href={withBase(`/p/${encodeURIComponent(report.projectRef)}`)} className={buttonVariants({ size: "lg" })}>
        Open the report
      </a>
    </p>
  ) : null;
  let text: string;
  // A stop or error is an expected outcome: ink, never red (Notice variants).
  let variant: "info" | "stopped" = "stopped";
  if (job.status === "done" && report) {
    variant = "info";
    text = `Report ready. ${report.pages} pages collected, ${report.pass} checks publicly evidenced.`;
  } else if (job.status === "stopped" && report) {
    text = "Stopped at the $0.10 run budget during confirmation. The report was built; unconfirmed positives show as awaiting confirmation.";
  } else if (job.status === "stopped") {
    text = `Stopped at the $0.10 run budget during ${stage}. No report was built. Start a new run to try again.`;
  } else if (job.status === "interrupted") {
    text = "Interrupted: the server restarted during this run. Its reserved budget was counted as spent. Start a new run to try again.";
  } else {
    text = `The run stopped with an error during ${stage}: ${job.message ?? "unknown error"}. No report was built. Start a new run to try again.`;
  }
  return (
    <section className="mt-8" data-end-state={job.status}>
      <Notice variant={variant}>{text}</Notice>
      {open}
    </section>
  );
}
