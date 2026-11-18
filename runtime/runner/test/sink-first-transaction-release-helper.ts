/**
 * Helper for `sink-first-transaction-release.test.ts`. Runs in its own process
 * so it can use `--v8-flags=--expose-gc` and the real event loop.
 *
 * `Cell.sink()` runs its callback once in a transaction of its own before it
 * subscribes. The helper opens several sinks and keeps each one live, holds a
 * `WeakRef` to every transaction the runtime made while each sink was opened,
 * and reports how many of those transactions a forced collection leaves
 * reachable.
 */

import { yieldToEventLoop } from "@commonfabric/async/sleep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cancel } from "../src/cancel.ts";
import { Runtime } from "../src/runtime.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Requires --expose-gc");

const signer = await Identity.fromPassphrase("sink first transaction");
const space = signer.did();
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const tx = runtime.edit();
const cell = runtime.getCell<{ count: number }>(
  space,
  "sink-first-transaction",
  undefined,
  tx,
);
cell.set({ count: 1 });
await tx.commit().settled;

// The transactions made while a sink is opened, and the live sinks, which
// stand in for a subscription a host keeps open.
const opened: WeakRef<object>[] = [];
const cancels: Cancel[] = [];
const edit = runtime.edit.bind(runtime);
runtime.edit = (...args: Parameters<Runtime["edit"]>) => {
  const made = edit(...args);
  opened.push(new WeakRef(made));
  return made;
};
let delivered = 0;
for (let round = 0; round < 3; round++) {
  cancels.push(
    runtime.getCell<{ count: number }>(space, "sink-first-transaction")
      .sink((value) => {
        if (value !== undefined) delivered++;
      }),
  );
}
runtime.edit = edit;
await runtime.idle();

// A `WeakRef` target made in a turn survives that turn whatever reaches it, so
// the collection below runs a task later.
await yieldToEventLoop();
gc();
gc();

const reachable = opened.filter((ref) => ref.deref() !== undefined).length;
console.log(
  JSON.stringify({
    sinks: cancels.length,
    delivered,
    transactions: opened.length,
    reachable,
  }),
);

for (const cancel of cancels) cancel();
await runtime.dispose();
await storageManager.close();
