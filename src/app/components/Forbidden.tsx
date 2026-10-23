// 07-UI-SPEC "Refused and forbidden states": the 403 and 404 page bodies and
// the error component every route falls back to. The 403 page is the same for a
// forbidden record and a missing one, and links to no record at all (T-07-25).
import type { ReactNode } from "react";
import { Navigate, useRouteContext, useRouterState } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

function useUser() {
  return useRouteContext({ from: "__root__" }).user;
}

/** Signed-in pages sit inside the shell's <main>; signed-out ones bring their own. */
function Page({ title, children }: { title: string; children: ReactNode }) {
  const user = useUser();
  const body = (
    <>
      <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-[-0.01em]">{title}</h1>
      {children}
    </>
  );
  return user ? body : <main id="content" className="mx-auto max-w-[880px] px-6 pt-16 pb-16 sm:px-8">{body}</main>;
}

export function Forbidden() {
  const user = useUser();
  return (
    <Page title="Not available to your account">
      <p className="mt-4 max-w-[75ch]">
        This record is not open to your account. Identifiable records are shown only for the owner's projects, companies
        that opted in, and companies that meet the pre-registered well-known company rule (protocol §11). Everything your
        account can open is on your projects page.
      </p>
      <p className="mt-8 flex flex-wrap gap-4">
        <a href="/">Go to your projects</a>
        {user?.role === "judge" ? <a href="/method">Open the method audit</a> : null}
      </p>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page title="Page not found">
      <p className="mt-4">This page does not exist.</p>
      <p className="mt-8">
        <a href="/">Go to your projects</a>
      </p>
    </Page>
  );
}

/** AccessError survives server render as itself and client hydration as its message. */
function accessStatus(error: unknown): 401 | 403 | null {
  const e = error as { status?: unknown; message?: unknown } | null;
  if (e?.status === 403 || e?.message === "forbidden") return 403;
  if (e?.status === 401 || e?.message === "unauthenticated") return 401;
  return null;
}

export function AppError({ error }: ErrorComponentProps) {
  const href = useRouterState({ select: (s) => s.location.href });
  const status = accessStatus(error);
  if (status === 403) return <Forbidden />;
  if (status === 401) return <Navigate to="/sign-in" search={{ next: href }} replace />;
  return (
    <Page title="Something went wrong">
      <p className="mt-4">This page could not be shown. Try again, or go back to your projects.</p>
      <p className="mt-8">
        <a href="/">Go to your projects</a>
      </p>
    </Page>
  );
}
