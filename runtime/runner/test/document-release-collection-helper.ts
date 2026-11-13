/**
 * Helper for `document-release.test.ts`. Runs in its own process so that it
 * can force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary.
 *
 * It loads two documents through cells, lets go of both cells, has them
 * collected, and at once holds the second document again, all without asking
 * for a release pass. It then waits for the storage manager to drop the
 * first document, and prints one line of JSON saying whether that happened
 * (`droppedOnceCollected`) and whether the second document was still loaded
 * then (`keptOnceHeldAgain`).
 */

import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("document-release-collection");
const space = signer.did();
const schema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const;

const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
const writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
const readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
const writer = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: writerStorage,
});
const reader = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: readerStorage,
});
const keepAlive = new MessageChannel();

try {
  const tx = writer.edit();
  writer.getCell(space, "released", schema, tx).set({ n: 1 });
  writer.getCell(space, "held-again", schema, tx).set({ n: 2 });
  const committed = await tx.commit().settled;
  if (committed.error) throw committed.error;
  await writerStorage.synced();
  await server.flushSessions();

  // The cells live only in `holder`, filled by a function that has returned:
  // a suspended async frame can keep the temporaries it used.
  const holder: { cells?: Cell<unknown>[] } = {};
  const [released, heldAgain] = await (async () => {
    const cells = ["released", "held-again"].map((cause) =>
      reader.getCell(space, cause, schema)
    );
    await Promise.all(cells.map((cell) => cell.sync()));
    holder.cells = cells;
    return cells.map((cell) => cell.getAsNormalizedFullLink().id as URI);
  })();
  const loaded = (id: URI) =>
    readerStorage.open(space).replica.hasLocalDocumentCoverage?.(id) === true;

  const dropped = defer();
  readerStorage.subscribeDocumentsDropped((_space, addresses) => {
    if (addresses.some((address) => address.id === released)) {
      dropped.resolve();
    }
  });
  // Deno ends a process with nothing left to do before its finalizers run, so
  // an open port keeps this one going until the storage manager reports a
  // token collected. What follows from the report needs nothing to keep it
  // going, so a report that asks for no pass ends the process unresolved.
  keepAlive.port1.onmessage = () => {};
  readerStorage.subscribeHoldsCollected(() => keepAlive.port1.close());

  delete holder.cells;
  // A `WeakRef` target reached in a turn survives that turn whatever holds
  // it, so cross one task boundary before collecting. This is an event-loop
  // yield, not a wait.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();
  // In the same turn as the collection, so before any report of it arrives:
  // the second document gets a new token, which this keeps.
  const token = readerStorage.holdDocument({ space, id: heldAgain });

  await dropped.promise;
  const droppedOnceCollected = !loaded(released);
  const keptOnceHeldAgain = loaded(heldAgain);
  console.log(JSON.stringify({ droppedOnceCollected, keptOnceHeldAgain }));
  // The token is what kept the second document; reading it here keeps it
  // reachable until after that was measured.
  if (token === undefined) throw new Error("no hold token");
} finally {
  keepAlive.port1.close();
  await reader.dispose();
  await writer.dispose();
  await readerStorage.close();
  await writerStorage.close();
  await server.close();
}
