import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "./auth.ts";

/** The signed-in user's email, or null when there is no valid session. */
export const getSessionEmail = createServerFn({ method: "GET" }).handler(async () => {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  return session ? { email: session.user.email } : null;
});
