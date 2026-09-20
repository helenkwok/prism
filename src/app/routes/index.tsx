import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionEmail } from "../server/session.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const user = await getSessionEmail();
    if (!user) throw redirect({ to: "/sign-in" });
    return { user };
  },
  component: Home,
});

function Home() {
  const { user } = Route.useRouteContext();
  return (
    <main>
      <h1>PRISM</h1>
      <p>
        Signed in as <span data-testid="signed-in-email">{user.email}</span>
      </p>
      <p>
        <a href="/api/report.pdf">Skeleton report (PDF)</a>
      </p>
    </main>
  );
}
