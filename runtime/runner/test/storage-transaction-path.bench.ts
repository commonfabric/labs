import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("storage-transaction-path-bench");
const space = signer.did();

const setup = () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { storageManager, runtime, tx };
};

const cleanup = async (
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await runtime.dispose();
  await storageManager.close();
};

Deno.bench("Storage tx path - root read x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:storage-tx-read",
      path: [],
    }, { count: 0, label: "bench", nested: { value: 1 } });

    for (let index = 0; index < 100; index += 1) {
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:storage-tx-read",
        path: [],
      });
    }
  } finally {
    await tx.commit().settled;
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Storage tx path - single sibling write x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:storage-tx-write",
      path: [],
    }, { count: 0, label: "bench", nested: { value: 1 } });

    for (let index = 0; index < 100; index += 1) {
      tx.writeValueOrThrow({
        space,
        scope: "space",
        id: "of:storage-tx-write",
        path: ["count"],
      }, index);
    }
  } finally {
    await tx.commit().settled;
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Storage tx path - five sibling writes x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:storage-tx-five",
      path: [],
    }, {
      a: 0,
      b: "zero",
      c: true,
      d: { nested: 0 },
      e: 0,
    });

    for (let index = 0; index < 100; index += 1) {
      tx.writeValuesOrThrow?.([
        {
          address: {
            space,
            scope: "space",
            id: "of:storage-tx-five",
            path: ["a"],
          },
          value: index,
        },
        {
          address: {
            space,
            scope: "space",
            id: "of:storage-tx-five",
            path: ["b"],
          },
          value: `value-${index}`,
        },
        {
          address: {
            space,
            scope: "space",
            id: "of:storage-tx-five",
            path: ["c"],
          },
          value: index % 2 === 0,
        },
        {
          address: {
            space,
            scope: "space",
            id: "of:storage-tx-five",
            path: ["d", "nested"],
          },
          value: index * 2,
        },
        {
          address: {
            space,
            scope: "space",
            id: "of:storage-tx-five",
            path: ["e"],
          },
          value: index + 1,
        },
      ]);
    }
  } finally {
    await tx.commit().settled;
    await cleanup(runtime, storageManager);
  }
});
