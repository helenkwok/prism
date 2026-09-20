import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../server/auth.ts";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => getAuth().handler(request),
      POST: ({ request }: { request: Request }) => getAuth().handler(request),
    },
  },
});
