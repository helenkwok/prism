import { useState } from "react";
import type { FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

// Same-origin client: the base URL is the page's own origin.
const authClient = createAuthClient();

function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: signInError } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (signInError) {
      setError(signInError.message ?? "Sign-in failed");
      return;
    }
    // A full navigation so the guarded page loads with the new session cookie.
    window.location.assign("/");
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form method="post" onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={pending}>
          Sign in
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
