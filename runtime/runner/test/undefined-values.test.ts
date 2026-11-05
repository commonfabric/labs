import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("undefined values");
const space = signer.did();

Deno.test("explicit undefined object properties are preserved", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-object",
      undefined,
      tx,
    );

    cell.set({ a: undefined, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), true);
    assertEquals(value.a, undefined);
    assertEquals(value.b, 2);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("removed keys are deleted, not left as undefined", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-removed-key",
      undefined,
      tx,
    );

    cell.set({ a: 1, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), false);
    assertEquals(Object.keys(value), ["b"]);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("overwriting a value with undefined keeps the key present", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ a?: number; b: number }>(
      space,
      "undefined-values-overwrite",
      undefined,
      tx,
    );

    cell.set({ a: 1, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ a: undefined, b: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as Record<string, unknown>;
    assertEquals(Object.hasOwn(value, "a"), true);
    assertEquals(value.a, undefined);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("array elements set to undefined stay present-but-undefined", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ list: (number | undefined)[] }>(
      space,
      "undefined-values-array",
      undefined,
      tx,
    );

    cell.set({ list: [1, 2, 3] });
    await tx.commit().settled;
    tx = runtime.edit();

    cell.withTx(tx).set({ list: [1, undefined, 3] });
    await tx.commit().settled;
    tx = runtime.edit();

    const value = cell.get() as { list: (number | undefined)[] };
    assertEquals(value.list.length, 3);
    assertEquals(1 in value.list, true);
    assertEquals(value.list[1], undefined);
    assertEquals(value.list[0], 1);
    assertEquals(value.list[2], 3);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});
