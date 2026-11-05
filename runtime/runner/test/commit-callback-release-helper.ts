/**
 * Helper for commit-callback-release.test.ts. Runs in its own process so it
 * can use `--v8-flags=--expose-gc` and the real clock (WeakRef state only
 * settles across task boundaries, which the package's fake-clock preload
 * would freeze).
 *
 * A commit callback runs exactly once, when its transaction settles. The
 * question here is what the transaction holds afterwards. Callbacks are
 * closures over the machinery that registered them — a child registry, a
 * result cell, an action's captured frame — so a settled transaction that
 * keeps its callback set keeps all of that reachable for as long as anything
 * still references the transaction. Long-lived structures do reference
 * settled transactions (a cell carries the transaction it was created with),
 * so this is a live retention path, not a theoretical one.
 *
 * The helper registers a callback whose closure captures a sentinel object,
 * commits, drops every reference except a WeakRef to the sentinel and a
 * strong reference to the settled transaction, and reports whether the
 * sentinel is still reachable.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("commit callback release");
const space = signer.did();

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

// Kept alive for the whole run: this stands in for the long-lived structure
// that references a settled transaction in production.
const settledTransactions: unknown[] = [];
const sentinelRefs: WeakRef<object>[] = [];

for (let round = 0; round < 3; round++) {
  const tx = runtime.edit();
  const cell = runtime.getCell<{ value: number }>(
    space,
    `commit-callback-release-${round}`,
    undefined,
    tx,
  );
  cell.set({ value: round });

  // Scoped so the only strong reference to the sentinel after this block is
  // the callback closure the transaction holds.
  {
    const sentinel = { round, payload: "x".repeat(1024) };
    sentinelRefs.push(new WeakRef(sentinel));
    tx.addCommitCallback(() => {
      // Reads the sentinel, so the closure genuinely captures it.
      if (sentinel.round < 0) throw new Error("unreachable");
    });
  }

  await tx.commit().settled;
  settledTransactions.push(tx);
}

// WeakRef targets created in a turn survive that turn regardless of
// reachability. Cross one task boundary so the forced collection below can
// observe genuine reachability. This is an event-loop yield, not a wait.
await new Promise((resolve) => setTimeout(resolve, 0));
gc();
gc();

const aliveSentinels = sentinelRefs.reduce(
  (count, ref) => count + (ref.deref() === undefined ? 0 : 1),
  0,
);

console.log(
  JSON.stringify({
    rounds: sentinelRefs.length,
    retainedTransactions: settledTransactions.length,
    aliveSentinels,
  }),
);

await runtime.dispose();
await storageManager.close();
