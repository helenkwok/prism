import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";
import { Button } from "../../components/ui/button";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

// Same-origin client: the base URL is the page's own origin.
const authClient = createAuthClient();

// Fixed copy (07-UI-SPEC): the server's own message is never shown.
const CREDENTIAL_FAILURE = "Email or password is incorrect. Check both and try again.";
const RATE_LIMITED = "Too many attempts. Wait a minute, then try again.";

const inputClass =
  "h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground aria-invalid:border-destructive";

function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  // On a failed submit, focus moves to the error notice.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (signInError) {
      setPending(false);
      setError(signInError.status === 429 ? RATE_LIMITED : CREDENTIAL_FAILURE);
      return;
    }
    // A full navigation so the guarded page loads with the new session cookie.
    window.location.assign("/");
  }

  const invalid = error ? true : undefined;
  const describedBy = error ? "sign-in-error" : undefined;

  return (
    <main id="content" className="mx-auto max-w-[880px] px-6 pt-16 pb-16 sm:px-8">
      <div className="max-w-[640px]">
        <h1 className="text-[2rem] leading-[1.15] font-semibold">Sign in to PRISM</h1>
        <p className="mt-4 text-muted-foreground">
          Accounts are issued by the project owner. There is no public sign-up.
        </p>
        <noscript>
          <p className="mt-4">Signing in needs JavaScript. Turn it on for this site and reload the page.</p>
        </noscript>
        <form method="post" onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
          {error ? (
            <div
              id="sign-in-error"
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="flex items-start gap-2 rounded-lg border border-destructive bg-card p-4 text-destructive"
            >
              <span className="icon-[lucide--circle-alert] mt-1 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="font-semibold">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="font-semibold">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={inputClass}
            />
          </div>
          <div>
            <Button type="submit" size="lg" disabled={pending} className="h-11 px-4 text-base">
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
