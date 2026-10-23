import { createFileRoute } from "@tanstack/react-router";

// APP-04: nothing this private app serves may be indexed (X-Robots-Tag is set on every response in start.ts).
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response("User-agent: *\nDisallow: /\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
