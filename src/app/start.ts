// Global request middleware (TanStack Start createStart). Runs for every request
// Start handles: SSR pages, server routes and server functions.
// - CSRF: defining this file turns off Start's automatic CSRF middleware for
//   server functions, so it is installed here explicitly (same filter as the default).
// - noindex: every response carries X-Robots-Tag (APP-04, T-07-27); /robots.txt
//   disallows everything as well.
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

const noindex = createMiddleware().server(async ({ next }) => {
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
  return next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [csrf, noindex] }));
