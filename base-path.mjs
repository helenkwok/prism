// The one place the app's URL base is set: the app is served under it (prism.helenkwok.dev/app),
// with the public findings site at the host's root. Rsbuild's server.base takes it, TanStack Start
// derives the router basepath and server-function base from that, code reads import.meta.env.BASE_URL,
// and scripts/serve.mjs serves dist/client under it. Override with PRISM_BASE_PATH ("/" for the root).
export const BASE_PATH = (process.env.PRISM_BASE_PATH ?? "/app").replace(/\/+$/, "") || "/";
/** BASE_PATH as a prefix to put before an app path: "" at the root, "/app" otherwise. */
export const BASE_PREFIX = BASE_PATH === "/" ? "" : BASE_PATH;
