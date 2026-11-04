import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { dataUriFromValueWithResolvedLinks } from "../src/data-uri.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cell-immutable-bench");
const space = signer.did();

const schema = {
  type: "object",
  properties: {
    value: { type: "number" },
  },
} as const satisfies JSONSchema;

const makeData = (index: number) => ({ value: index });

const setup = () => {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  return { runtime, storageManager };
};

const setupStorageManager = () =>
  StorageManager.emulate({
    as: signer,
  });

const cleanup = async (
  runtime: Runtime,
  _storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) => {
  if (tx) {
    await tx.commit().settled;
  }
  await runtime.dispose();
};

Deno.bench("Immutable cell - create data URI only (100x)", () => {
  for (let index = 0; index < 100; index += 1) {
    dataUriFromValueWithResolvedLinks(makeData(index));
  }
});

Deno.bench(
  "Immutable cell - storage manager setup and cleanup only",
  async () => {
    const storageManager = setupStorageManager();
    await storageManager.close();
  },
);

Deno.bench("Immutable cell - runtime setup and cleanup only", async () => {
  const { runtime, storageManager } = setup();
  await cleanup(runtime, storageManager);
});

Deno.bench("Immutable cell - create empty tx and abort (100x)", async () => {
  const { runtime, storageManager } = setup();
  try {
    for (let index = 0; index < 100; index += 1) {
      const tx = runtime.edit();
      tx.abort("bench");
    }
  } finally {
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Immutable cell - create cell without tx (100x)", async () => {
  const { runtime, storageManager } = setup();
  try {
    for (let index = 0; index < 100; index += 1) {
      runtime.getImmutableCell(space, makeData(index), schema);
    }
  } finally {
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Immutable cell - empty tx commit only (100x)", async () => {
  const { runtime, storageManager } = setup();
  try {
    for (let index = 0; index < 100; index += 1) {
      const tx = runtime.edit();
      await tx.commit().settled;
    }
  } finally {
    await cleanup(runtime, storageManager);
  }
});

Deno.bench(
  "Immutable cell - create cell with tx, no commit (100x)",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      for (let index = 0; index < 100; index += 1) {
        const tx = runtime.edit();
        runtime.getImmutableCell(space, makeData(index), schema, tx);
        tx.abort("bench");
      }
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);

Deno.bench(
  "Immutable cell - create cell with tx and commit (100x)",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      for (let index = 0; index < 100; index += 1) {
        const tx = runtime.edit();
        runtime.getImmutableCell(space, makeData(index), schema, tx);
        await tx.commit().settled;
      }
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);
