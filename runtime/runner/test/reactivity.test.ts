import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { effect } from "../src/reactivity.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("reactivity", () => {
  describe("effect()", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;

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

    /** A committed cell holding `value`, ready to be observed. */
    async function seededCell(
      name: string,
      value: number,
    ): Promise<Cell<number>> {
      const tx = runtime.edit();
      const cell = runtime.getCell<number>(space, name, undefined, tx);
      cell.withTx(tx).set(value);
      await tx.commit().settled;
      return cell;
    }

    /** Writes `value` into `cell` in its own committed transaction. */
    async function write(cell: Cell<number>, value: number): Promise<void> {
      const tx = runtime.edit();
      cell.withTx(tx).set(value);
      await tx.commit().settled;
      await runtime.idle();
    }

    it("runs the callback immediately for a plain value", () => {
      const seen: number[] = [];
      effect(7, (value) => {
        seen.push(value);
      });
      expect(seen).toEqual([7]);
    });

    it("passes a plain value through without unwrapping it", () => {
      const value = { nested: [1, 2] };
      let received: unknown;
      effect(value, (observed) => {
        received = observed;
      });
      expect(received).toBe(value);
    });

    it("returns the cancel the callback produced for a plain value", () => {
      let cancelled = false;
      const cancel = effect(1, () => () => {
        cancelled = true;
      });
      cancel();
      expect(cancelled).toBe(true);
    });

    it("returns a callable cancel when the callback returns nothing", () => {
      const cancel = effect(1, () => {});
      expect(typeof cancel).toBe("function");
      // The no-op still has to be safe to call, and to stay safe when a
      // caller cancels twice.
      expect(() => {
        cancel();
        cancel();
      }).not.toThrow();
    });

    it("runs the callback with a cell's current value", async () => {
      const cell = await seededCell("effect-initial", 1);
      const seen: number[] = [];
      const cancel = effect(cell, (value) => {
        seen.push(value);
      });
      await runtime.idle();
      expect(seen).toEqual([1]);
      cancel();
    });

    it("runs the callback again when the cell changes", async () => {
      const cell = await seededCell("effect-updates", 1);
      const seen: number[] = [];
      const cancel = effect(cell, (value) => {
        seen.push(value);
      });
      await runtime.idle();
      await write(cell, 2);
      expect(seen).toEqual([1, 2]);
      cancel();
    });

    it("stops running the callback once cancelled", async () => {
      const cell = await seededCell("effect-cancel", 1);
      const seen: number[] = [];
      const cancel = effect(cell, (value) => {
        seen.push(value);
      });
      await runtime.idle();
      cancel();
      await write(cell, 2);
      expect(seen).toEqual([1]);
    });
  });
});
