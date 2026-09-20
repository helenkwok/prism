import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

// The form is wired to the auth API in a later plan; there is no submit handler yet.
function SignIn() {
  return (
    <main>
      <h1>Sign in</h1>
      <form method="post" action="/sign-in">
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
