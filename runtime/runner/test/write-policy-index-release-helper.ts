/**
 * Helper for write-policy-index-release.test.ts. Runs in its own process so it
 * can use `--v8-flags=--expose-gc` and the real clock (WeakRef state only
 * settles across task boundaries, which the package's fake-clock preload
 * would freeze).
 *
 * Preparing a transaction that writes a labeled document indexes its
 * write-policy inputs by the documents they name. The helper commits such
 * transactions, keeps each settled transaction reachable, as the piece its
 * start ran in keeps one in production, and drops every other reference to
 * the input it recorded but a WeakRef. It reports how many of those inputs
 * are still reachable after a forced collection.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("write policy index release");
const space = signer.did();

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

/** A document whose one field is labeled, so a write to it is checked. */
const LABELED = {
  type: "object",
  properties: {
    title: { type: "string", ifc: { confidentiality: ["secret"] } },
  },
} as const;

// Kept alive for the whole run: this stands in for the long-lived structure
// that references a settled transaction in production.
const settledTransactions: unknown[] = [];
const inputRefs: WeakRef<object>[] = [];

/**
 * Commits one prepared transaction holding a write-policy input about the
 * document it writes, and returns the transaction with a weak reference to
 * that input. A function of its own, so that no frame of the caller holds the
 * input once it returns.
 */
const commitOne = async (round: number) => {
  const tx = runtime.edit();
  const id = `of:write-policy-index-release-${round}`;
  runtime.getCell(space, id, LABELED, tx).set({ title: "once" });
  const input = {
    kind: "custom",
    name: "released",
    target: { space, id, scope: "space", path: [] },
    value: { payload: "x".repeat(1024) },
  } as const;
  tx.recordCfcWritePolicyInput(input);
  // Preparation checks the labeled write against the inputs about its
  // document, which builds the index over them.
  if (tx.prepareCfc() === "") {
    throw new Error("the transaction did not prepare");
  }
  await tx.commit().settled;
  return { tx, ref: new WeakRef(input) };
};

for (let round = 0; round < 3; round++) {
  const { tx, ref } = await commitOne(round);
  settledTransactions.push(tx);
  inputRefs.push(ref);
}

// WeakRef targets created in a turn survive that turn regardless of
// reachability. Cross one task boundary so the forced collection below can
// observe genuine reachability. This is an event-loop yield, not a wait.
await new Promise((resolve) => setTimeout(resolve, 0));
gc();
gc();

console.log(JSON.stringify({
  rounds: inputRefs.length,
  retainedTransactions: settledTransactions.length,
  aliveInputs: inputRefs.filter((ref) => ref.deref() !== undefined).length,
}));

await runtime.dispose();
await storageManager.close();
