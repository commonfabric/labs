import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runtime read tx fallback bench");
const space = signer.did();

function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  _storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit().settled;
  await runtime.dispose();
}

Deno.bench({
  name: "Runtime readTx fallback - direct scalar read (100x)",
  group: "fallback-read",
  baseline: true,
  async fn(b) {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<number>(
      space,
      "bench-runtime-read-tx-direct",
      { type: "number" } as const,
      tx,
    );
    cell.set(42);
    await tx.commit().settled;
    const link = cell.getAsNormalizedFullLink();

    b.start();
    for (let i = 0; i < 100; i++) {
      const readTx = runtime.readTx();
      readTx.readValueOrThrow(link);
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Runtime readTx fallback - cell.get schema number (100x)",
  group: "fallback-read",
  async fn(b) {
    const { runtime, storageManager, tx } = setup();

    const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
    const cell = runtime.getCell(
      space,
      "bench-runtime-read-tx-schema",
      schema,
      tx,
    );
    cell.set(42);
    await tx.commit().settled;

    b.start();
    for (let i = 0; i < 100; i++) {
      cell.get();
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Runtime readTx fallback - query result proxy schemaless (100x)",
  group: "fallback-read",
  async fn(b) {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<{
      name: string;
      age: number;
      nested: { value: number };
    }>(space, "bench-runtime-read-tx-proxy", undefined, tx);

    cell.set({
      name: "test",
      age: 42,
      nested: { value: 123 },
    });
    await tx.commit().settled;

    b.start();
    for (let i = 0; i < 100; i++) {
      const proxy = cell.getAsQueryResult();
      proxy.name;
      proxy.nested.value;
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
});
