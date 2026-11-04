/**
 * Helper for `read-release.test.ts`. Runs in its own process so that it can
 * force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target collected;
 * the package's fake-clock preload would freeze that boundary.
 *
 * It reads a document of rows, each holding a link, through a transaction,
 * once directly and once through a handle an earlier read in the same
 * transaction minted. It reads inside a frame that carries the transaction,
 * as an action's reads are. It settles the transaction, drops every reference it
 * holds to what the reads returned, and prints a JSON report of how many of
 * those values, and of the transactions, are still reachable. The first
 * argument names what else the helper keeps while it does so:
 *
 * - `in-flight-load`: every document load a read starts stays in flight for
 *   the rest of the run, holding the cell it was handed, as a load does until
 *   it lands. The transaction aborts.
 * - `settled-transaction`: the settled transaction itself. One transaction
 *   aborts and another commits.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const scenario = Deno.args[0];
if (scenario !== "in-flight-load" && scenario !== "settled-transaction") {
  throw new Error(`Unknown scenario: \`${scenario}\``);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const signer = await Identity.fromPassphrase("read release");
const space = signer.did();
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const rowsSchema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          subject: { asCell: ["cell"] },
        },
      },
    },
  },
} as const;

const handleSchema = {
  type: "object",
  properties: { list: { asCell: ["cell"] } },
  required: ["list"],
} as const;

const seed = runtime.edit();
const subject = runtime.getCell(space, "read-release-subject", undefined, seed);
subject.set({ name: "subject" });
const list = runtime.getCell(space, "read-release-list", undefined, seed);
list.set({
  rows: Array.from({ length: 20 }, (_, i) => ({
    title: `row ${i}`,
    subject: subject.getAsLink(),
  })),
});
const top = runtime.getCell(space, "read-release-top", undefined, seed);
top.set({ list: list.getAsLink() });
await seed.commit().settled;

const heldLoads: Cell<unknown>[] = [];
if (scenario === "in-flight-load") {
  storageManager.syncCell = <T>(cell: Cell<T>) => {
    heldLoads.push(cell);
    return new Promise<Cell<T>>(() => {});
  };
}

const settledTransactions: IExtendedStorageTransaction[] = [];
const transactionRefs: WeakRef<object>[] = [];
const valueRefs: WeakRef<object>[] = [];

/**
 * Reads the rows directly and through a minted handle in a new transaction,
 * inside a frame that carries it, settles it by aborting or committing it, and records a `WeakRef` to the
 * transaction and to each value read.
 */
async function readAndSettle(settle: "abort" | "commit"): Promise<void> {
  const tx = runtime.edit();
  const frame = pushFrame({ runtime, tx, space });
  const direct = list.withTx(tx).asSchema(rowsSchema).get();
  const handle = top.withTx(tx).asSchema(handleSchema).get().list;
  const throughHandle = handle.asSchema(rowsSchema).get();
  popFrame(frame);
  transactionRefs.push(new WeakRef(tx));
  valueRefs.push(new WeakRef(direct), new WeakRef(throughHandle));
  if (settle === "abort") {
    tx.abort("done");
  } else {
    await tx.commit().settled;
  }
  if (scenario === "settled-transaction") settledTransactions.push(tx);
}

await readAndSettle("abort");
if (scenario === "settled-transaction") await readAndSettle("commit");

// WeakRef targets created in a turn survive that turn regardless of
// reachability. Cross one task boundary so the forced collection below can
// observe genuine reachability. This is an event-loop yield, not a wait.
await new Promise((resolve) => setTimeout(resolve, 0));
gc();
gc();

const alive = (refs: WeakRef<object>[]) =>
  refs.filter((ref) => ref.deref() !== undefined).length;

console.log(
  JSON.stringify({
    transactions: transactionRefs.length,
    aliveTransactions: alive(transactionRefs),
    values: valueRefs.length,
    aliveValues: alive(valueRefs),
    heldLoads: heldLoads.length,
    settledTransactions: settledTransactions.length,
  }),
);

await runtime.dispose();
await storageManager.close();
