// FabricPrimitive values (e.g. FabricBytes) must be updatable in place. The
// storage no-op gates and the reactivity change-detection must not compare
// two distinct same-class FabricPrimitives via `deepEqual`, which sees zero
// enumerable own-props and reports them equal — that would diff the write
// away and reactive consumers would never re-run.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getTransactionWriteDetails } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("ct1770 operator");
const space = signer.did();

const bytesOf = (cell: { get(): { bytes: { slice(): Uint8Array } } }) =>
  Array.from(cell.get().bytes.slice());

describe("FabricPrimitive cell updates", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("updates a FabricBytes value via keyed set()", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "keyed",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit().settled;
    tx = runtime.edit();

    c.withTx(tx).key("bytes").set(new Uint8Array([9, 8, 7, 6]));
    const writes = [...getTransactionWriteDetails(tx, space)];
    await tx.commit().settled;

    expect(writes.map((w) => w.address.path.join("/"))).toContain(
      "value/bytes",
    );
    expect(bytesOf(c)).toEqual([9, 8, 7, 6]);
  });

  it("updates a FabricBytes value via whole-object set()", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "whole",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit().settled;
    tx = runtime.edit();

    c.withTx(tx).set({ bytes: new Uint8Array([5, 5, 5, 5]) });
    await tx.commit().settled;

    expect(bytesOf(c)).toEqual([5, 5, 5, 5]);
  });

  it("re-fires reactive consumers when a FabricBytes value changes", async () => {
    const c = runtime.getCell<{ bytes: Uint8Array }>(
      space,
      "react",
      undefined,
      tx,
    );
    c.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    await tx.commit().settled;

    const seen: string[] = [];
    const cancel = c.key("bytes").sink((value: unknown) => {
      const v = value as { slice(): Uint8Array };
      seen.push(Array.from(v.slice()).join(","));
    });
    await runtime.idle();

    tx = runtime.edit();
    c.withTx(tx).key("bytes").set(new Uint8Array([9, 8, 7, 6]));
    await tx.commit().settled;
    await runtime.idle();
    cancel();

    expect(seen).toEqual(["1,2,3,4", "9,8,7,6"]);
  });
});
