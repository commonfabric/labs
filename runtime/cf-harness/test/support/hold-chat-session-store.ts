/**
 * Stands in for a process that dies holding a chat session store. It opens —
 * and so holds — the SQLite store at the path given as its first argument, as
 * the instance named by its second, reports that on stdout as one JSON line,
 * and then stays alive, holding, until its stdin closes or it is killed.
 */

import { toFileUrl } from "@std/path";

import { openSqliteHarnessChatSessionStore } from "../../src/sqlite-session-store.ts";

const [path, instanceId] = Deno.args;
await openSqliteHarnessChatSessionStore({
  url: toFileUrl(path),
  holder: {
    instanceId,
    pid: Deno.pid,
    heldSince: new Date().toISOString(),
  },
});
console.log(JSON.stringify({ held: true }));
for await (const _chunk of Deno.stdin.readable) {
  // Nothing arrives on stdin; the pending read is what keeps this process
  // alive.
}
