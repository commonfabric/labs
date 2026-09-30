/** Disposable inbox server for process-termination durability tests. */

import { InboxStore } from "@commonfabric/memory/inbox-store";
import { createInboxRouter } from "../../routes/inbox/router.ts";
if (Deno.args[1] === "--initialize-barrier") {
  console.log(JSON.stringify({ initializing: true }));
  await Deno.stdin.read(new Uint8Array(1));
}
const store = new InboxStore(Deno.args[0]);
const router = createInboxRouter({ store: () => Promise.resolve(store) });
Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(JSON.stringify({ port })),
}, (request) => router.fetch(request));
