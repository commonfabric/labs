import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("blind-write-structural");
const space = signer.did();

const schema = {
  type: "object",
  properties: {
    box: {
      type: "object",
      properties: { leaf: { type: "string" } },
    },
  },
} as const;

Deno.test("a blind UI-input write threads a structural precondition at the cell's parent", async () => {
  // Runner-level coverage for the blind UI-input write path (the
  // runtime-client's handleCellSet / the multi-runtime worker mirror it, but
  // runner's own suite otherwise never marks a tx blind). Drives a blind nested
  // write: mark the tx blind, thread the cell's PARENT as the structural
  // precondition (setBlindStructuralTarget), write, and commit — so buildReads
  // drops the value-equality read and emits the nonRecursive structural read at
  // the parent.
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    // Establish a nested doc: { box: { leaf: "x" } }.
    const setup = runtime.edit();
    const cell = runtime.getCell<{ box: { leaf: string } }>(
      space,
      "blind-structural",
      schema,
      setup,
    );
    cell.withTx(setup).set({ box: { leaf: "x" } });
    await setup.commit().settled;
    await runtime.idle();

    // Blind write to the nested leaf `box.leaf`.
    const tx = runtime.edit();
    const leaf = cell.key("box").key("leaf");
    markUiInputBlindWriteTx(tx);
    const link = leaf.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
    setBlindStructuralTarget(tx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    leaf.withTx(tx).set("typed");
    unmarkUiInputBlindWriteTx(tx);
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit().settled;
    await runtime.idle();

    assert(
      !result.error,
      `blind write should commit cleanly: ${JSON.stringify(result.error)}`,
    );
    assert(
      cell.get()?.box?.leaf === "typed",
      "the blind leaf write should land",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
