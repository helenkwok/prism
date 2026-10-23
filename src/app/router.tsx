import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { AppError, NotFound } from "./components/Forbidden";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Child routes fall back to the same 403 / 404 pages as the root.
    defaultErrorComponent: AppError,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
