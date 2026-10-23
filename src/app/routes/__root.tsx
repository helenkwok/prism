import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router";
// Rsbuild path (TanStack Start's Tailwind guide): a side-effect import lets Start
// discover the generated stylesheet as a route asset and link it in the head.
import "../styles.css";
import { AppShell } from "../components/AppShell";
import { AppError, NotFound } from "../components/Forbidden";
import { getSessionUser } from "../server/session.ts";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "PRISM" },
    ],
  }),
  // The signed-in user (or null) for the shell and every route's guard.
  beforeLoad: async () => ({ user: await getSessionUser() }),
  component: RootComponent,
  // AccessError 403 renders the 403 page (status set by the guard), 401 goes to sign-in.
  errorComponent: AppError,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <RootDocument>
      <Shell>
        <Outlet />
      </Shell>
    </RootDocument>
  );
}

/** The shell wraps every page except sign-in, for a signed-in user. */
function Shell({ children }: { children: ReactNode }) {
  const { user } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!user || pathname === "/sign-in") return <>{children}</>;
  return (
    <AppShell user={user} pathname={pathname}>
      {children}
    </AppShell>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
