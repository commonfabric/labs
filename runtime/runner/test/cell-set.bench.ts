/**
 * Benchmarks for `Cell.set()` over complex nested structures with many
 * fields — the shape `navigateTo()` writes when it creates patterns. They
 * separate the number of writes from the size of any one value, so per-write
 * overhead in `tx.writeValueOrThrow()` shows up on its own.
 *
 * These benchmarks test Cell.set() with:
 * - Different data sizes (small, medium, large)
 * - Different nesting depths (shallow, medium, deep)
 * - Different change patterns (full replace, partial update, random mutations)
 * - Complex structures similar to generateObject output
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

const createBenchArrayItems = (length: number) =>
  Array.from({ length }, (_, i) => ({
    id: i,
    value: `item-${i}`,
  }));

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
  tx: IExtendedStorageTransaction,
) {
  await tx.commit().settled;
  await runtime.dispose();
}

//
// DATA SIZE BENCHMARKS
//
// Test how data size affects Cell.set() performance
//

Deno.bench({
  name: "Cell.set() - size: small object (5 fields)",
  group: "size",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-small", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set({
        name: `item-${i}`,
        count: i,
        active: i % 2 === 0,
        score: i * 1.5,
        tag: "test",
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - size: medium object (15 fields)",
  group: "size",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-medium", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set({
        // A person-shaped record
        firstName: `First${i}`,
        lastName: `Last${i}`,
        email: `user${i}@example.com`,
        phone: `555-${i.toString().padStart(4, "0")}`,
        birthday: "1990-01-15",
        occupation: "Engineer",
        company: "Acme Corp",
        location: "San Francisco",
        website: `https://example${i}.com`,
        twitter: `@user${i}`,
        linkedin: `linkedin.com/in/user${i}`,
        bio: `This is the bio for user ${i}`,
        interests: ["coding", "reading"],
        skills: ["typescript", "react"],
        notes: `Additional notes for ${i}`,
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - size: large object (50 fields)",
  group: "size",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-large", undefined, tx);

    for (let i = 0; i < 100; i++) {
      const obj: Record<string, any> = {};
      for (let j = 0; j < 50; j++) {
        obj[`field${j}`] = `value-${i}-${j}`;
      }
      cell.set(obj);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - size: huge object (200 fields)",
  group: "size",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-huge", undefined, tx);

    for (let i = 0; i < 100; i++) {
      const obj: Record<string, any> = {};
      for (let j = 0; j < 200; j++) {
        obj[`field${j}`] = `value-${i}-${j}`;
      }
      cell.set(obj);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// NESTING DEPTH BENCHMARKS
//
// Test how nesting depth affects Cell.set() performance
//

function createNestedObject(depth: number, i: number): any {
  if (depth === 0) {
    return { value: i, data: `leaf-${i}` };
  }
  return {
    level: depth,
    child: createNestedObject(depth - 1, i),
    sibling: { value: i * depth },
  };
}

Deno.bench({
  name: "Cell.set() - depth: shallow (2 levels)",
  group: "depth",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-shallow", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set(createNestedObject(2, i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - depth: medium (5 levels)",
  group: "depth",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-medium-depth",
      undefined,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set(createNestedObject(5, i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - depth: deep (10 levels)",
  group: "depth",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-deep", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set(createNestedObject(10, i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - depth: very deep (20 levels)",
  group: "depth",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-very-deep", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set(createNestedObject(20, i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// CHANGE PATTERN BENCHMARKS
//
// Test how different change patterns affect Cell.set() performance
//

Deno.bench({
  name: "Cell.set() - change: full replace (same structure)",
  group: "change",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-full-replace",
      undefined,
      tx,
    );
    const baseObj = {
      a: 1,
      b: "hello",
      c: { d: 2, e: "world" },
      f: [1, 2, 3],
    };

    cell.set(baseObj);

    // Full replace with same structure but different values
    for (let i = 0; i < 100; i++) {
      cell.set({
        a: i,
        b: `hello-${i}`,
        c: { d: i * 2, e: `world-${i}` },
        f: [i, i + 1, i + 2],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - change: single field modification",
  group: "change",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-single-field",
      undefined,
      tx,
    );
    const baseObj = {
      a: 1,
      b: "hello",
      c: { d: 2, e: "world" },
      f: [1, 2, 3],
    };

    cell.set(baseObj);

    // Change only one field each time
    for (let i = 0; i < 100; i++) {
      cell.set({
        ...baseObj,
        a: i, // Only this changes
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - change: nested field modification",
  group: "change",
  async fn(b) {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-nested-field",
      undefined,
      tx,
    );
    const baseObj = {
      a: 1,
      b: "hello",
      c: { d: 2, e: "world", f: { g: 3, h: "nested" } },
    };

    cell.set(baseObj);

    // Change only deeply nested field
    b.start();
    for (let i = 0; i < 100; i++) {
      cell.set({
        ...baseObj,
        c: {
          ...baseObj.c,
          f: { ...baseObj.c.f, g: i }, // Only this changes
        },
      });
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - change: array element modification",
  group: "change",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-array-mod", undefined, tx);
    const baseArray = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
    }));

    cell.set({ items: baseArray });

    // Modify single array element
    for (let i = 0; i < 100; i++) {
      const newArray = [...baseArray];
      newArray[i % 100] = { id: i, name: `modified-${i}` };
      cell.set({ items: newArray });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - change: random mutations (many fields)",
  group: "change",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-random", undefined, tx);

    // Create initial complex object
    const createObj = (seed: number) => ({
      user: {
        firstName: `First${seed}`,
        lastName: `Last${seed}`,
        age: 20 + (seed % 50),
        email: `user${seed}@example.com`,
      },
      settings: {
        theme: seed % 2 === 0 ? "dark" : "light",
        notifications: seed % 3 === 0,
        language: ["en", "es", "fr"][seed % 3],
      },
      data: {
        scores: [seed, seed * 2, seed * 3],
        metadata: {
          created: `2024-01-${(seed % 28) + 1}`,
          updated: `2024-02-${(seed % 28) + 1}`,
          version: seed,
        },
      },
    });

    cell.set(createObj(0));

    // Randomly mutate different parts
    for (let i = 0; i < 100; i++) {
      cell.set(createObj(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// PERSON-SHAPED WRITE BENCHMARKS
//
// Scenarios shaped like a Person pattern's writes: a 14-field record with
// nested arrays, set once, set repeatedly, and set across many cells.
//

// Schema shaped like the Person pattern
const personSchema = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    birthday: { type: "string" },
    occupation: { type: "string" },
    company: { type: "string" },
    location: { type: "string" },
    website: { type: "string" },
    twitter: { type: "string" },
    linkedin: { type: "string" },
    bio: { type: "string" },
    interests: { type: "array", items: { type: "string" } },
    skills: { type: "array", items: { type: "string" } },
  },
} as const satisfies JSONSchema;

function createPersonData(i: number) {
  return {
    firstName: `Maya${i}`,
    lastName: `Rodriguez${i}`,
    email: `maya${i}@biotech.com`,
    phone: `617-555-${i.toString().padStart(4, "0")}`,
    birthday: "1988-11-03",
    occupation: "Biotech Researcher",
    company: "GeneTech Labs",
    location: "Boston, MA",
    website: `https://mayarodriguez${i}.com`,
    twitter: `@drmayar${i}`,
    linkedin: `linkedin.com/in/maya-rodriguez-${i}`,
    bio:
      `Biotech researcher specializing in CRISPR gene editing. Lead scientist at GeneTech Labs. Published ${
        25 + i
      } peer-reviewed papers.`,
    interests: ["gene editing", "rock climbing", "research"],
    skills: ["CRISPR", "molecular biology", "data analysis", "Spanish"],
  };
}

Deno.bench({
  name: "Person-like schema (14 fields) - schemaless",
  group: "person",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-person-schemaless",
      undefined,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set(createPersonData(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Person-like schema (14 fields) - with schema",
  group: "person",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell(
      space,
      "bench-person-schema",
      personSchema,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set(createPersonData(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Multiple cells with Person data (simulating navigateTo)",
  group: "person",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    // Simulate creating multiple cells like navigateTo does
    for (let i = 0; i < 100; i++) {
      const cell = runtime.getCell<any>(
        space,
        `bench-person-multi-${i}`,
        undefined,
        tx,
      );
      cell.set(createPersonData(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Set then update same cell repeatedly",
  group: "person",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-person-update",
      undefined,
      tx,
    );

    // Initial set
    cell.set(createPersonData(0));

    // Update same cell repeatedly (like extracting data multiple times)
    for (let i = 1; i < 100; i++) {
      cell.set(createPersonData(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// ARRAY SIZE BENCHMARKS
//
// Test how array sizes affect performance (the shape of a Person pattern's
// interests/skills arrays)
//

Deno.bench({
  name: "Cell.set() - array: small (10 items)",
  group: "array",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-array-small",
      undefined,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set({
        items: Array.from({ length: 10 }, (_, j) => ({
          id: j,
          value: `item-${i}-${j}`,
        })),
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - array: medium (100 items)",
  group: "array",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-array-medium",
      undefined,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set({
        items: Array.from({ length: 100 }, (_, j) => ({
          id: j,
          value: `item-${i}-${j}`,
        })),
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// ARRAY STRUCTURE BENCHMARKS
//
// Test path-level array structural edits
//

Deno.bench({
  name: "Cell.set() - array: path replace truncation (100↔50 items)",
  group: "array-structure",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-array-path-truncate",
      undefined,
      tx,
    );

    const full = createBenchArrayItems(100);
    const truncated = full.slice(0, 50);
    cell.set({ items: full });

    for (let i = 0; i < 100; i++) {
      cell.key("items").set(i % 2 === 0 ? truncated : full);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - array: length path write (100↔50 items)",
  group: "array-structure",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-array-length-path",
      undefined,
      tx,
    );

    cell.set({ items: createBenchArrayItems(100) });

    for (let i = 0; i < 100; i++) {
      cell.key("items").key("length").set(i % 2 === 0 ? 50 : 100);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

// NOTE: A "large (500 items)" array benchmark was removed because it took ~96s
// per iteration. Profiling showed 95% of that time was spent in SQLite writes
// during tx.commit() (~150-200K prepared statement executions for 50K changed
// facts), not in Cell.set() itself (~3.4s for all 100 iterations). The benchmark
// was measuring SQLite write throughput rather than Cell.set() performance.

//
// WRITE COUNT BENCHMARKS
//
// Test bursts of many writes into one cell (~50 to ~500 leaf values)
//

Deno.bench({
  name: "Cell.set() - write count: ~50 writes (small complex object)",
  group: "writes",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    // Object with ~50 leaf values
    const cell = runtime.getCell<any>(space, "bench-50-writes", undefined, tx);

    const obj = {
      section1: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
      section2: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
      section3: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
      section4: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
      section5: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`field${i}`, `value${i}`]),
      ),
    };

    for (let i = 0; i < 10; i++) {
      cell.set(obj);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - write count: ~200 writes (medium complex object)",
  group: "writes",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    // Object with ~200 leaf values
    const cell = runtime.getCell<any>(space, "bench-200-writes", undefined, tx);

    const createSection = (prefix: string) =>
      Object.fromEntries(
        Array.from(
          { length: 20 },
          (_, i) => [`${prefix}_field${i}`, `value${i}`],
        ),
      );

    const obj = {
      section1: createSection("s1"),
      section2: createSection("s2"),
      section3: createSection("s3"),
      section4: createSection("s4"),
      section5: createSection("s5"),
      section6: createSection("s6"),
      section7: createSection("s7"),
      section8: createSection("s8"),
      section9: createSection("s9"),
      section10: createSection("s10"),
    };

    for (let i = 0; i < 10; i++) {
      cell.set(obj);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - write count: ~500 writes (large complex object)",
  group: "writes",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    // Object with ~500 leaf values
    const cell = runtime.getCell<any>(space, "bench-500-writes", undefined, tx);

    const createSection = (prefix: string) =>
      Object.fromEntries(
        Array.from(
          { length: 25 },
          (_, i) => [`${prefix}_field${i}`, `value${i}`],
        ),
      );

    const obj: Record<string, any> = {};
    for (let s = 0; s < 20; s++) {
      obj[`section${s}`] = createSection(`s${s}`);
    }

    for (let i = 0; i < 10; i++) {
      cell.set(obj);
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// SCHEMA WITH NESTED CELLS (asCell: ["cell"])
//
// Test performance impact of asCell which creates sub-cell references
//

const schemaWithAsCell = {
  type: "object",
  properties: {
    name: { type: "string" },
    profile: {
      type: "object",
      properties: {
        bio: { type: "string" },
        avatar: { type: "string" },
      },
      asCell: ["cell"],
    },
    settings: {
      type: "object",
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" },
      },
      asCell: ["cell"],
    },
    metadata: {
      type: "object",
      properties: {
        created: { type: "string" },
        updated: { type: "string" },
      },
      asCell: ["cell"],
    },
  },
} as const satisfies JSONSchema;

Deno.bench({
  name: "Cell.set() - schema: without asCell references",
  group: "ascell",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-no-ascell", undefined, tx);

    for (let i = 0; i < 100; i++) {
      cell.set({
        name: `User ${i}`,
        profile: { bio: `Bio for ${i}`, avatar: `avatar${i}.png` },
        settings: { theme: "dark", notifications: true },
        metadata: { created: "2024-01-01", updated: "2024-02-01" },
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - schema: with asCell references",
  group: "ascell",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell(
      space,
      "bench-with-ascell",
      schemaWithAsCell,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set({
        name: `User ${i}`,
        profile: { bio: `Bio for ${i}`, avatar: `avatar${i}.png` },
        settings: { theme: "dark", notifications: true },
        metadata: { created: "2024-01-01", updated: "2024-02-01" },
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

//
// TRANSACTION OVERHEAD BENCHMARKS
//
// Test if transaction management adds overhead
//

Deno.bench({
  name: "Cell.set() - single transaction, many sets",
  group: "transaction",
  baseline: true,
  async fn(b) {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(space, "bench-single-tx", undefined, tx);

    b.start();
    for (let i = 0; i < 100; i++) {
      cell.set({ value: i, data: `test-${i}` });
    }
    b.end();

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.set() - multiple transactions, one set each",
  group: "transaction",
  async fn() {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    for (let i = 0; i < 100; i++) {
      const tx = runtime.edit();
      const cell = runtime.getCell<any>(space, "bench-multi-tx", undefined, tx);
      cell.set({ value: i, data: `test-${i}` });
      await tx.commit().settled;
    }

    await runtime.dispose();
    await storageManager.close();
  },
});

//
// CELL.UPDATE() vs CELL.SET() COMPARISON
//
// Test if update() is more efficient than set() for partial changes
//

Deno.bench({
  name: "Cell.update() vs set() - update() for partial changes",
  group: "update-vs-set",
  baseline: true,
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-update-partial",
      undefined,
      tx,
    );
    cell.set({
      name: "test",
      count: 0,
      nested: { value: 0 },
      array: [1, 2, 3],
    });

    for (let i = 0; i < 100; i++) {
      cell.update({ count: i });
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell.update() vs set() - set() for partial changes",
  group: "update-vs-set",
  async fn() {
    const { runtime, storageManager, tx } = setup();

    const cell = runtime.getCell<any>(
      space,
      "bench-set-partial",
      undefined,
      tx,
    );
    const baseObj = {
      name: "test",
      count: 0,
      nested: { value: 0 },
      array: [1, 2, 3],
    };
    cell.set(baseObj);

    for (let i = 0; i < 100; i++) {
      cell.set({ ...baseObj, count: i });
    }

    await cleanup(runtime, storageManager, tx);
  },
});
