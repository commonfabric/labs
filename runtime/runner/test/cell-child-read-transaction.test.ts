// The transaction a cell handed out by a read stays bound to.
//
// A read made through an open transaction the caller supplied belongs to that
// transaction, and so does every cell it hands out. A read made without one
// opens a read transaction for itself, which nothing finishes, so a cell it
// hands out binds to no transaction and reads current state on every read.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { toCell } from "../src/back-to-cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cell-child-read-transaction");
const space = signer.did();

type Child = { count: number };
type Parent = { child: Cell<Child> };

const childSchema = {
  type: "object",
  properties: { count: { type: "number" } },
} as const satisfies JSONSchema;
const parentSchema = {
  type: "object",
  properties: { child: { ...childSchema, asCell: ["cell"] } },
} as const satisfies JSONSchema;

describe("cell child read transaction", () => {
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

  const seed = async (cause: string): Promise<Cell<Parent>> => {
    const tx = runtime.edit();
    const parent = runtime.getCell<Parent>(
      space,
      cause,
      parentSchema as JSONSchema,
      tx,
    );
    parent.asSchema<unknown>(undefined).setRaw({ child: { count: 1 } });
    await tx.commit().settled;
    return parent.withTx();
  };

  const commitCount = async (parent: Cell<Parent>, count: number) => {
    const tx = runtime.edit();
    parent.withTx(tx).asSchema<unknown>(undefined).setRaw({ child: { count } });
    await tx.commit().settled;
  };

  describe("a read outside any transaction", () => {
    it("hands out a child that reads current state after `get()`", async () => {
      const parent = await seed("get-child");
      const child = parent.get().child;
      expect(child.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 2 });
    });

    it("hands out a child that reads current state after `sample()`", async () => {
      const parent = await seed("sample-child");
      const child = parent.sample().child;
      expect(child.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 2 });
    });

    it("hands out a child that reads current state after `pull()`", async () => {
      const parent = await seed("pull-child");
      const child = (await parent.pull()).child;
      expect(child.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 2 });
    });

    it("hands out a grandchild that reads current state", async () => {
      const parent = await seed("grandchild");
      const outer = runtime.getCell<{ parent: Cell<Parent> }>(
        space,
        "grandchild-outer",
        {
          type: "object",
          properties: { parent: { ...parentSchema, asCell: ["cell"] } },
        } as JSONSchema,
      );
      const tx = runtime.edit();
      outer.withTx(tx).asSchema<unknown>(undefined).setRaw({
        parent: parent.getAsLink(),
      });
      await tx.commit().settled;

      const grandchild = outer.get().parent.get().child;
      expect(grandchild.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(grandchild.get()).toEqual({ count: 2 });
    });

    it("hands out a cell that reads current state from the value's `toCell`", async () => {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: { nested: childSchema },
      } as const satisfies JSONSchema;
      const cell = runtime.getCell<{ nested: Child }>(
        space,
        "to-cell",
        schema as JSONSchema,
        tx,
      );
      cell.set({ nested: { count: 1 } });
      await tx.commit().settled;

      const nested = cell.withTx().get().nested as unknown as {
        [toCell]: () => Cell<Child>;
      };
      const back = nested[toCell]();
      expect(back.get()).toEqual({ count: 1 });

      const update = runtime.edit();
      cell.withTx(update).set({ nested: { count: 2 } });
      await update.commit().settled;

      expect(back.get()).toEqual({ count: 2 });
    });

    it("hands out a cell that reads current state from a schema-less value's `toCell`", async () => {
      const tx = runtime.edit();
      const cell = runtime.getCell<{ nested: Child }>(
        space,
        "proxy-to-cell",
        undefined,
        tx,
      );
      cell.set({ nested: { count: 1 } });
      await tx.commit().settled;

      const nested = cell.withTx().get().nested as unknown as {
        [toCell]: () => Cell<Child>;
      };
      const back = nested[toCell]();
      expect(back.get().count).toBe(1);

      const update = runtime.edit();
      cell.withTx(update).set({ nested: { count: 2 } });
      await update.commit().settled;

      expect(back.get().count).toBe(2);
    });

    it("hands out a cell that reads current state from `getAsQueryResult()`", async () => {
      const tx = runtime.edit();
      const cell = runtime.getCell<{ nested: Child }>(
        space,
        "query-result-to-cell",
        undefined,
        tx,
      );
      cell.set({ nested: { count: 1 } });
      await tx.commit().settled;

      const nested = cell.withTx().getAsQueryResult().nested as unknown as {
        [toCell]: () => Cell<Child>;
      };
      const back = nested[toCell]();
      expect(back.get().count).toBe(1);

      const update = runtime.edit();
      cell.withTx(update).set({ nested: { count: 2 } });
      await update.commit().settled;

      expect(back.get().count).toBe(2);
    });

    it("hands out a child that reads current state from a parent's default", async () => {
      const schema = {
        type: "object",
        properties: { child: { ...childSchema, asCell: ["cell"] } },
        default: { child: { count: 0 } },
      } as const satisfies JSONSchema;
      const parent = runtime.getCell<Parent>(
        space,
        "default-child",
        schema as JSONSchema,
      );

      const child = parent.get().child;
      expect(child.get()).toEqual({ count: 0 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 2 });
    });

    it("hands out a child that refuses `set()` outside a transaction", async () => {
      const parent = await seed("refuses-set");
      const child = parent.get().child;

      expect(() => child.set({ count: 2 })).toThrow();
      expect(child.get()).toEqual({ count: 1 });
    });
  });

  describe("a read through a finished transaction", () => {
    it("hands out a child that reads current state", async () => {
      const parent = await seed("finished-child");
      const finished = runtime.edit();
      finished.abort("done with this transaction");

      const child = parent.withTx(finished).get().child;
      expect(child.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 2 });
    });
  });

  describe("a read through an open transaction", () => {
    it("hands out a child that stays on a read transaction the caller opened", async () => {
      const parent = await seed("explicit-read");
      const read = runtime.readTx();
      const child = parent.withTx(read).get().child;
      expect(child.get()).toEqual({ count: 1 });

      await commitCount(parent, 2);

      expect(child.get()).toEqual({ count: 1 });
      expect(parent.withTx().get().child.get()).toEqual({ count: 2 });
    });

    it("hands out a child that sees the transaction's own staged writes", async () => {
      const parent = await seed("staged");
      const tx = runtime.edit();
      const child = parent.withTx(tx).get().child;

      child.set({ count: 5 });

      expect(child.get()).toEqual({ count: 5 });
      expect(parent.withTx().get().child.get()).toEqual({ count: 1 });
      tx.abort("done with this transaction");
    });
  });
});
