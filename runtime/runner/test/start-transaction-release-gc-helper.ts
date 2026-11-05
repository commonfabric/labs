/**
 * Helper for `start-transaction-release.test.ts`. Runs in its own process so
 * that it can force a collection (`--v8-flags=--expose-gc`) and cross a real
 * task boundary, which a `WeakRef` needs before it can report its target
 * collected; the package's fake-clock preload would freeze that boundary.
 *
 * It starts a piece on a transaction, commits that transaction, lets go of
 * it, and prints one line of JSON saying whether the piece still runs and
 * whether the transaction was collected: `running` and `collected`.
 */

import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("start-transaction-release-gc");
const space = signer.did();

const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
const storage = EmulatedStorageManager.connectTo(server, { as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: storage,
});

try {
  // The transaction lives only in the frame of a function that has returned,
  // which keeps a suspended async frame's temporaries from holding it.
  const { piece, transaction } = await (async () => {
    const { pattern, lift } = createTrustedBuilder(runtime).commonfabric;
    const doubled = pattern<{ n: number }>(({ n }) =>
      lift((n: number) => n * 2, { type: "number" }, { type: "number" })(n)
    );
    const tx = runtime.edit();
    // `run()` hands back the result cell bound to `tx`; what this process
    // keeps is the cell without it, as a caller that kept the piece would.
    const piece: Cell<number> = runtime.run(
      tx,
      doubled,
      { n: 2 },
      runtime.getCell<number>(space, "doubled"),
    ).withTx();
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The start did not commit: ${error.message}`);
    return { piece, transaction: new WeakRef(tx) };
  })();
  if (await piece.pull() !== 4) throw new Error("The piece did not run");
  await runtime.idle();
  await storage.synced();

  // A `WeakRef` target reached in a turn survives that turn whatever holds
  // it, so cross one task boundary before collecting. This is an event-loop
  // yield, not a wait.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();

  // A sibling made without a transaction from a cell bound to one, as a node
  // makes of its result cell, shares that cell's identity and nothing else.
  const sibling = (() => {
    const tx = runtime.edit();
    const bound = runtime.getCellFromLink<number>(
      runtime.getCell<number>(space, "sibling").getAsNormalizedFullLink(),
      undefined,
      tx,
    );
    const detached = bound.withTx();
    tx.abort("the sibling case needs no commit");
    return { detached, transaction: new WeakRef(tx) };
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();

  console.log(JSON.stringify({
    running: runtime.runner.isRunning(piece),
    collected: transaction.deref() === undefined,
    // Reading the sibling here keeps it live through the collection above.
    siblingCollected: sibling.detached.space === space &&
      sibling.transaction.deref() === undefined,
  }));
} finally {
  await runtime.dispose();
  await storage.close();
  await server.close();
}
