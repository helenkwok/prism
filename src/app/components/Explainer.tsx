// J6 (judges' review): a short first-visit explainer on the home page. It renders
// on the server, so it shows without JavaScript; with JavaScript the close button
// hides it and remembers that in localStorage. Storage can be missing or throw
// (private windows, blocked site data): the page then just shows the explainer.
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { VERDICT } from "./report/report";
import { withBase } from "../lib/base";

export const EXPLAINER_KEY = "prism.explainer.dismissed";
export const AUDIENCE_LINE = "PRISM is a checklist for users, a tour guide for builders and a benchmark for investors.";
export const NOT_PROMOTION =
  "It reads only each project's own site and repositories. Nobody can pay or submit to be included, and per-project results stay private.";

export function Explainer({ canRun }: { canRun: boolean }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(EXPLAINER_KEY) === "1") setShown(false);
    } catch {
      /* no storage: keep showing it */
    }
  }, []);
  if (!shown) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(EXPLAINER_KEY, "1");
    } catch {
      /* no storage: hidden for this visit only */
    }
    setShown(false);
    document.getElementById("projects-heading")?.focus();
  };
  return (
    <section data-explainer="" aria-labelledby="explainer-heading" className="mb-8 max-w-[75ch] rounded-lg border border-border bg-muted p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 id="explainer-heading" className="font-semibold">
          What PRISM is
        </h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss the introduction" onClick={dismiss}>
          <span className="icon-[lucide--x] size-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1">
        {AUDIENCE_LINE} {NOT_PROMOTION}
      </p>
      <dl data-evaluative="" className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[0.875rem] sm:grid-cols-[max-content_1fr]">
        {(["PASS", "INSUFFICIENT_EVIDENCE", "BLOCKED"] as const).map((s) => (
          <div key={s} className="contents">
            <dt className="font-semibold">{VERDICT[s].short}</dt>
            <dd>{VERDICT[s].full}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2">
        Open a project below to read its report: the verdict per decision, what would change it, then the evidence.
        {canRun ? (
          <>
            {" "}
            Or <a href={withBase("/run")}>start a live run on one URL</a>.
          </>
        ) : null}
      </p>
    </section>
  );
}
