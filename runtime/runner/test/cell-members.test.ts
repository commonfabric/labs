import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getLoggerCountsByKey } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type Cell, deepTraverse, sinkProjected } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cell members");
const space = signer.did();

/** How many warnings the `cell` logger has reported under `pull`. */
function pullWarnings(): number {
  return getLoggerCountsByKey()["cell"]?.["pull"]?.warn ?? 0;
}

describe("cell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A cell named `cause`, holding `value` from a committed transaction, and
   * bound to no transaction.
   */
  async function committedCell<T>(cause: string, value: T): Promise<Cell<T>> {
    const tx = runtime.edit();
    const cell = runtime.getCell<T>(space, cause, undefined, tx);
    cell.set(value);
    await tx.commit().settled;
    return cell.withTx();
  }

  /** Runs `body` as a handler of `runtime` running under `tx`. */
  function asHandler<R>(tx: IExtendedStorageTransaction, body: () => R): R {
    const frame = pushFrame({ frameKind: "handler", runtime, tx, space });
    try {
      return body();
    } finally {
      popFrame(frame);
    }
  }

  describe("Cell", () => {
    describe("instance members", () => {
      describe("pull()", () => {
        it("rejects while the handler whose transaction the cell is bound to runs", async () => {
          const cell = await committedCell("pull-in-run", { n: 1 });
          const tx = runtime.edit();
          const bound = cell.withTx(tx);

          const pulled = asHandler(tx, () => bound.pull());

          await expect(pulled).rejects.toThrow("cannot pull() while it runs");
          expect(await bound.pull()).toEqual({ n: 1 });
          tx.abort();
        });

        it("warns, and resolves, when link-target loads are still pending after its last round", async () => {
          const cell = await committedCell("pull-unconverged", { n: 2 });
          const before = pullWarnings();

          expect(await cell.pull()).toEqual({ n: 2 });
          expect(pullWarnings()).toBe(before);

          storageManager.pendingCrossSpacePromiseCount = () => 1;
          storageManager.crossSpaceSettled = () => Promise.resolve();

          expect(await cell.pull()).toEqual({ n: 2 });
          expect(pullWarnings()).toBe(before + 1);
        });
      });

      describe("update()", () => {
        it("throws for a cell bound to no transaction", async () => {
          const cell = await committedCell("update-no-tx", { a: 1 });

          expect(() => cell.update({ a: 2 })).toThrow(
            "Cell.update() requires transaction and object value",
          );
        });

        it("throws for an empty cell whose schema admits no object", () => {
          const tx = runtime.edit();
          const numeric = runtime.getCell<unknown>(
            space,
            "update-numeric",
            { type: "number" },
            tx,
          );
          const open = runtime.getCell<{ a?: number }>(
            space,
            "update-object",
            { type: "object" },
            tx,
          );

          expect(() => numeric.update({ a: 1 } as never)).toThrow(
            "Cannot update with object value - schema does not allow objects",
          );
          open.update({ a: 1 });
          expect(open.get()).toEqual({ a: 1 });
          tx.abort();
        });
      });

      describe("applyChanges()", () => {
        it("throws for a cell bound to no transaction", async () => {
          const cell = await committedCell("apply-no-tx", "text");

          expect(() => cell.applyChanges({ from: 0, to: 0, insert: "a" }))
            .toThrow("Cell.applyChanges() requires a transaction");
        });
      });

      describe("setMetaRaw()", () => {
        it("throws for a cell bound to no transaction", async () => {
          const cell = await committedCell("meta-no-tx", 1);

          expect(() =>
            cell.setMetaRaw("argument", 1, rawMetaWriteAuthorization)
          ).toThrow("Transaction required for setMetaRaw");
        });
      });

      describe("getArgumentCell()", () => {
        it("returns `undefined` where the argument meta field holds no link", async () => {
          const argument = await committedCell("argument-target", { x: 1 });
          const tx = runtime.edit();
          const linked = runtime.getCell(
            space,
            "argument-linked",
            undefined,
            tx,
          );
          linked.set(0);
          linked.setMetaRaw(
            "argument",
            argument.getAsLink(),
            rawMetaWriteAuthorization,
          );
          const unlinked = runtime.getCell(
            space,
            "argument-plain",
            undefined,
            tx,
          );
          unlinked.set(0);
          unlinked.setMetaRaw("argument", "plain", rawMetaWriteAuthorization);

          expect(linked.getArgumentCell()?.get()).toEqual({ x: 1 });
          expect(unlinked.getArgumentCell()).toBeUndefined();
          tx.abort();
        });
      });

      describe("getAsReactiveProxy()", () => {
        it("yields the proxy of each element in turn when iterated", async () => {
          const cell = await committedCell("iterated", [10, 20, 30]);

          const [first, second] = cell.getAsReactiveProxy();

          expect(getCellOrThrow(first).get()).toBe(10);
          expect(getCellOrThrow(second).get()).toBe(20);
        });

        it("yields fifty element proxies whatever the array's length", async () => {
          const cell = await committedCell("iterated-short", [1]);

          const elements = [...cell.getAsReactiveProxy()];

          expect(elements.length).toBe(50);
          expect(getCellOrThrow(elements[49]).get()).toBeUndefined();
        });
      });
    });
  });

  describe("sinkProjected()", () => {
    it("throws while the handler whose transaction the cell is bound to runs", async () => {
      const cell = await committedCell("sink-in-run", { n: 3 });
      const tx = runtime.edit();
      const bound = cell.withTx(tx);

      expect(() =>
        asHandler(tx, () => sinkProjected(bound, (value) => value, () => {}))
      ).toThrow("cannot sink() while it runs");
      sinkProjected(bound, (value) => value, () => {})();
      tx.abort();
    });
  });

  describe("deepTraverse()", () => {
    it("reads the members after one whose read throws", () => {
      const read: string[] = [];
      const value = {
        get first(): unknown {
          throw new Error("unreadable");
        },
        get second(): unknown {
          read.push("second");
          return { inner: 1 };
        },
      };

      deepTraverse(value);

      expect(read).toEqual(["second"]);
    });
  });
});
