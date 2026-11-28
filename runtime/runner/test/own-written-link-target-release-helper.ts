/**
 * Helper for `own-written-link-target.test.ts`. Runs in its own process so
 * that it can force a collection (`--v8-flags=--expose-gc`) and cross a real
 * task boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary.
 *
 * One client stores a target document and a document linking to it, and reads
 * the target through the link under no schema, which loads the target. Once
 * the cell that load made has been collected, release passes run. The helper
 * prints one line of JSON: what the read through the link returned before the
 * passes (`beforeRelease`), what a `get()` returns after them
 * (`oneShotAfterRelease`, `null` for `undefined`), and what a `pull()`
 * returns after that (`pulledAfterRelease`).
 */

import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("own-written-link-target-release");
const space = signer.did();

/** What the linking document holds: a link to the target. */
type Linking = { inner?: { v?: number } };

const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
const storage = EmulatedStorageManager.connectTo(server, { as: signer });
const reader = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: storage,
});

try {
  const target = reader.getCell(space, "target").getAsNormalizedFullLink();
  const tx = reader.edit();
  tx.writeValueOrThrow(target, { v: 1 });
  tx.writeValueOrThrow(
    reader.getCell(space, "linking").getAsNormalizedFullLink(),
    { inner: { "/": { "link@1": { id: target.id, path: [] } } } },
  );
  const committed = await tx.commit().settled;
  if (committed.error) throw committed.error;

  const linking = reader.getCell<Linking>(space, "linking");
  const beforeRelease = (await linking.pull())?.inner?.v;
  await storage.synced();

  for (let pass = 0; pass < 2; pass++) {
    // A `WeakRef` target reached in a turn survives that turn whatever holds
    // it, so cross one task boundary before collecting. This is an
    // event-loop yield, not a wait.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    gc();
    await reader.releaseUnreadDocuments();
    await reader.releaseUnreadDocuments();
  }

  const oneShotAfterRelease = linking.get()?.inner?.v ?? null;
  const pulledAfterRelease = (await linking.pull())?.inner?.v;

  console.log(
    JSON.stringify({ beforeRelease, oneShotAfterRelease, pulledAfterRelease }),
  );
} finally {
  await reader.dispose();
  await storage.close();
  await server.close();
}
