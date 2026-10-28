/**
 * Helper for `document-release.test.ts`. Runs in its own process so that it
 * can force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary.
 *
 * It loads a document through a cell, runs release passes while the cell is
 * reachable and again once it has been dropped and collected, and prints one
 * line of JSON saying whether the document was still loaded after each:
 * `keptWhileHeld` and `keptOnceCollected`.
 */

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("document-release-gc");
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

try {
  const tx = writer.edit();
  writer.getCell(space, "counter", schema, tx).set({ n: 1 });
  const committed = await tx.commit().settled;
  if (committed.error) throw committed.error;
  await writerStorage.synced();
  await server.flushSessions();

  // The cell lives only in `holder`, filled by a function that has returned:
  // a suspended async frame can keep the temporaries it used.
  const holder: { cell?: Cell<unknown> } = {};
  const id = await (async () => {
    const cell = reader.getCell(space, "counter", schema);
    await cell.sync();
    holder.cell = cell;
    return cell.getAsNormalizedFullLink().id as URI;
  })();
  const loaded = () =>
    readerStorage.open(space).replica.hasLocalDocumentCoverage?.(id) === true;

  const releaseTwice = async () => {
    // A `WeakRef` target reached in a turn survives that turn whatever holds
    // it, so cross one task boundary before collecting. This is an
    // event-loop yield, not a wait.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    gc();
    await reader.releaseUnreadDocuments();
    await reader.releaseUnreadDocuments();
  };

  await releaseTwice();
  const keptWhileHeld = loaded();

  delete holder.cell;
  await releaseTwice();
  const keptOnceCollected = loaded();

  console.log(JSON.stringify({ keptWhileHeld, keptOnceCollected }));
} finally {
  await reader.dispose();
  await writer.dispose();
  await readerStorage.close();
  await writerStorage.close();
  await server.close();
}
