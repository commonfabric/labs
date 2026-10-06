import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setResultCell } from "../src/result-utils.ts";

const signer = await Identity.fromPassphrase("memory v2 root delete");
const space = signer.did();

Deno.test("memory v2 root deletes stay undefined through sink and get", async () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const cell = runtime.getCell<{ name: string }>(
      space,
      "memory-v2-root-delete",
      undefined,
      tx,
    );

    cell.set({ name: "Alice" });
    await tx.commit().settled;
    tx = runtime.edit();

    const seen: unknown[] = [];
    const cancel = cell.sink((value) => {
      seen.push(value);
    });

    await runtime.idle();

    cell.withTx(tx).set(undefined as unknown as { name: string });
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    assertEquals(seen.at(-1), undefined);
    assertEquals(cell.get(), undefined);

    cancel();
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("memory v2 source-backed cells clear to undefined", async () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const parent = runtime.getCell(
      space,
      "memory-v2-root-delete-parent",
      undefined,
      tx,
    );
    const child = runtime.getCell<{ name: string }>(
      space,
      "memory-v2-root-delete-child",
      undefined,
      tx,
    );

    setResultCell(child, parent);
    child.set({ name: "Alice" });
    await tx.commit().settled;

    tx = runtime.edit();
    child.withTx(tx).set(undefined as unknown as { name: string });
    await tx.commit().settled;
    tx = runtime.edit();

    assertEquals(child.get(), undefined);
    assertEquals(await child.pull(), undefined);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});
