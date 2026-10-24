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
import { COLLECTORS, DEFAULT_PROVIDER, KEY_NOTE, MODEL_PROVIDERS, type CollectorId, type ProviderId } from "../server/live-options.ts";

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
  budget: "Not run: PRISM's shared demo budget is used up. Add your own Token Factory key below to run, or read the recorded reports. Nothing was fetched.",
  "bad-option": "Not run: check the key fields. A key has no spaces; OpenRouter needs your own model key; Tavily needs your own Tavily key. Nothing was fetched.",
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
  const { runs, budget } = Route.useLoaderData();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [tavilyKey, setTavilyKey] = useState("");
  const [provider, setProvider] = useState<ProviderId>(DEFAULT_PROVIDER);
  const [collector, setCollector] = useState<CollectorId>("own-site");
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
      const r = await startLiveRun({ data: { url, modelKey, tavilyKey: collector === "tavily" ? tavilyKey : "", provider, collector } });
      // Keys leave the page's memory once sent; nothing is kept in storage or the URL.
      setModelKey("");
      setTavilyKey("");
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
      {budget.notice ? (
        <Notice variant="refused" className="mt-8">
          <span data-budget-notice="">{budget.notice}</span> <a href="/">Read the recorded reports</a>
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
        <fieldset className="mt-6">
          <legend className="text-base font-semibold">Your own keys (optional)</legend>
          <p id="key-note" className="mt-1 text-[0.8125rem] text-muted-foreground">
            {KEY_NOTE} Without a model key, PRISM's own Nebius Token Factory key pays, within its shared demo budget.
          </p>
          <label htmlFor="run-provider" className="mt-3 block text-[0.9375rem] font-semibold">
            Model provider
          </label>
          <select
            id="run-provider"
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground"
          >
            {(Object.keys(MODEL_PROVIDERS) as ProviderId[]).map((id) => (
              <option key={id} value={id}>
                {MODEL_PROVIDERS[id]}
              </option>
            ))}
          </select>
          <label htmlFor="run-model-key" className="mt-3 block text-[0.9375rem] font-semibold">
            {provider === "openrouter" ? "OpenRouter API key" : "Token Factory API key"}
          </label>
          <input
            id="run-model-key"
            name="modelKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="key-note"
            value={modelKey}
            onChange={(e) => setModelKey(e.target.value)}
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground"
          />
          <label htmlFor="run-collector" className="mt-3 block text-[0.9375rem] font-semibold">
            Evidence collector
          </label>
          <select
            id="run-collector"
            name="collector"
            value={collector}
            onChange={(e) => setCollector(e.target.value as CollectorId)}
            className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground"
          >
            {(Object.keys(COLLECTORS) as CollectorId[]).map((id) => (
              <option key={id} value={id}>
                {id === "tavily" ? "Tavily (your key)" : COLLECTORS[id]}
              </option>
            ))}
          </select>
          {collector === "tavily" ? (
            <>
              <label htmlFor="run-tavily-key" className="mt-3 block text-[0.9375rem] font-semibold">
                Tavily API key
              </label>
              <input
                id="run-tavily-key"
                name="tavilyKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="key-note"
                value={tavilyKey}
                onChange={(e) => setTavilyKey(e.target.value)}
                className="mt-1 h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground"
              />
            </>
          ) : null}
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button type="submit" size="lg" disabled={pending || !budget.configured || (budget.disabled && !modelKey)}>
            Run PRISM on this URL
          </Button>
          <div className="flex items-center gap-2 text-[0.8125rem] tabular-nums" data-budget="">
            {budget.configured ? (
              <meter min={0} max={budget.cap} value={budget.used} aria-label="Live-run budget spent" className="h-2 w-[240px]" />
            ) : null}
            <span>{budget.line}</span>
          </div>
        </div>
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
