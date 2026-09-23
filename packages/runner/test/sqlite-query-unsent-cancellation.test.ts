/**
 * What a cancelled node writes when its request was staged and never sent.
 *
 * A request that never goes out settles its ending on a transaction of its
 * own, after the run that staged it — so a piece cancelled in between would
 * write that ending to a result cell nobody reads. The cost is not only a
 * stray write: cancellation releases the runtime-owned enrollment that carries
 * §8.12.5 route 2 for this store, so the ending would arrive at a document
 * whose control paths resolve to the empty ceiling again, and at
 * `enforce-strict` it is refused exactly as the misfit that route exists to
 * remove — a late refusal naming a pane that no longer exists.
 *
 * The node is driven directly rather than through a pattern, which is what
 * makes the moment of cancellation exact: the ending fires when the staging
 * transaction abandons its work, and the case cancels between the staging and
 * that abandonment.
 *
 * Two things these cases do NOT reach, said here rather than left to be
 * discovered. The staging entry the cancelled path releases on its way out:
 * that map is closure state of the node, with no accessor, and giving it one
 * would widen every builtin's result shape to let a test peek at a leak whose
 * lifetime is the piece's. And the second cancellation check, inside the
 * ending's write: `editWithRetry` runs that callback synchronously on the
 * first attempt, so only a RETRY can arrive after a cancellation, and forcing
 * one would mean driving a storage conflict for a branch that is one term of
 * an existing guard. Both are read rather than asserted.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { sqliteQuery } from "../src/builtins/sqlite-builtins.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("sqlite unsent cancellation");
const space = signer.did();

interface QueryState {
  pending?: boolean;
  error?: unknown;
  requestHash?: string;
}

describe("sqlite-query-unsent-cancellation", () => {
  const drive = async (
    options: { cancel?: "before-abandon" },
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const setup = runtime.edit();
      const parent = runtime.getCell(space, "unsent-parent", undefined, setup);
      parent.set({});
      const inputs = runtime.getImmutableCell(
        space,
        {
          db: { id: "of:unsent-cancelled-query" },
          sql: "SELECT content FROM messages",
        },
        undefined,
        setup,
      );
      expect((await setup.commit()).error).toBeUndefined();

      let cancel!: () => void;
      // deno-lint-ignore no-explicit-any -- the builtin's own result cell
      let result: Cell<any> | undefined;
      const builtin = sqliteQuery(
        inputs,
        (_tx, cell) => result = cell,
        (stop) => cancel = stop,
        [parent],
        parent,
        runtime,
      );

      // The staging run. The transaction is never committed, which is what
      // an abandoned staging is: the claim never lands and the request never
      // goes out, so the ending is the only thing that can say so.
      const tx = runtime.edit();
      builtin.action(tx);
      expect(result).toBeDefined();

      if (options.cancel === "before-abandon") cancel();
      // What the scheduler does when it stops attempting a transaction's
      // staged work: every effect it holds is abandoned, which is the entry
      // point to the ending under test. It runs the abandon callbacks
      // synchronously, so the ending is scheduled by the time this returns
      // and has not yet written anything.
      tx.abandonStagedWork({
        name: "StorageTransactionAborted",
        message: "test abandon",
        reason: new Error("test abandon"),
        // deno-lint-ignore no-explicit-any -- the commit-error shape
      } as any);
      tx.abort("staging abandoned");
      await runtime.idle();
      await runtime.settled();

      return result?.get() as QueryState | undefined;
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  };

  it("writes no ending for a node cancelled before the abandonment", async () => {
    const state = await drive({ cancel: "before-abandon" });
    expect(state?.error).toBeUndefined();
  });

  it("writes the ending for a node that is still running", async () => {
    // What the case above rests on. Its assertion is an ABSENCE, which a
    // builtin that settled nothing at all would satisfy too; this one fails
    // in that world, so the pair together says the ending is skipped for a
    // cancelled node rather than never written.
    const state = await drive({});
    expect(String(state?.error)).toContain("refused before it started");
    expect(state?.pending).toBe(false);
  });
});
