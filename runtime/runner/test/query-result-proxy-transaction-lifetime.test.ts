// The two readings of the query-result proxy machinery.
//
// `createQueryResultProxy` builds a standing handle on a cell: it resolves the
// transaction afresh on every access, so a holder keeps reading current state
// after the transaction it was made against has finished. Long-lived consumers
// depend on that — a tool call dispatched by the LLM builtin, a SQLite result
// flushed after commit, a piece started on demand.
//
// A transaction marked for lazy materialization turns the same call into a view
// over the state that one transaction sees, fixed at creation. Reading after
// the transaction finishes throws instead of quietly reading from committed
// state, which is what a materialized read wants: the value it describes is the
// value that was there when it was taken.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { type Cell } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("qrp-transaction-lifetime");
const space = signer.did();

type Nested = { outer: { middle: { leaf: number } } };

describe("query-result-proxy transaction lifetime", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seed = async (cause: string) => {
    const tx = runtime.edit();
    const cell = runtime.getCell<Nested>(space, cause, undefined, tx);
    cell.set({ outer: { middle: { leaf: 1 } } });
    await tx.commit().settled;
    return cell;
  };

  // Marking the transaction is the whole gate: the same call that builds a
  // standing handle on an unmarked transaction builds a view on a marked one.
  const pinnedView = (cell: Cell<Nested>, tx: IExtendedStorageTransaction) => {
    tx.markLazyMaterialize(true);
    return createQueryResultProxy<Nested>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
    );
  };

  describe("a pinned view", () => {
    it("throws when read after its transaction has committed", async () => {
      const cell = await seed("lifetime-commit");

      const readTx = runtime.edit();
      const view = pinnedView(cell, readTx);
      expect(view.outer.middle.leaf).toBe(1);

      await readTx.commit().settled;

      expect(() => view.outer).toThrow("Transaction is complete");
    });

    it("throws when read after its transaction has aborted", async () => {
      const cell = await seed("lifetime-abort");

      const readTx = runtime.edit();
      const view = pinnedView(cell, readTx);
      expect(view.outer.middle.leaf).toBe(1);

      readTx.abort("done with this read");

      expect(() => view.outer).toThrow();
    });

    it("throws from a child captured before the transaction ended", async () => {
      const cell = await seed("lifetime-child");

      const readTx = runtime.edit();
      const view = pinnedView(cell, readTx);
      // Hold a view from partway down the tree, then end the transaction under
      // it: a child inherits the pin, so it refuses too.
      const middle = view.outer.middle;
      expect(middle.leaf).toBe(1);

      await readTx.commit().settled;

      expect(() => middle.leaf).toThrow("Transaction is complete");
    });

    describe("over an array", () => {
      // An array method and an iterator hand back work that runs after the trap
      // returned, so the instant has to travel with them rather than with the
      // property access that produced them.

      const seedList = async (cause: string) => {
        const tx = runtime.edit();
        const cell = runtime.getCell<number[]>(space, cause, undefined, tx);
        cell.set([1, 2, 3]);
        await tx.commit().settled;
        return cell;
      };

      const pinnedList = (
        cell: Cell<number[]>,
        tx: IExtendedStorageTransaction,
      ) => {
        tx.markLazyMaterialize(true);
        return createQueryResultProxy<number[]>(
          runtime,
          tx,
          cell.getAsNormalizedFullLink(),
        );
      };

      it("spreads the elements it was taken over", async () => {
        const cell = await seedList("list-spread");
        const readTx = runtime.edit();
        const view = pinnedList(cell, readTx);

        cell.withTx(readTx).set([1, 2, 3, 4]);

        expect([...view]).toEqual([1, 2, 3]);
        await readTx.commit().settled;
      });

      it("runs the caller's callback outside the instant", async () => {
        // The instant belongs to reading the elements, not to whatever the
        // caller does with them. A read the callback takes — of another cell,
        // or of one it just wrote — describes current state, exactly as it
        // would outside the method.
        const cell = await seedList("list-callback-scope");
        const other = runtime.getCell<number>(space, "callback-other");
        const setup = runtime.edit();
        other.withTx(setup).set(10);
        await setup.commit().settled;

        const readTx = runtime.edit();
        const view = pinnedList(cell, readTx);
        other.withTx(readTx).set(100);

        expect(view.map(() => other.withTx(readTx).get())).toEqual([
          100,
          100,
          100,
        ]);
        await readTx.commit().settled;
      });

      it("maps over the elements it was taken over", async () => {
        const cell = await seedList("list-map");
        const readTx = runtime.edit();
        const view = pinnedList(cell, readTx);

        cell.withTx(readTx).set([9, 9, 9]);

        expect(view.map((n) => n)).toEqual([1, 2, 3]);
        await readTx.commit().settled;
      });
    });

    it("keeps the state it was taken over when the reader writes", async () => {
      const cell = await seed("lifetime-own-writes");

      const readTx = runtime.edit();
      const view = pinnedView(cell, readTx);

      cell.withTx(readTx).key("outer").key("middle").key("leaf").set(2);
      expect(view.outer.middle.leaf).toBe(1);
      // Taking the read again is how the reader sees what it wrote.
      expect(
        createQueryResultProxy<Nested>(
          runtime,
          readTx,
          cell.getAsNormalizedFullLink(),
        ).outer.middle.leaf,
      ).toBe(2);

      await readTx.commit().settled;
    });

    it("constructs no transaction of its own for a deep walk", async () => {
      const cell = await seed("lifetime-frugal");

      const readTx = runtime.edit();
      const view = pinnedView(cell, readTx);

      let constructed = 0;
      const edit = runtime.edit.bind(runtime);
      (runtime as unknown as { edit: Runtime["edit"] }).edit = ((
        ...args: Parameters<Runtime["edit"]>
      ) => {
        constructed++;
        return edit(...args);
      }) as Runtime["edit"];

      for (let i = 0; i < 10; i++) {
        expect(view.outer.middle.leaf).toBe(1);
      }

      expect(constructed).toBe(0);
      await readTx.commit().settled;
    });
  });

  describe("a standing handle", () => {
    it("keeps reading current state after its transaction has committed", async () => {
      const cell = await seed("standing-commit");

      const readTx = runtime.edit();
      const handle = createQueryResultProxy<Nested>(
        runtime,
        readTx,
        cell.getAsNormalizedFullLink(),
      );
      expect(handle.outer.middle.leaf).toBe(1);

      await readTx.commit().settled;

      // The transaction it was made against is gone, and the handle still
      // reads — from current committed state, not from a refusal.
      expect(handle.outer.middle.leaf).toBe(1);

      const update = runtime.edit();
      cell.withTx(update).key("outer").key("middle").key("leaf").set(3);
      await update.commit().settled;

      expect(handle.outer.middle.leaf).toBe(3);
    });
  });
});
