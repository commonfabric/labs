import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

// Setup helper to create runtime and transaction
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

// Cleanup helper
async function cleanup(
  runtime: Runtime,
  _storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit().settled;
  await runtime.dispose();
}

//
// Benchmark: Cell creation
//

Deno.bench("Cell creation - simple schemaless (100x)", async () => {
  const { runtime, storageManager } = setup();

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    const cell = runtime.getCell<number>(space, `bench-cell-${i}`, undefined);
    cell.withTx(tx).set(42);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell creation - with JSON schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
  } as const satisfies JSONSchema;

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, `bench-cell-schema-${i}`, schema);
    cell.withTx(tx).set({ name: "John", age: 30 });
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell creation - immutable (100x)", async () => {
  const { runtime, storageManager } = setup();

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    runtime.getImmutableCell(
      space,
      { value: 42 + i },
      { type: "object", properties: { value: { type: "number" } } },
      tx,
    );
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

//
// Schema-based cell creation benchmarks
//

Deno.bench("Cell creation - simple with schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = { type: "number" } as const satisfies JSONSchema;

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, `bench-cell-schema-${i}`, schema);
    cell.withTx(tx).set(42);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell creation - object with nested schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0, maximum: 150 },
          email: { type: "string" },
        },
        required: ["name", "age"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["user", "tags"],
  } as const satisfies JSONSchema;

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, `bench-nested-schema-${i}`, schema);
    cell.withTx(tx).set({
      user: {
        name: "John Doe",
        age: 30,
        email: "john@example.com",
      },
      tags: ["developer", "typescript"],
    });
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell creation - array with schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  } as const satisfies JSONSchema;

  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, `bench-array-schema-${i}`, schema);
    cell.withTx(tx).set([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

//
// Benchmark: Cell get operations
//

Deno.bench("Cell get - simple value schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<number>(space, "bench-get", undefined, tx);
  cell.set(42);
  await tx.commit().settled;

  // Measure get operation
  for (let i = 0; i < 100; i++) {
    cell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell get - complex object schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{
    name: string;
    age: number;
    tags: string[];
    nested: { value: number };
  }>(space, "bench-get-complex", undefined, tx);

  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  await tx.commit().settled;

  // Measure get operation
  for (let i = 0; i < 100; i++) {
    cell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell getRaw - complex object schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{
    name: string;
    age: number;
    tags: string[];
    nested: { value: number };
  }>(space, "bench-getRaw", undefined, tx);

  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  await tx.commit().settled;

  // Measure getRaw operation
  for (let i = 0; i < 100; i++) {
    cell.getRaw();
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Schema-based get operations
//

Deno.bench("Cell get - simple value with schema (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const schema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
  const cell = runtime.getCell(space, "bench-get-schema", schema, tx);
  cell.set(42);
  await tx.commit().settled;

  // Measure get operation
  for (let i = 0; i < 100; i++) {
    cell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell get - complex object with schema (100x)", async () => {
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

  const cell = runtime.getCell(space, "bench-get-complex-schema", schema, tx);

  cell.set({
    name: "test",
    age: 42,
    tags: ["a", "b", "c"],
    nested: { value: 123 },
  });
  await tx.commit().settled;

  // Measure get operation
  for (let i = 0; i < 100; i++) {
    cell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Cell set operations
//

Deno.bench("Cell set - simple value schemaless (100x)", async () => {
  const { runtime, storageManager } = setup();

  const cell = runtime.getCell<number>(space, "bench-set", undefined);

  // Measure set operation
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).set(i);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell send - simple value schemaless (100x)", async () => {
  const { runtime, storageManager } = setup();

  const cell = runtime.getCell<number>(space, "bench-send", undefined);

  // Initialize with a committed value first
  const initTx = runtime.edit();
  cell.withTx(initTx).set(0);
  initTx.commit();

  // Measure send operation
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).send(i);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench(
  "Cell update - partial object update schemaless (100x)",
  async () => {
    const { runtime, storageManager } = setup();

    const cell = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
    }>(space, "bench-update", undefined);

    // Initialize with a committed value first
    const initTx = runtime.edit();
    cell.withTx(initTx).set({ name: "test", age: 42, tags: ["a", "b"] });
    initTx.commit();

    // Measure update operation
    for (let i = 0; i < 100; i++) {
      const tx = runtime.edit();
      cell.withTx(tx).update({ age: i });
      tx.commit();
    }

    await cleanup(runtime, storageManager);
  },
);

//
// Schema-based set operations
//

Deno.bench("Cell set - simple value with schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = {
    type: "number",
    minimum: 0,
    maximum: 1000,
  } as const satisfies JSONSchema;
  const cell = runtime.getCell(space, "bench-set-schema", schema);

  // Measure set operation
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).set(i);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench(
  "Cell update - partial object update with schema (100x)",
  async () => {
    const { runtime, storageManager } = setup();

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number", minimum: 0 },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["name", "age", "tags"],
    } as const satisfies JSONSchema;

    const cell = runtime.getCell(space, "bench-update-schema", schema);

    // Initialize with a committed value first
    const initTx = runtime.edit();
    cell.withTx(initTx).set({ name: "test", age: 42, tags: ["a", "b"] });
    initTx.commit();

    // Measure update operation
    for (let i = 0; i < 100; i++) {
      const tx = runtime.edit();
      cell.withTx(tx).update({ age: i });
      tx.commit();
    }

    await cleanup(runtime, storageManager);
  },
);

//
// Benchmark: Nested cell operations
//

Deno.bench("Cell key - nested access schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{
    a: { b: { c: { d: number } } };
  }>(space, "bench-key", undefined, tx);

  cell.set({ a: { b: { c: { d: 42 } } } });
  await tx.commit().settled;

  // Measure nested key access
  for (let i = 0; i < 100; i++) {
    cell.key("a").key("b").key("c").key("d").get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell key - array access schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{
    items: Array<{ name: string; value: number }>;
  }>(space, "bench-key-array", undefined, tx);

  cell.set({
    items: Array.from({ length: 100 }, (_, i) => ({
      name: `item${i}`,
      value: i,
    })),
  });
  await tx.commit().settled;

  // Measure array key access
  for (let i = 0; i < 100; i++) {
    cell.key("items").key(i % 100).key("value").get();
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Schema-based nested operations
//

Deno.bench("Cell key - nested access with schema (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const schema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                properties: {
                  d: { type: "number" },
                },
                required: ["d"],
              },
            },
            required: ["c"],
          },
        },
        required: ["b"],
      },
    },
    required: ["a"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-key-schema", schema, tx);

  cell.set({ a: { b: { c: { d: 42 } } } });
  await tx.commit().settled;

  // Measure nested key access
  for (let i = 0; i < 100; i++) {
    cell.key("a").key("b").key("c").key("d").get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell key - array access with schema (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
          required: ["name", "value"],
        },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-key-array-schema", schema, tx);

  cell.set({
    items: Array.from({ length: 100 }, (_, i) => ({
      name: `item${i}`,
      value: i,
    })),
  });
  await tx.commit().settled;

  // Measure array key access
  for (let i = 0; i < 100; i++) {
    cell.key("items").key(i % 100).key("value").get();
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Cell derivation
//

Deno.bench("Cell asSchema - schema transformation (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{
    id: number;
    metadata: { createdAt: string; type: string };
  }>(space, "bench-asSchema", undefined, tx);

  cell.set({
    id: 1,
    metadata: { createdAt: "2025-01-06", type: "user" },
  });
  await tx.commit().settled;

  const schema = {
    type: "object",
    properties: {
      id: { type: "number" },
      metadata: { type: "object", asCell: ["cell"] },
    },
    required: ["id", "metadata"],
  } as const satisfies JSONSchema;

  // Measure asSchema transformation
  for (let i = 0; i < 100; i++) {
    const schemaCell = cell.asSchema(schema);
    schemaCell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell withTx - transaction switching (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<number>(space, "bench-withTx", undefined, tx);
  cell.set(42);
  await tx.commit().settled;

  const tx2 = runtime.edit();

  // Measure withTx operation
  for (let i = 0; i < 100; i++) {
    const newCell = cell.withTx(i % 2 === 0 ? tx : tx2);
    newCell.get();
  }

  await tx2.commit().settled;
  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Query result proxy operations
//

Deno.bench(
  "Cell getAsQueryResult - proxy creation schemaless (100x)",
  async () => {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<{
      name: string;
      age: number;
      nested: { value: number };
    }>(space, "bench-proxy", undefined, tx);

    cell.set({
      name: "test",
      age: 42,
      nested: { value: 123 },
    });
    await tx.commit().settled;

    // Measure proxy creation and access
    for (let i = 0; i < 100; i++) {
      const proxy = cell.getAsQueryResult();
      proxy.name;
      proxy.nested.value;
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Schema-based get operations for complex objects
//

Deno.bench("Cell get - complex object with asCell schema (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      nested: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
        asCell: ["cell"], // This creates a cell reference
      },
    },
    required: ["name", "age", "nested"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-get-asCell-schema", schema, tx);

  cell.set({
    name: "test",
    age: 42,
    nested: { value: 123 },
  });
  await tx.commit().settled;

  // Measure get with schema that creates cell references
  for (let i = 0; i < 100; i++) {
    const value = cell.get();
    value.name;
    value.age;
    value.nested.get(); // nested is a Cell due to asCell: ["cell"]
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Array operations
//

Deno.bench("Cell push - array append schemaless (100x)", async () => {
  const { runtime, storageManager } = setup();

  const cell = runtime.getCell<{ items: number[] }>(
    space,
    "bench-push",
    undefined,
  );

  // Initialize with a committed value first
  const initTx = runtime.edit();
  cell.withTx(initTx).set({ items: [] });
  initTx.commit();

  // Measure push operations
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).key("items").push(i);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell array - proxy map operation schemaless (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{ items: number[] }>(
    space,
    "bench-array-map",
    undefined,
    tx,
  );
  cell.set({ items: Array.from({ length: 100 }, (_, i) => i) });
  await tx.commit().settled;

  const proxy = cell.getAsQueryResult();

  // Measure array map operation via proxy
  for (let i = 0; i < 100; i++) {
    proxy.items.map((x: number) => x * 2);
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Schema-based array operations
//

Deno.bench("Cell push - array append with schema (100x)", async () => {
  const { runtime, storageManager } = setup();

  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "number", minimum: 0 },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-push-schema", schema);

  // Initialize with a committed value first
  const initTx = runtime.edit();
  cell.withTx(initTx).set({ items: [] });
  initTx.commit();

  // Measure push operations
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).key("items").push(i);
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

Deno.bench("Cell array - map operation with schema (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-array-get-schema", schema, tx);
  cell.set({ items: Array.from({ length: 100 }, (_, i) => i) });
  await tx.commit().settled;

  // Measure get operation with schema validation
  for (let i = 0; i < 100; i++) {
    const value = cell.get();
    value.items.map((x: number) => x * 2);
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Link operations
//

Deno.bench("Cell getAsLink - link generation schemaless (100x)", async (b) => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{ value: number }>(
    space,
    "bench-link",
    undefined,
    tx,
  );
  cell.set({ value: 42 });
  await tx.commit().settled;

  // Measure link generation
  b.start();
  for (let i = 0; i < 100; i++) {
    cell.getAsLink();
  }
  b.end();

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell getAsLink - with options (100x)", async (b) => {
  const { runtime, storageManager, tx } = setup();

  const cell1 = runtime.getCell<{ value: number }>(
    space,
    "bench-link-1",
    undefined,
    tx,
  );
  cell1.set({ value: 42 });

  const cell2 = runtime.getCell<{ other: string }>(
    space,
    "bench-link-2",
    undefined,
    tx,
  );
  cell2.set({ other: "test" });
  await tx.commit().settled;

  // Measure link generation with options
  b.start();
  for (let i = 0; i < 100; i++) {
    cell1.getAsLink({ base: cell2, includeSchema: true });
  }
  b.end();

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Subscription operations
//

Deno.bench("Cell sink - subscription execution (100x)", async () => {
  const { runtime, storageManager } = setup();

  let tx = runtime.edit();
  const cell = runtime.getCell<number>(space, "bench-sink", undefined, tx);
  cell.set(0);
  tx.commit();

  let callCount = 0;

  // Setup sink subscription
  const cancel = cell.sink(() => {
    callCount++;
  });

  // Measure sink execution with value changes
  for (let i = 0; i < 100; i++) {
    tx = runtime.edit();
    cell.withTx(tx).set(i + 1); // Set different value each time
    tx.commit();
    await runtime.idle(); // Wait for sink to execute
  }

  // Verify sink was called
  if (callCount !== 101) { // Initial + 100 updates
    throw new Error(`Expected 1001 sink calls, got ${callCount}`);
  }

  // Cleanup subscription
  cancel();

  await cleanup(runtime, storageManager, tx);
});

Deno.bench(
  "Cell sink - subscription execution with schema (100x)",
  async () => {
    const { runtime, storageManager } = setup();

    const schema = {
      type: "object",
      properties: {
        count: { type: "number", minimum: 0 },
        timestamp: { type: "number" },
      },
      required: ["count", "timestamp"],
    } as const satisfies JSONSchema;

    let tx = runtime.edit();
    const cell = runtime.getCell(space, "bench-sink-schema", schema, tx);
    cell.set({ count: 0, timestamp: Date.now() });
    tx.commit();

    let callCount = 0;

    // Setup sink subscription
    const cancel = cell.sink(() => {
      callCount++;
    });

    // Measure sink execution with value changes
    for (let i = 0; i < 100; i++) {
      tx = runtime.edit();
      cell.withTx(tx).set({ count: i + 1, timestamp: Date.now() + i });
      tx.commit();
      await runtime.idle(); // Wait for sink to execute
    }

    // Verify sink was called
    if (callCount !== 101) { // Initial + 100 updates
      throw new Error(`Expected 1001 sink calls, got ${callCount}`);
    }

    // Cleanup subscription
    cancel();

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Benchmark: Complex nested operations
//

Deno.bench("Cell complex - schema with asCell references (100x)", async () => {
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

  const cell = runtime.getCell(space, "bench-asCell-schema", schema, tx);

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

  // Measure access with asCell references
  for (let i = 0; i < 100; i++) {
    const value = cell.get();
    value.id;
    value.metadata.get();
    value.tags;
    value.settings.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell complex - nested cell references (100x)", async () => {
  const { runtime, storageManager, tx } = setup();

  // Create inner cells
  const inner1 = runtime.getCell<{ value: number }>(
    space,
    "bench-inner-1",
    undefined,
    tx,
  );
  inner1.set({ value: 1 });

  const inner2 = runtime.getCell<{ value: number }>(
    space,
    "bench-inner-2",
    undefined,
    tx,
  );
  inner2.set({ value: 2 });

  // Create outer cell with references
  const outer = runtime.getCell<{
    ref1: any;
    ref2: any;
  }>(space, "bench-outer", undefined, tx);

  outer.set({
    ref1: inner1,
    ref2: inner2,
  });
  await tx.commit().settled;

  // Measure nested reference access
  for (let i = 0; i < 100; i++) {
    const proxy = outer.getAsQueryResult();
    proxy.ref1;
    proxy.ref2;
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Schema validation
//

Deno.bench("Cell schema - complex validation (100x)", async () => {
  const { runtime, storageManager } = setup();

  const complexSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0, maximum: 150 },
          email: { type: "string", format: "email" },
        },
        required: ["name", "age"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10,
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["id", "user", "tags"],
  } as const satisfies JSONSchema;

  const cell = runtime.getCell(space, "bench-schema-complex", complexSchema);

  // Measure complex object set with schema validation
  for (let i = 0; i < 100; i++) {
    const tx = runtime.edit();
    cell.withTx(tx).set({
      id: `user-${i}`,
      user: {
        name: `User ${i}`,
        age: 25 + (i % 50),
        email: `user${i}@example.com`,
      },
      tags: ["tag1", "tag2", "tag3"],
      metadata: {
        created: "2025-01-01",
        updated: "2025-01-22",
      },
    });
    tx.commit();
  }

  await cleanup(runtime, storageManager);
});

//
// Benchmark: Large data structures
//

Deno.bench("Cell large - array with 1000 items (100x get)", async () => {
  const { runtime, storageManager, tx } = setup();

  const cell = runtime.getCell<{ items: Array<{ id: number; data: string }> }>(
    space,
    "bench-large-array",
    undefined,
    tx,
  );

  // Create large array
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    data: `item-${i}`,
  }));

  // Measure set operation with large data
  cell.set({ items });
  await tx.commit().settled;

  // Measure get operation with large data
  for (let i = 0; i < 100; i++) {
    cell.get();
  }

  await cleanup(runtime, storageManager, tx);
});

Deno.bench("Cell large - deeply nested object (100x navigation)", async () => {
  const { runtime, storageManager, tx } = setup();

  // Create deeply nested structure
  const createNested = (depth: number): any => {
    if (depth === 0) return { value: 42 };
    return { nested: createNested(depth - 1) };
  };

  const cell = runtime.getCell<any>(
    space,
    "bench-deep-nested",
    undefined,
    tx,
  );

  const deepData = createNested(10); // 10 levels deep
  cell.set(deepData);
  await tx.commit().settled;

  // Measure deep navigation
  for (let i = 0; i < 100; i++) {
    let current = cell;
    for (let j = 0; j < 10; j++) {
      current = current.key("nested");
    }
    current.key("value").get();
  }

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Concurrent operations
//

Deno.bench("Cell concurrent - multiple cells (100x)", async (b) => {
  const { runtime, storageManager, tx } = setup();

  // Create multiple cells
  const cells = Array.from(
    { length: 10 },
    (_, i) =>
      runtime.getCell<number>(space, `bench-concurrent-${i}`, undefined, tx),
  );

  // Initialize cells
  cells.forEach((cell, i) => cell.set(i));
  await tx.commit().settled;

  // Measure concurrent access
  b.start();
  for (let i = 0; i < 100; i++) {
    cells.forEach((cell) => cell.get());
  }
  b.end();

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Cell equals comparison
//

Deno.bench("Cell equals - comparison operations (100x)", async (b) => {
  const { runtime, storageManager, tx } = setup();

  const cell1 = runtime.getCell<number>(space, "bench-equals-1", undefined, tx);
  const cell2 = runtime.getCell<number>(space, "bench-equals-2", undefined, tx);
  const cell1Same = runtime.getCell<number>(
    space,
    "bench-equals-1",
    undefined,
    tx,
  );

  cell1.set(42);
  cell2.set(42);
  await tx.commit().settled;

  // Measure equals operations
  b.start();
  for (let i = 0; i < 100; i++) {
    cell1.equals(cell1Same); // Should be true
    cell1.equals(cell2); // Should be false
  }
  b.end();

  await cleanup(runtime, storageManager, tx);
});

//
// Benchmark: Complex linked document graph (MentionablePiece pattern)
//
// This tests .get() performance on a medium-complexity object spread across
// many documents
//

Deno.bench(
  "Cell complex - MentionablePiece graph (10 top-level, 20 linked each, 100x get)",
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Schema for MentionablePiece with self-referential mentioned/backlinks
    const MentionablePieceSchema = {
      $defs: {
        MentionablePiece: {
          type: "object",
          properties: {
            name: { type: "string" },
            isHidden: { type: "boolean" },
            mentioned: {
              type: "array",
              items: { $ref: "#/$defs/MentionablePiece" },
            },
            backlinks: {
              type: "array",
              items: { $ref: "#/$defs/MentionablePiece" },
            },
          },
        },
      },
      type: "array",
      items: { $ref: "#/$defs/MentionablePiece" },
    } as const satisfies JSONSchema;

    // Create 30 "leaf" pieces that will be referenced (no further links)
    const leafPieces: ReturnType<typeof runtime.getCell>[] = [];
    for (let i = 0; i < 30; i++) {
      const leafCell = runtime.getCell(
        space,
        `bench-leaf-piece-${i}`,
        {
          type: "object",
          properties: {
            name: { type: "string" },
            isHidden: { type: "boolean" },
            mentioned: { type: "array", items: {} },
            backlinks: { type: "array", items: {} },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      leafCell.set({
        name: `Leaf Piece ${i}`,
        isHidden: i % 3 === 0,
        mentioned: [],
        backlinks: [],
      });
      leafPieces.push(leafCell);
    }

    // Create 10 top-level pieces, each linking to ~20 leaf pieces
    const topLevelPieces: ReturnType<typeof runtime.getCell>[] = [];
    for (let i = 0; i < 10; i++) {
      const topCell = runtime.getCell(
        space,
        `bench-top-piece-${i}`,
        {
          type: "object",
          properties: {
            name: { type: "string" },
            isHidden: { type: "boolean" },
            mentioned: { type: "array", items: {} },
            backlinks: { type: "array", items: {} },
          },
        } as const satisfies JSONSchema,
        tx,
      );

      // Each top-level piece mentions 10 leaves and has 10 backlinks
      const mentionedSlice = leafPieces.slice(i * 2, i * 2 + 10);
      const backlinksSlice = leafPieces.slice(
        (i * 2 + 10) % 30,
        ((i * 2 + 10) % 30) + 10,
      );

      topCell.set({
        name: `Top Piece ${i}`,
        isHidden: false,
        mentioned: mentionedSlice,
        backlinks: backlinksSlice,
      });
      topLevelPieces.push(topCell);
    }

    // Create the main array cell containing all top-level pieces
    const mainCell = runtime.getCell(
      space,
      "bench-mentionable-pieces",
      MentionablePieceSchema,
      tx,
    );
    mainCell.set(topLevelPieces);

    await tx.commit().settled;

    // Measure .get() on the full graph 100x
    for (let i = 0; i < 100; i++) {
      const result = mainCell.get();
      // Access some nested data to ensure full traversal
      for (const piece of result) {
        piece.name;
        piece.mentioned;
        piece.backlinks;
      }
    }

    await cleanup(runtime, storageManager, tx);
  },
);

//
// Notebook/Notes pattern: the History.claim() optimization's impact
//
// These benchmarks measure repeated .get() calls on a notebook with linked
// notes. The claim optimization removes O(n²) overhead during reads.
//

const noteSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    noteId: { type: "string" },
  },
};

const notebookSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    notes: {
      type: "array",
      items: noteSchema,
    },
    mentionable: {
      type: "array",
      items: noteSchema,
    },
  },
};

async function benchmarkNotebookReads(noteCount: number, readCount: number) {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  // Write data in tx1
  const tx1 = runtime.edit();
  const notes = [];
  for (let i = 0; i < noteCount; i++) {
    const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
    note.set({
      title: `Note ${i}`,
      content:
        `Content for note ${i} - some additional text to make it realistic`,
      noteId: `note-${i}`,
    });
    notes.push(note);
  }

  const notebook = runtime.getCell(space, "notebook", notebookSchema, tx1);
  notebook.set({
    title: `Notebook with ${noteCount} notes`,
    notes,
    mentionable: notes,
  });

  await tx1.commit().settled;

  // Read in tx2 - this is what we're benchmarking
  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);

  // Measure repeated .get() calls - this is where O(n²) claim overhead shows up
  for (let i = 0; i < readCount; i++) {
    const value = notebookCell.get();
    // Access the data to ensure full traversal
    value.title;
    value.notes;
    value.mentionable;
  }

  await tx2.commit().settled;
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench("Notebook read - 10 notes, 0 reads (setup only)", async () => {
  await benchmarkNotebookReads(10, 0);
});

Deno.bench("Notebook read - 10 notes, 100 reads", async () => {
  await benchmarkNotebookReads(10, 100);
});

Deno.bench("Notebook read - 10 notes, 1000 reads", async () => {
  await benchmarkNotebookReads(10, 1000);
});

Deno.bench("Notebook read - 100 notes, 0 reads (setup only)", async () => {
  await benchmarkNotebookReads(100, 0);
});

Deno.bench("Notebook read - 100 notes, 100 reads", async () => {
  await benchmarkNotebookReads(100, 100);
});

Deno.bench("Notebook read - 100 notes, 1000 reads", async () => {
  await benchmarkNotebookReads(100, 1000);
});

//
// Overhead microbenchmarks for comparison
//

Deno.bench(
  "Overhead - isObjectNotArray check (10000x)",
  { group: "overhead" },
  () => {
    const values = [
      42,
      "string",
      null,
      undefined,
      [],
      {},
      { key: "value" },
    ];
    for (let i = 0; i < 10000; i++) {
      isObjectNotArray(values[i % values.length]);
    }
  },
);

Deno.bench(
  "Overhead - JSON.stringify comparison (1000x)",
  { group: "overhead" },
  () => {
    const obj1 = { value: 42, nested: { data: "test" } };
    const obj2 = { value: 42, nested: { data: "test" } };
    for (let i = 0; i < 1000; i++) {
      JSON.stringify(obj1) === JSON.stringify(obj2);
    }
  },
);
