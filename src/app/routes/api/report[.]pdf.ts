import { createElement as h } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { render } from "takumi-pdf";
import { sql } from "kysely";
import { getDb } from "../../server/db.ts";

// Skeleton report: proves takumi renders inside a server route and that the
// native SQLite module loads. It embeds no user data, only the engine version
// and the date.
export const Route = createFileRoute("/api/report.pdf")({
  server: {
    handlers: {
      GET: async () => {
        // Canary first: a native-module or file failure must surface as an error,
        // never as a PDF that looks fine.
        const { rows } = await sql<{ v: string }>`select sqlite_version() as v`.execute(getDb());
        const version = rows[0]?.v ?? "unknown";
        const pdf = await render(
          h(
            "div",
            {},
            h("h1", {}, "PRISM skeleton report"),
            h("p", {}, `SQLite version ${version}`),
            h("p", {}, `Rendered ${new Date().toISOString().slice(0, 10)}`),
          ),
          { size: "a4", lang: "en" },
        );
        return new Response(pdf.slice(), {
          headers: { "content-type": "application/pdf", "cache-control": "no-store" },
        });
      },
    },
  },
});
