// Custom server entry (TanStack Start's createServerEntry). The start-up checks
// in ./server/boot.ts run once, before the first request is handled; a failed
// check exits the process instead of serving.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import boot from "./server/boot.ts";

const ready = boot();

export default createServerEntry({
  async fetch(request) {
    await ready;
    return handler.fetch(request);
  },
});
