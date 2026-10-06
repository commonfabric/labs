import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench operator");
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
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit().settled;
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench({
  name: "Cell read path - schemaless array key varying index (100x)",
  group: "array-key",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(space, "bench-read-path-array-varying", undefined, tx);

    cell.set({
      items: Array.from({ length: 100 }, (_, i) => ({
        name: `item${i}`,
        value: i,
      })),
    });
    await tx.commit().settled;

    for (let i = 0; i < 100; i++) {
      cell.key("items").key(i % 100).key("value").get();
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell read path - schemaless array key fixed index rebuild (100x)",
  group: "array-key",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(space, "bench-read-path-array-fixed", undefined, tx);

    cell.set({
      items: Array.from({ length: 100 }, (_, i) => ({
        name: `item${i}`,
        value: i,
      })),
    });
    await tx.commit().settled;

    for (let i = 0; i < 100; i++) {
      cell.key("items").key(50).key("value").get();
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell read path - schemaless array key fixed index reuse child (100x)",
  group: "array-key",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(space, "bench-read-path-array-reuse", undefined, tx);

    cell.set({
      items: Array.from({ length: 100 }, (_, i) => ({
        name: `item${i}`,
        value: i,
      })),
    });
    await tx.commit().settled;

    const valueCell = cell.key("items").key(50).key("value");
    for (let i = 0; i < 100; i++) {
      valueCell.get();
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell read path - complex schema object get (100x)",
  group: "schema-read",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        nested: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
        },
      },
      required: ["name", "age", "tags", "nested"],
    } as const satisfies JSONSchema;

    const cell = runtime.getCell(
      space,
      "bench-read-path-complex-schema",
      schema,
      tx,
    );
    cell.set({
      name: "test",
      age: 42,
      tags: ["a", "b", "c"],
      nested: { value: 123 },
    });
    await tx.commit().settled;

    for (let i = 0; i < 100; i++) {
      const value = cell.get();
      value.name;
      value.age;
      value.tags;
      value.nested.value;
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell read path - complex schema with asCell deref (100x)",
  group: "schema-read",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          asCell: ["cell"],
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
            notifications: { type: "boolean" },
          },
          asCell: ["cell"],
        },
      },
      required: ["id", "metadata", "tags", "settings"],
    } as const satisfies JSONSchema;

    const cell = runtime.getCell(
      space,
      "bench-read-path-ascell-schema",
      schema,
      tx,
    );
    cell.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
      tags: ["developer", "typescript"],
      settings: {
        theme: "dark",
        notifications: true,
      },
    });
    await tx.commit().settled;

    for (let i = 0; i < 100; i++) {
      const value = cell.get();
      value.id;
      value.metadata.get();
      value.tags;
      value.settings.get();
    }

    await cleanup(runtime, storageManager, tx);
  },
});
