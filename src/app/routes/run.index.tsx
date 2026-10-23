// APP-02 / 07-UI-SPEC "Live run" (/run, admin only): the URL form, the refused
// notices and the recent runs. The loader's server function opens with
// requireRole("admin"), so any other role gets the one 403 page with status 403.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Notice } from "../components/Notice";
import { Button } from "../../components/ui/button";
import { clock } from "../components/run/StageList";
import { listRecentRuns, startLiveRun } from "../server/run-fns.ts";
import type { JobStatus, JobView, Refusal } from "../server/live-run.ts";

export const Route = createFileRoute("/run/")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: () => listRecentRuns(),
  component: RunPage,
});

export const REFUSED: Record<Refusal, string> = {
  "off-list": "Not run: this URL is not on the own or opt-in list. Nothing was fetched.",
  "private-address": "Not run: this address points to a private or internal network. Nothing was fetched.",
  "bad-url": "Not run: enter a full https:// address.",
  "dns-fail": "Not run: this address could not be found. Nothing was fetched.",
  "not-configured": "Not run: live runs are not configured on this server. Nothing was fetched.",
  budget: "Not run: the live-run budget is spent. Nothing was fetched.",
};

export const JOB_WORD: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  stopped: "Stopped",
  refused: "Refused",
  error: "Error",
  interrupted: "Interrupted",
};

const HELP =
  "Only URLs on the own or opt-in list are accepted. PRISM checks robots.txt first and fetches only that site and its repositories. Each run may spend up to $0.10 on model calls.";
const th = "px-2 py-1 text-left text-[0.8125rem] font-semibold tracking-[0.04em] uppercase";
const td = "border-t border-border px-2 py-1 align-top";

function RunPage() {
  const { runs } = Route.useLoaderData();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [pending, setPending] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);

  // A refusal moves focus to its notice (07-UI-SPEC).
  useEffect(() => {
    if (refused) noticeRef.current?.focus();
  }, [refused]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setRefused(null);
    try {
      const r = await startLiveRun({ data: { url } });
      if ("refused" in r) setRefused(r.refused);
      else await navigate({ to: "/run/$jobId", params: { jobId: String(r.jobId) } });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">Run PRISM on one URL</h1>
      {refused ? (
        <Notice variant="refused" announce ref={noticeRef} className="mt-8">
          <span data-refused={refused}>{REFUSED[refused]}</span>
        </Notice>
      ) : null}
      <form className="mt-8 max-w-[640px]" onSubmit={onSubmit}>
        <label htmlFor="run-url" className="block text-base font-semibold">
          Project URL
        </label>
        <input
          id="run-url"
          name="url"
          type="url"
          required
          inputMode="url"
          placeholder="https://"
          aria-describedby="run-url-help"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mt-2 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground"
        />
        <p id="run-url-help" className="mt-2 text-[0.8125rem] text-muted-foreground">
          {HELP}
        </p>
        <Button type="submit" size="lg" className="mt-4" disabled={pending}>
          Run PRISM on this URL
        </Button>
      </form>
      <h2 className="mt-12 text-[1.25rem] leading-[1.2] font-semibold">Recent runs</h2>
      {runs.length === 0 ? <p className="mt-4">No live runs yet.</p> : <RecentRuns runs={runs} />}
    </>
  );
}

function RecentRuns({ runs }: { runs: JobView[] }) {
  return (
    <div role="region" aria-label="Recent runs" tabIndex={0} className="mt-4 overflow-x-auto" data-table-wrapper="">
      <table className="w-full min-w-[560px] border-collapse tabular-nums">
        <caption className="sr-only">Recent live runs, newest first</caption>
        <thead className="bg-muted">
          <tr>
            {["Started", "Host", "Status", ""].map((h, i) => (
              <th key={i} scope="col" className={th}>
                {h || <span className="sr-only">Open</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} data-run={r.id}>
              <td className={td}>
                {r.createdAt.slice(0, 10)} {clock(r.createdAt)}
              </td>
              <td className={`${td} font-mono text-[0.8125rem]`}>{r.host}</td>
              <td className={td}>
                <span className="rounded-md border border-border px-2 py-0.5 text-[0.8125rem]">{JOB_WORD[r.status]}</span>
              </td>
              <td className={td}>
                <a href={`/run/${r.id}`}>View</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
