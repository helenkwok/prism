// The /office route's server function. All three signed-in roles may open the
// findings workspace; requireRole is the guard, like getMethodView.
import { createServerFn } from "@tanstack/react-start";

import { requireRole } from "./access.ts";

export const getOfficeView = createServerFn({ method: "GET" }).handler(async () => {
  await requireRole("admin", "judge", "company");
  return { ok: true as const };
});
