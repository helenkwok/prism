/**
 * The app's URL base, from base-path.mjs through Rsbuild's server.base ("/app" in production).
 * Router navigation (Link, redirect, navigate) applies it already; withBase is for every other
 * URL the app writes: plain links, window.location, fetch and static files under public/.
 */
// import.meta.env exists only in the Rsbuild bundles; scripts run under plain Node (migrate, seed) see none.
export const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");

/** An app path ("/p/x") as a URL path under the base ("/app/p/x"). */
export const withBase = (path: string) => `${BASE}${path}`;
