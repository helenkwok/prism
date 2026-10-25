// 07-UI-SPEC "App shell": the frame every signed-in page renders in. Nav is by
// role (company sees Projects only: Helen's 07-03 Q3 answer "hidden"); hiding a
// link is not the guard, the routes refuse other roles themselves.
import { useState } from "react";
import type { ReactNode } from "react";
import { createAuthClient } from "better-auth/react";
import { Button } from "../../components/ui/button";
import { withBase } from "../lib/base";

const authClient = createAuthClient({ basePath: withBase("/api/auth") });

export interface ShellUser {
  email: string;
  role: string | null;
}

const NAV: { href: string; label: string; roles: readonly string[] }[] = [
  { href: "/", label: "Projects", roles: ["admin", "judge", "company"] },
  { href: "/run", label: "Run a project", roles: ["admin"] },
  { href: "/method", label: "Method audit", roles: ["admin", "judge"] },
];

const ROLE_LABEL: Record<string, string> = { admin: "Admin", judge: "Judge", company: "Company" };

export function navFor(role: string | null) {
  return NAV.filter((n) => role !== null && n.roles.includes(role));
}

function isCurrent(href: string, pathname: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ user, pathname, children }: { user: ShellUser; pathname: string; children: ReactNode }) {
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    await authClient.signOut();
    window.location.assign(withBase("/sign-in"));
  }
  return (
    <>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-card focus:p-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-4 sm:px-8">
          <div className="order-1 flex items-baseline gap-2">
            <a href={withBase("/")} className="text-base font-semibold no-underline">
              PRISM
            </a>
            <span className="text-[0.8125rem] font-semibold tracking-[0.12em] text-accent-ink uppercase">Private</span>
          </div>
          <nav aria-label="Main" className="order-3 w-full sm:order-2 sm:w-auto">
            <ul className="flex flex-wrap gap-4">
              {navFor(user.role).map((n) => {
                const current = isCurrent(n.href, pathname);
                return (
                  <li key={n.href}>
                    <a
                      href={withBase(n.href)}
                      aria-current={current ? "page" : undefined}
                      className="inline-block border-b-2 border-transparent py-1 no-underline aria-[current=page]:border-accent-ink"
                    >
                      {n.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="order-2 ml-auto flex items-center gap-2 sm:order-3">
            {/* data-print-hide: a printed or PDF report must not carry who printed it. */}
            <span data-print-hide="" className="hidden text-[0.8125rem] text-muted-foreground sm:inline">{user.email}</span>
            <span data-print-hide="" className="rounded-md border border-border px-2 py-0.5 text-[0.8125rem]">
              {ROLE_LABEL[user.role ?? ""] ?? "No role"}
            </span>
            <Button variant="ghost" onClick={signOut} disabled={signingOut} className="h-8">
              <span className="icon-[lucide--log-out] size-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="content" className="mx-auto max-w-[880px] px-6 pt-16 pb-16 sm:px-8">
        {children}
      </main>
    </>
  );
}
