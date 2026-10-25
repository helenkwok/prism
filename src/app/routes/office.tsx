// "Open the findings in your browser": the WebOffice shell (a port of the
// .office-ref prototype) with the four findings files offered at start. The
// page is signed-in only (the loader's getOfficeView opens with
// requireRole("admin", "judge", "company"), like getMethodView), and the
// editors render client-only: they are same-origin iframes running
// WebAssembly, which must never appear in the SSR HTML.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { WebOffice, type OpenOnStart } from "../components/office/WebOffice";
import { getOfficeView } from "../server/office-fns.ts";
import { withBase } from "../lib/base";

export const Route = createFileRoute("/office")({
  head: () => ({
    meta: [{ title: "Open the findings in your browser" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { next: location.href } });
  },
  loader: () => getOfficeView(),
  component: OfficePage,
});

const FINDINGS: OpenOnStart[] = [
  { name: "findings.xlsx", url: withBase("/office/findings/findings.xlsx"), tool: "gridcraft" },
  { name: "findings-report.docx", url: withBase("/office/findings/findings-report.docx"), tool: "wordcraft" },
  { name: "findings-deck.pptx", url: withBase("/office/findings/findings-deck.pptx"), tool: "deckcraft" },
  { name: "findings-pack.pdf", url: withBase("/office/findings/findings-pack.pdf"), tool: "pdfcraft" },
];

function OfficePage() {
  return (
    <article data-office="">
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">Open the findings in your browser</h1>
      <OfficeWorkspace />
    </article>
  );
}

/** Editors mount only in a browser: iframes load WebAssembly, never during SSR. */
function OfficeWorkspace() {
  if (typeof window === "undefined") {
    return (
      <p className="mt-4 text-[0.8125rem] text-muted-foreground" data-office-ssr="">
        The editors open in your browser once this page has loaded.
      </p>
    );
  }
  return (
    // Wider than the text column: the editors need room. Centred with a margin, not a transform, so the
    // workspace's position:fixed skip link stays off screen until focused. At most 1400 px.
    <div className="mt-6" style={{ width: "min(1400px, calc(100vw - 32px))", marginLeft: "calc((100% - min(1400px, calc(100vw - 32px))) / 2)" }} data-office-mount="">
      <WebOffice appsBase={withBase("/office-apps")} openOnStart={FINDINGS} />
    </div>
  );
}
