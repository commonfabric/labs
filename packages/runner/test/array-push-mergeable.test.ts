import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import {
  getDirectTransactionMergeableOpAddresses,
  getDirectTransactionNativeCommit,
} from "../src/storage/transaction-inspection.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";

const signer = await Identity.fromPassphrase("array-push-mergeable");
const space = signer.did();
const CAUSE = "mergeable-append-list";
const COUNTER_CAUSE = "mergeable-counter";

const stringListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

const nestedListSchema = {
  type: "array",
  items: { type: "array", items: { type: "string" } },
  // deno-lint-ignore no-explicit-any
} as any;

const numberSchema = {
  type: "number",
  // deno-lint-ignore no-explicit-any
} as any;

// A permissive schema that accepts any value, so a cell can hold a scalar that
// the array/number mergeable methods then reject.
const anySchema = {
  // deno-lint-ignore no-explicit-any
} as any;

// Read the durable array from a fresh session that pulls it straight off the
// shared server, so the assertion reflects committed/durable state rather than
// any one writer's optimistic local view.
async function readDurable(
  server: MemoryV2Server.Server,
): Promise<string[]> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as string[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

// The same fresh-session read for a list whose elements are themselves lists.
async function readDurableNested(
  server: MemoryV2Server.Server,
  cause: string,
): Promise<string[][]> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<string[][]>(space, cause, nestedListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as string[][];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

async function readDurableNumber(
  server: MemoryV2Server.Server,
): Promise<number | undefined> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema);
    await cell.sync();
    await cell.pull();
    return cell.get();
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

// The same fresh-session read for a cell of any schema.
async function readDurableValue(
  server: MemoryV2Server.Server,
  cause: string,
  // deno-lint-ignore no-explicit-any
  schema: any,
): Promise<unknown> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell(space, cause, schema);
    await cell.sync();
    await cell.pull();
    return cell.get();
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("mergeable array appends", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("two concurrent appends to the same list both survive", async () => {
    // Two sessions append to the same list against the SAME base, neither
    // having observed the other's append before committing. Both appends
    // represent real user intent on disjoint tail slots, so both must survive
    // durably.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Seed the list with one element and get it durable on the server.
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Both sessions load the seeded list. After this both replicas hold
      // ["seed"] at the same basis sequence.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A".
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 appends "B" WITHOUT having observed session 1's "A": its
      // replica still holds ["seed"] at the pre-"A" basis.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("B");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two concurrent pushAll appends to the same list both survive in order", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).pushAll([
        "A1",
        "A2",
      ]);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 has not observed session 1's append.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).pushAll([
        "B1",
        "B2",
      ]);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurable(server)).toEqual([
        "seed",
        "A1",
        "A2",
        "B1",
        "B2",
      ]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a conditional push (explicit read before push) conflicts with a concurrent append", async () => {
    // A CONDITIONAL push — the handler reads the list explicitly before pushing
    // (the dedup-then-push shape) — must keep its read in the conflict set, so
    // a concurrent append makes it conflict (and, in the live system, retry).
    // This is the opposite of the unconditional case above, which merges. It
    // proves the read drop is scoped to the op's own reads, not the handler's
    // explicit read.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 appends "A".
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the pre-"A" basis, reads the list explicitly and
      // then pushes — the dedup-then-push shape. The explicit read is retained,
      // so the commit conflicts with session 1's append.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      cellB.get();
      cellB.push("B");
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a length-derived push conflicts with a concurrent append", async () => {
    // A push whose new element is derived from the array's LENGTH is a
    // conditional push: its correctness depends on the count it read. The
    // length read is recorded as the array's own `length` child path — the
    // shape produced by a `for...of`/spread over the array, a shape-only
    // `length` access, or `key("length")`. That read must stay in the conflict
    // set: a mergeable append changes the length, so a concurrent append has to
    // make this commit conflict (and retry against the new tail) instead of the
    // push merging with a stale index. Before the length read was kept, session
    // 2 read length 1, both sessions computed the same index, and the append
    // silently merged with a duplicate index.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 appends "A", moving the durable length from 1 to 2.
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the pre-"A" basis, reads the length (1) and pushes an
      // element positioned at that length. The length read conflicts with session
      // 1's append.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const len = (cellB.key("length") as unknown as Cell<number>).get();
      cellB.push(`item-${len}`);
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a for...of count before a push conflicts with a concurrent append", async () => {
    // The same protection through the query-result proxy's iterator: a handler
    // that counts the array with `for...of` (or a spread) before pushing
    // records the array's `length` read, so a concurrent append conflicts.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const proxy = cellB.getAsQueryResult([], txB) as unknown as string[];
      let count = 0;
      for (const _ of proxy) count++;
      cellB.push(`item-${count}`);
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a length-derived push merges past a concurrent edit to an existing element", async () => {
    // The length read stays precise: it conflicts with a change to the element
    // COUNT (an append), not with an edit to an existing element. A concurrent
    // edit to an element the length-reading session did not append leaves the
    // length unchanged, so the append still merges — the length read must not
    // over-conflict the way a whole-array `.get()` read would.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 edits the existing element 0 in place; the length stays 1.
      const txA = rt1.edit();
      (rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA)
        .key("0") as unknown as Cell<string>).set("edited");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 reads the length and pushes; the length did not change, so the
      // append merges on top of the edit.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const len = (cellB.key("length") as unknown as Cell<number>).get();
      cellB.push(`item-${len}`);
      const result = await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(result.error).toBeUndefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["edited", "item-1"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a bare proxy `.length` read before a push conflicts with a concurrent append", async () => {
    // Bare `.length` on the query-result proxy (the get trap) reads the whole
    // array recursively at the op path, so it is already kept as the handler's
    // explicit read and conflicts with a concurrent append even without the
    // length-child carve-out. This pins that end-to-end guarantee for the most
    // common form: a change that ever recorded bare `.length` as a shape-only
    // read AT the op path (which `buildReads` drops as the proxy's incidental
    // container read) would fail here, forcing the count dependency to stay in
    // the conflict set.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const proxy = cellB.getAsQueryResult([], txB) as unknown as string[];
      const len = proxy.length;
      cellB.push(`item-${len}`);
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("an Object.keys(proxy).length-derived push conflicts with a concurrent append", async () => {
    // Enumerating the array's keys (`Object.keys`/`values`/`entries`, or an
    // object spread) observes the present-key set — the proxy's ownKeys trap
    // records a recursive read of the array for that. So a push whose new
    // element came from `Object.keys(arr).length` conflicts with a concurrent
    // append (and, per the sparse test below, with a concurrent hole edit); an
    // unconditional push, which never enumerates, still merges.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const proxy = cellB.getAsQueryResult([], txB) as unknown as string[];
      const len = Object.keys(proxy).length;
      cellB.push(`item-${len}`);
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a length-read addUnique conflicts with a concurrent addUnique", async () => {
    // The carve-out is not push-specific: it keeps the length read for every
    // mergeable op. An addUnique whose added value or decision depended on the
    // count must conflict with a concurrent count-changing op, even when the
    // added element is a distinct key that would otherwise merge. A transaction
    // that reads the length forfeits that transaction's distinct-element merge.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).addUnique("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const len = (cellB.key("length") as unknown as Cell<number>).get();
      cellB.addUnique(`item-${len}`);
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("an append against a stale-short base does not clobber the durable tail", async () => {
    // A single session appends to a list whose durable head it has not yet
    // observed (the rehydration-race shape): it reads the list as shorter/empty
    // than it durably is, then appends. The append must land at the durable
    // tail, never clobbering elements it could not see.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Session 2 establishes a replica of the (initially empty) entity.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();

      // Session 1 creates the list with two durable elements.
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["one", "two"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 appends "three" while its replica is still stale-short (it has
      // not pulled ["one","two"]).
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("three");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toContain("one");
      expect(durable).toContain("two");
      expect(durable).toContain("three");
      expect(durable.length).toBe(3);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  describe("a push onto a list set to `undefined`", () => {
    // Setting a list to `undefined` leaves its slot holding `undefined`. A push
    // onto that slot commits a list of what it pushed, as a push onto a
    // missing list does.

    it("commits a list of the pushed element", async () => {
      const rt1 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage1,
      });
      try {
        // The list has to exist first: setting a missing list to `undefined`
        // writes nothing, and leaves no slot.
        const tx0 = rt1.edit();
        rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
        await tx0.commit({ resolveAt: "verdict" });
        const tx1 = rt1.edit();
        rt1.getCell<string[] | undefined>(space, CAUSE, stringListSchema, tx1)
          .set(undefined);
        await tx1.commit({ resolveAt: "verdict" });
        await rt1.storageManager.synced();

        const tx = rt1.edit();
        rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx).push("b");
        const result = await tx.commit({ resolveAt: "verdict" });
        expect(result.error).toBeUndefined();
        await rt1.storageManager.synced();

        expect(await readDurable(server)).toEqual(["b"]);
      } finally {
        await rt1.dispose();
      }
    });

    it("commits a list of the pushed element from a session that still sees the old list", async () => {
      const rt1 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage1,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage2,
      });
      try {
        const tx0 = rt1.edit();
        rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
        await tx0.commit({ resolveAt: "verdict" });
        await rt1.storageManager.synced();

        // Session 2 loads `["a"]` and, with fan-out held, keeps seeing it.
        const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
        await cell2.sync();
        await cell2.pull();
        expect(cell2.get()).toEqual(["a"]);

        const tx1 = rt1.edit();
        rt1.getCell<string[] | undefined>(space, CAUSE, stringListSchema, tx1)
          .set(undefined);
        await tx1.commit({ resolveAt: "verdict" });
        await rt1.storageManager.synced();

        const tx2 = rt2.edit();
        rt2.getCell<string[]>(space, CAUSE, stringListSchema, tx2).push("b");
        const result = await tx2.commit({ resolveAt: "verdict" });
        expect(result.error).toBeUndefined();
        await rt2.storageManager.synced();

        expect(await readDurable(server)).toEqual(["b"]);
      } finally {
        await rt2.dispose();
        await rt1.dispose();
      }
    });
  });

  it("an edit to an existing element survives alongside a push in the same tx", async () => {
    // A single transaction that both edits an existing element and appends must
    // keep the edit: the append op covers only the appended tail, not the
    // edited prefix slot.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["one", "two"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.key(0).set("ONE");
      cell.push("three");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toEqual(["ONE", "two", "three"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("addUnique then push in one tx commits both (no silent drop)", async () => {
    // Two different mergeable op kinds on the same array path in one
    // transaction. The intent map holds one op per path, so the second would
    // replace the first and the diff-suppression would then drop the first op's
    // element from the commit. The path is poisoned instead and the whole-array
    // diff carries both changes.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.addUnique("a");
      cell.push("b");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["seed", "a", "b"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("removeByValue then addUnique in one tx commits both", async () => {
    // The "update my entry" idiom: remove the old value and add the new one in
    // one handler. remove-by-value and add-unique are different op kinds, so
    // the path is poisoned and the whole-array diff commits the correct result.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0)
        .set(["seed", "old"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.removeByValue("old");
      cell.addUnique("new");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["seed", "new"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("push then a whole-array set commits the set array", async () => {
    // A whole-array Cell.set after a push reshapes the array; the append intent
    // is poisoned so the commit emits the set's array, not a tail op sliced
    // from it.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.push("b");
      cell.set(["x", "y", "z"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["x", "y", "z"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a same-length whole-array set then a push commits the replaced list", async () => {
    // A whole-array set that replaces every element without changing the
    // length or the hole layout, then a push. The set says what the list
    // holds, so the push after it is committed as part of that value and
    // records no op.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set(["x", "y", "z"]);
      cell.push("d");
      expect([...(getDirectTransactionMergeableOpAddresses(tx1) ?? [])])
        .toEqual([]);
      expect(cell.get()).toEqual(["x", "y", "z", "d"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["x", "y", "z", "d"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a same-length whole-array set then a push is refused when another session appended meanwhile", async () => {
    // Session 2 sets and pushes without reading the list, from a view that
    // lacks session 1's append. Sent as replacements and an append, its
    // writes would land around that element and leave five where its set
    // said four.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 loads the three elements and, with fan-out held, keeps
      // seeing them.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const tx1 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1).push("d");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx2 = rt2.edit();
      const stale = rt2.getCell<string[]>(space, CAUSE, stringListSchema, tx2);
      stale.set(["x", "y", "z"]);
      stale.push("w");
      const result = await tx2.commit({ resolveAt: "verdict" });
      expect(result.error?.name).toBe("ConflictError");

      expect(await readDurable(server)).toEqual(["a", "b", "c", "d"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a set that punches a hole then a push commits the hole", async () => {
    // A same-length set that changes the array's hole layout, then a push.
    // Sparse arrays are preserved elsewhere in the runner, so the hole must
    // survive the round trip.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const punched: string[] = [];
      punched[1] = "b";
      punched[2] = "c";

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set(punched);
      cell.push("d");
      expect(0 in (cell.get() as string[])).toBe(false);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable.length).toBe(4);
      // The hole survived rather than the base's "a" being retained under it.
      expect(0 in durable).toBe(false);
      expect(durable[1]).toBe("b");
      expect(durable[3]).toBe("d");
    } finally {
      await rt1.dispose();
    }
  });

  it("an absent cell set to a sparse array then pushed commits the hole", async () => {
    // No base at all: a previously absent cell set to a sparse array, then
    // pushed. The hole has to survive, and the write has to land.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const SPARSE_CAUSE = "absent-sparse-append";
    try {
      const sparse: string[] = [];
      sparse[1] = "b";
      sparse[2] = "c";

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(
        space,
        SPARSE_CAUSE,
        stringListSchema,
        tx1,
      );
      cell.set(sparse);
      cell.push("d");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const storage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const readBack = rt2.getCell<string[]>(
          space,
          SPARSE_CAUSE,
          stringListSchema,
        );
        await readBack.sync();
        await readBack.pull();
        const durable = readBack.get();
        expect(durable).toBeDefined();
        expect(durable!.length).toBe(4);
        expect(0 in durable!).toBe(false);
        expect(durable![1]).toBe("b");
        expect(durable![3]).toBe("d");
      } finally {
        await rt2.dispose();
        await storage.close();
      }
    } finally {
      await rt1.dispose();
    }
  });

  it("a set that fills a hole then a push commits the filled value", async () => {
    // The reverse: the base is sparse and the set fills the hole, same length.
    // The filled value is committed with the rest of the replacement.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const seed: string[] = [];
      seed[1] = "b";
      seed[2] = "c";
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(seed);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set(["A", "b", "c"]);
      cell.push("d");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["A", "b", "c", "d"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a push then an element edit keeps the push mergeable and commits both", async () => {
    // An element edit alongside a push is the composition the fallback must NOT
    // swallow: the edit is a per-index candidate below the tail, it survives
    // suppression, and the push stays mergeable. This is the case that stops
    // the guard from being tightened into "the prefix must be untouched", and
    // that pins the poison's direction — a write BENEATH an array must not
    // reach the array's own intent.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      // Push FIRST, so an intent exists when the edit's write fires the poison.
      // The other order proves nothing: with no intent recorded yet there is
      // nothing for a wrongly-widened poison to destroy.
      cell.push("d");
      cell.key(1).set("B");
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 appends against the pre-edit basis. The edit-plus-push
      // transaction stayed mergeable, so this merges rather than clobbering.
      const tx2 = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, tx2).push("z");
      await tx2.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurable(server)).toEqual(["a", "B", "c", "d", "z"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a shrinking whole-array set then a push commits the shrunk list", async () => {
    // A whole-array set that SHRINKS the list, then a push. The set removed "b"
    // and "c"; a tail op cannot express that removal, and its suppression
    // covers the very diff candidates that would have carried it, so the
    // removal must keep the path off the mergeable fast path.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set(["a"]);
      cell.push("d");
      expect(cell.get()).toEqual(["a", "d"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["a", "d"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a whole-array set([]) then addUnique commits only the added members", async () => {
    // The clear-and-reseed idiom: empty the list, then add the replacement
    // members back with `addUnique`. The replacements are new values, so the
    // server's add-unique dedup cannot mask the lost clear — the durable list
    // must hold the reseeded members alone, not the cleared ones plus the
    // additions.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set([]);
      cell.addUnique("x", "y");
      expect(cell.get()).toEqual(["x", "y"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["x", "y"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a parent-object set that shrinks a nested list then a push commits the shrunk list", async () => {
    // The same reshape reached from a parent path, landing ahead of the op: a
    // write to an enclosing object says what the list inside it holds too.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const holderSchema = {
      type: "object",
      properties: { rows: stringListSchema },
      // deno-lint-ignore no-explicit-any
    } as any;
    const HOLDER_CAUSE = "nested-shrink-holder";
    try {
      const tx0 = rt1.edit();
      rt1.getCell(space, HOLDER_CAUSE, holderSchema, tx0).set({
        rows: ["a", "b", "c"],
      });
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const holder = rt1.getCell(space, HOLDER_CAUSE, holderSchema, tx1);
      holder.set({ rows: ["a"] });
      holder.key("rows").push("d");
      expect(holder.get()).toEqual({ rows: ["a", "d"] });
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const storage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const cell = rt2.getCell(space, HOLDER_CAUSE, holderSchema);
        await cell.sync();
        await cell.pull();
        expect(cell.get()).toEqual({ rows: ["a", "d"] });
      } finally {
        await rt2.dispose();
        await storage.close();
      }
    } finally {
      await rt1.dispose();
    }
  });

  it("a push into a just-appended nested list commits its element once", async () => {
    // Nested tail ops where one op's PAYLOAD contains the other's target: push
    // a new inner list onto the outer list, then push into that inner list. A
    // tail op's payload is read from the working array at commit, so the outer
    // append already carries the inner list complete with the element the inner
    // append would add again — the store would apply it twice. Only the durable
    // value shows it: the writer's own local value is correct throughout.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const NESTED_CAUSE = "nested-tail-inside-tail";
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[][]>(space, NESTED_CAUSE, nestedListSchema, tx0)
        .set([["a"]]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const outer = rt1.getCell<string[][]>(
        space,
        NESTED_CAUSE,
        nestedListSchema,
        tx1,
      );
      outer.push(["x"]);
      (outer.key(1) as unknown as Cell<string[]>).push("y");
      expect(outer.get()).toEqual([["a"], ["x", "y"]]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurableNested(server, NESTED_CAUSE)).toEqual([
        ["a"],
        ["x", "y"],
      ]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a push into a pre-existing nested list stays mergeable alongside an outer push", async () => {
    // The same two pushes with the inner one landing BEFORE the outer tail:
    // that element is not in the outer append's payload, so both ops are sent
    // and the durable value has to come out of the two of them applied
    // together. That combination is what this pins; that the inner op stays a
    // live intent rather than falling back is pinned on the intents themselves
    // ("nested tail ops abandon only the contained one", below) — a durable
    // value cannot show it, since a concurrent append is add-wins and lands
    // either way.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    const NESTED_CAUSE = "nested-tail-before-tail";
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[][]>(space, NESTED_CAUSE, nestedListSchema, tx0)
        .set([["a"], ["b"]]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[][]>(
        space,
        NESTED_CAUSE,
        nestedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const tx1 = rt1.edit();
      const outer = rt1.getCell<string[][]>(
        space,
        NESTED_CAUSE,
        nestedListSchema,
        tx1,
      );
      outer.push(["x"]);
      (outer.key(0) as unknown as Cell<string[]>).push("y");
      expect(outer.get()).toEqual([["a", "y"], ["b"], ["x"]]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 appends against the pre-push basis. Both ops above stayed
      // mergeable, so this merges rather than clobbering.
      const tx2 = rt2.edit();
      rt2.getCell<string[][]>(space, NESTED_CAUSE, nestedListSchema, tx2)
        .push(["z"]);
      await tx2.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurableNested(server, NESTED_CAUSE)).toEqual([
        ["a", "y"],
        ["b"],
        ["x"],
        ["z"],
      ]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("a mixed-op (poisoned) transaction conflicts with a concurrent append", async () => {
    // A poisoned path forfeits merge-friendliness: because it commits as a
    // whole-array diff whose reads are kept, a mixed-op transaction conflicts
    // with a concurrent append instead of merging — the intended trade for
    // never losing data on the mixed-op path.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0)
        .set(["seed", "old"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, at the pre-"A" basis, does the mixed-op "update my entry"
      // (remove old, add new) — a poisoned path, committed as a value diff.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      cellB.removeByValue("old");
      cellB.addUnique("new");
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      expect(await readDurable(server)).toEqual(["seed", "old", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("an `n in arr`-derived push conflicts with a concurrent append", async () => {
    // Probing whether a numeric index exists (`n in arr`) observes the element
    // count, so an `n in arr`-derived push conflicts with a concurrent append.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const proxy = cellB.getAsQueryResult([], txB) as unknown as string[];
      cellB.push(1 in proxy ? "had-1" : "no-1");
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      expect(await readDurable(server)).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("an `n in arr`-derived push conflicts with a concurrent same-length hole fill", async () => {
    // Arrays can be sparse (holes below `length`). Filling or punching a hole
    // changes the present-key set without changing `length`, so an enumeration
    // or `n in arr` probe that fed a push must conflict with a concurrent
    // same-length hole edit. A `length`-only dependency would miss it; the
    // ownKeys/has traps record a recursive read for arrays, which a hole edit
    // invalidates.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      // ["a", <hole>, "c"] — length 3, index 1 absent.
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(
        ["a", , "c"] as string[],
      );
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 fills the hole at index 1: same length (3), present-key set
      // changes. No `length` write.
      const txA = rt1.edit();
      (rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA)
        .key(1) as unknown as Cell<string>).set("b");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, at the pre-fill basis, probes `1 in arr` (false) and pushes.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      const proxy = cellB.getAsQueryResult([], txB) as unknown as string[];
      cellB.push(1 in proxy ? "had-1" : "no-1");
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeDefined();
      expect(await readDurable(server)).toEqual(["a", "b", "c"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two concurrent add-uniques of distinct elements both survive", async () => {
    // Two sessions add distinct elements to the same set against the same base.
    // Both are real intents on the set, so both must survive.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).addUnique("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2 still holds ["seed"] (has not observed "A").
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).addUnique("B");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("concurrent add-unique of the same element is idempotent", async () => {
    // Two sessions add the SAME element against the same base. add-unique
    // dedups against durable state on the server, so the element appears once.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).addUnique("X");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2 adds "X" too, against its stale ["seed"] base — it never observed
      // rt1's add.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).addUnique("X");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "X"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two concurrent increments sum", async () => {
    // Two sessions increment the same counter against the same base. Increments
    // sum against durable state rather than clobber via last-write-wins.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx0).set(0);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<number>(space, COUNTER_CAUSE, numberSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toBe(0);

      const txA = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, txA).increment(1);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2 still reads 0 (has not observed rt1's increment).
      const txB = rt2.edit();
      rt2.getCell<number>(space, COUNTER_CAUSE, numberSchema, txB).increment(1);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(2);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("increment on a missing value implies a zero default", async () => {
    // Incrementing a counter that was never set treats the missing value as a
    // zero default: the durable value becomes the increment amount.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx).increment(5);
      await tx.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(5);
    } finally {
      await rt1.dispose();
    }
  });

  it("two concurrent removeByValue of distinct elements both land", async () => {
    // Two sessions remove distinct elements concurrently; both removals must
    // land (they merge against durable state rather than clobber via a
    // whole-array set).

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA)
        .removeByValue("a");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2, still holding ["a","b","c"], removes a different element.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB)
        .removeByValue("c");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurable(server)).toEqual(["b"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("an element edit before a removeByValue survives the removal", async () => {
    // The ordinary "edit one row and delete another in the same handler" shape.
    // A remove-by-value suppresses the array path AND everything under it, so
    // the edit's per-index candidate has no surviving carrier: without the
    // builder's own commit-time check the store applies the removal to the
    // untouched base and the edit is gone, while the writing session's local
    // value shows it. The edit writes BENEATH the array, so it deliberately
    // does not poison the intent — the check at build is the only thing that
    // can catch this.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.key(0).set("A");
      cell.removeByValue("c");
      expect(cell.get()).toEqual(["A", "b"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["A", "b"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("an element edit after a removeByValue survives the removal", async () => {
    // The same composition in the other order. Recording the op first does not
    // help: the edit still lands beneath the array and leaves the intent alive,
    // so the suppression discards it just the same.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.removeByValue("c");
      cell.key(0).set("A");
      expect(cell.get()).toEqual(["A", "b"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["A", "b"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a whole-array set before a removeByValue commits the set array", async () => {
    // A whole-array set BEFORE the removal: no intent exists yet for the set's
    // write to poison, so the op is recorded against an array the transaction
    // had already replaced. Its suppression then discards the set's entire diff
    // and only the removals reach the store, leaving the durable list untouched
    // apart from them.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.set(["p", "q"]);
      cell.removeByValue("p");
      expect(cell.get()).toEqual(["q"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      expect(await readDurable(server)).toEqual(["q"]);
    } finally {
      await rt1.dispose();
    }
  });

  it("a removeByValue on an array the transaction created commits the array", async () => {
    // Creating the array and removing from it in one transaction: there is no
    // base array for the op to describe at all. The removals alone say nothing
    // about the elements the transaction created, and the subtree suppression
    // discards the diff that carries them — so without the fallback the entity
    // is never written and the durable value stays absent.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const CREATED_CAUSE = "created-then-removed-list";
    try {
      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(
        space,
        CREATED_CAUSE,
        stringListSchema,
        tx1,
      );
      cell.set(["p", "q"]);
      cell.removeByValue("p");
      expect(cell.get()).toEqual(["q"]);
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const storage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const readBack = rt2.getCell<string[]>(
          space,
          CREATED_CAUSE,
          stringListSchema,
        );
        await readBack.sync();
        await readBack.pull();
        expect(readBack.get()).toEqual(["q"]);
      } finally {
        await rt2.dispose();
        await storage.close();
      }
    } finally {
      await rt1.dispose();
    }
  });

  it("a parent-object set before a nested removeByValue commits the set list", async () => {
    // The same reshape reached from a PARENT path — a `set` on the enclosing
    // object, landing before the op, so neither the write-time poison (nothing
    // recorded yet) nor a check scoped to the array's own path would see it.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const holderSchema = {
      type: "object",
      properties: { rows: stringListSchema },
      // deno-lint-ignore no-explicit-any
    } as any;
    const HOLDER_CAUSE = "nested-remove-holder";
    try {
      const tx0 = rt1.edit();
      rt1.getCell(space, HOLDER_CAUSE, holderSchema, tx0).set({
        rows: ["a", "b", "c"],
      });
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const holder = rt1.getCell(space, HOLDER_CAUSE, holderSchema, tx1);
      holder.set({ rows: ["p", "q"] });
      holder.key("rows").removeByValue("p");
      expect(holder.get()).toEqual({ rows: ["q"] });
      await tx1.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const storage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const cell = rt2.getCell(space, HOLDER_CAUSE, holderSchema);
        await cell.sync();
        await cell.pull();
        expect(cell.get()).toEqual({ rows: ["q"] });
      } finally {
        await rt2.dispose();
        await storage.close();
      }
    } finally {
      await rt1.dispose();
    }
  });

  it("a removeByValue stays mergeable when the other change is to a sibling field", async () => {
    // The fallback is scoped: a removal that IS the transaction's only change
    // to the array stays mergeable, so two sessions removing distinct elements
    // against the same base still merge. Without this the fix would trade one
    // silent loss for the clobbering the mergeable op exists to prevent. (The
    // sibling test above removes concurrently from a shared base; this one pins
    // that a same-transaction change to a DIFFERENT array leaves the removal
    // mergeable.)

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    const holderSchema = {
      type: "object",
      properties: { rows: stringListSchema, title: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    } as any;
    const HOLDER_CAUSE = "sibling-remove-holder";
    const readHolder = async () => {
      const storage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const cell = rt.getCell(space, HOLDER_CAUSE, holderSchema);
        await cell.sync();
        await cell.pull();
        return cell.get();
      } finally {
        await rt.dispose();
        await storage.close();
      }
    };
    try {
      const tx0 = rt1.edit();
      rt1.getCell(space, HOLDER_CAUSE, holderSchema, tx0).set({
        rows: ["a", "b", "c"],
        title: "before",
      });
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell(space, HOLDER_CAUSE, holderSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 removes "a".
      const txA = rt1.edit();
      rt1.getCell(space, HOLDER_CAUSE, holderSchema, txA)
        .key("rows").removeByValue("a");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the pre-removal basis, removes a different element
      // and edits an unrelated field. The sibling write does not touch the
      // array, so the removal stays mergeable and both removals land.
      const txB = rt2.edit();
      const holderB = rt2.getCell(space, HOLDER_CAUSE, holderSchema, txB);
      holderB.key("rows").removeByValue("c");
      holderB.key("title").set("after");
      const result = await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(result.error).toBeUndefined();
      expect(await readHolder()).toEqual({ rows: ["b"], title: "after" });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("increment(0) throws", async () => {
    // A zero increment is a programming no-op and is rejected.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx = rt1.edit();
      const cell = rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
      expect(() => cell.increment(0)).toThrow();
      await tx.commit({ resolveAt: "verdict" });
    } finally {
      await rt1.dispose();
    }
  });

  it("a stale framed addUnique does not clobber a concurrent element edit", async () => {
    // A stale framed addUnique must not rewrite the array's existing prefix.
    // Its base-array read is excluded from the commit's conflict set, which is
    // only safe while the op writes nothing below the tail: anchoring (or
    // otherwise rewriting) untouched inline prefix elements would let this
    // stale commit apply positional replacements over a newer concurrent
    // element edit without any conflict, silently losing that edit.

    const OBJ_CAUSE = "mergeable-addunique-objects";
    const objListSchema = {
      type: "array",
      items: { type: "object", additionalProperties: true },
      // deno-lint-ignore no-explicit-any
    } as any;
    type Item = { v: number };

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Seed the durable array with INLINE object elements (a raw write, so
      // no anchoring), and get it durable.
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<Item[]>(
        space,
        OBJ_CAUSE,
        objListSchema,
        tx0,
      );
      seedCell.setRaw([{ v: 1 }, { v: 2 }]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 loads the seeded state; its replica now holds the same base.
      const cell2 = rt2.getCell<Item[]>(space, OBJ_CAUSE, objListSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()?.length).toBe(2);

      // Session 1 edits an existing element and commits.
      const txA = rt1.edit();
      rt1.getCell<Item[]>(space, OBJ_CAUSE, objListSchema, txA).key(0).set(
        { v: 9 },
      );
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, WITHOUT having observed that edit, performs a framed
      // addUnique. The candidate is new, so it is accepted and anchored; the
      // stale inline prefix must pass through untouched.
      const frame = pushFrame({
        generatedIdCounter: 0,
        cause: "stale addUnique",
        reactives: new Set(),
      });
      try {
        const txB = rt2.edit();
        rt2.getCell<Item[]>(space, OBJ_CAUSE, objListSchema, txB).addUnique(
          { v: 3 },
        );
        await txB.commit({ resolveAt: "verdict" });
      } finally {
        popFrame(frame);
      }
      await rt2.storageManager.synced();

      // Durable truth from a fresh session: the concurrent edit AND the
      // added value both survive.
      const storage3 = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt3 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage3,
      });
      try {
        const cell3 = rt3.getCell<Item[]>(space, OBJ_CAUSE, objListSchema);
        await cell3.sync();
        await cell3.pull();
        const durable = (cell3.get() ?? []) as Item[];
        expect(durable.length).toBe(3);
        expect(durable[0]).toEqual({ v: 9 });
        expect(durable[1]).toEqual({ v: 2 });
        expect(durable[2]).toEqual({ v: 3 });
      } finally {
        await rt3.dispose();
        await storage3.close();
      }
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("increment(non-finite) throws", async () => {
    // A non-finite amount is not a meaningful increment for a concurrent-sum
    // counter (it would set the counter to an absorbing `NaN`/`±Infinity`), so
    // it is rejected before any local write or mergeable-op record.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx = rt1.edit();
      const cell = rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
      expect(() => cell.increment(NaN)).toThrow();
      expect(() => cell.increment(Infinity)).toThrow();
      expect(() => cell.increment(-Infinity)).toThrow();
      await tx.commit({ resolveAt: "verdict" });
    } finally {
      await rt1.dispose();
    }
  });
});

// A "keyed collection": a list whose elements are separate entities, each
// addressed by a deterministic key via `elementById`. The handler reads/edits
// one element by key and manages membership with addUnique / removeByValue,
// never reading or rewriting the whole list. This is the lunch poll's vote and
// option model.
interface Vote {
  voterName: string;
  optionId: string;
  voteType: string;
}

const VOTES_CAUSE = "keyed-votes";

const voteListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      voterName: { type: "string" },
      optionId: { type: "string" },
      voteType: { type: "string" },
    },
  },
  // deno-lint-ignore no-explicit-any
} as any;

// Read the durable list from a fresh session and resolve each element link to
// its content, so assertions reflect committed state, link-resolved.
async function readDurableVotes(
  server: MemoryV2Server.Server,
): Promise<Vote[]> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as Vote[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("keyed collections via elementById", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("an element addressed by key is readable and removable from another session", async () => {
    // The key resolves to the same entity in a session that never saw the
    // write, so a second session can read and then remove the element purely by
    // key.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const votes0 = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        tx0,
      );
      votes0.set([]);
      const vote = votes0.elementById("alice|opt1");
      vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votes0.addUnique(vote);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, which never observed the write, addresses the same vote by
      // the same key and reads its content.
      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();
      const mine = votes2.elementById("alice|opt1");
      expect(mine.get()).toEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });

      // It removes the element by key alone, never rewriting the list.
      const txR = rt2.edit();
      rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txR)
        .removeByValue(
          rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txR)
            .elementById("alice|opt1"),
        );
      await txR.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(await readDurableVotes(server)).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two sessions add distinct keyed elements concurrently — both survive", async () => {
    // Two sessions cast votes under different keys against the same base; both
    // memberships merge instead of clobbering.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx0).set([]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      const txA = rt1.edit();
      const votesA = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txA,
      );
      const a = votesA.elementById("alice|opt1");
      a.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesA.addUnique(a);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the empty base, adds a different key.
      const txB = rt2.edit();
      const votesB = rt2.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txB,
      );
      const b = votesB.elementById("bob|opt2");
      b.set({ voterName: "bob", optionId: "opt2", voteType: "no" });
      votesB.addUnique(b);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(2);
      expect(durable).toContainEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });
      expect(durable).toContainEqual({
        voterName: "bob",
        optionId: "opt2",
        voteType: "no",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two sessions add the same keyed element concurrently — dedups to one", async () => {
    // Two sessions cast the same vote (same key) concurrently. The key derives
    // to the same entity, so add-unique dedups by link to a single membership
    // entry.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx0).set([]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      const txA = rt1.edit();
      const votesA = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txA,
      );
      const a = votesA.elementById("alice|opt1");
      a.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesA.addUnique(a);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const votesB = rt2.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txB,
      );
      const b = votesB.elementById("alice|opt1");
      b.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesB.addUnique(b);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(1);
      expect(durable[0]).toEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("concurrent edits to different fields of one keyed element both land", async () => {
    // Editing a field of one keyed entity touches that entity's document, not
    // the list, so a concurrent edit to a different field of the same entity
    // merges.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const votes0 = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        tx0,
      );
      votes0.set([]);
      const vote = votes0.elementById("alice|opt1");
      vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votes0.addUnique(vote);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      // Session 1 edits the voteType field of the keyed entity.
      const txA = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txA)
        .elementById("alice|opt1").key("voteType").set("no");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the pre-edit basis, edits a different field.
      const txB = rt2.edit();
      rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txB)
        .elementById("alice|opt1").key("voterName").set("alice2");
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(1);
      expect(durable[0]).toEqual({
        voterName: "alice2",
        optionId: "opt1",
        voteType: "no",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

describe("mergeable op guards and single-session branches", () => {
  // Single-session checks of the mergeable methods' guards and minority
  // branches: the transaction/shape preconditions, the absent-array
  // initialization, the cell-reference (keyed-entity) matching path used by
  // addUnique/removeByValue, the no-op early returns, the element-schema
  // `$defs` carry-through, and the in-transaction accumulation of repeated ops
  // on one path. These do not need concurrency, only the op machinery, so they
  // run against a single runtime.

  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storage1?.close();
    await server?.close();
  });

  it("addUnique without a transaction throws", () => {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    expect(() => cell.addUnique("x")).toThrow();
  });

  it("pushAll without a transaction throws", () => {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    expect(() => cell.pushAll(["x"])).toThrow();
  });

  it("pushAll given something other than an array throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    expect(() => cell.pushAll("abc" as unknown as string[])).toThrow(
      /requires an array of values/,
    );
    expect(() => cell.pushAll(["abc"])).not.toThrow();
  });

  it("push and pushAll append to a cell typed as a readonly array", () => {
    const tx = rt.edit();
    const cell = rt.getCell<readonly string[]>(
      space,
      "readonly-list",
      stringListSchema,
      tx,
    );
    cell.push("a");
    cell.pushAll(["b", "c"]);
    expect(cell.get()).toEqual(["a", "b", "c"]);
  });

  it("pushAll commits its list as one append of every member", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.pushAll(["b", "c", "d"]);
    expect(cell.get()).toEqual(["a", "b", "c", "d"]);

    const native = getDirectTransactionNativeCommit(tx, space);
    expect(native?.operations).toEqual([
      expect.objectContaining({
        op: "patch",
        patches: [{ op: "append", path: "/value", values: ["b", "c", "d"] }],
      }),
    ]);
  });

  it("pushAll commits a list too long to spread into push's arguments", async () => {
    const members = Array.from({ length: 150_000 }, (_, index) => `${index}`);
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx).pushAll(members);
    const result = await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(result.error).toBeUndefined();
    const durable = await readDurable(server);
    expect(durable.length).toBe(150_001);
    expect(durable[0]).toBe("seed");
    expect(durable[150_000]).toBe("149999");
  });

  it("increment without a transaction throws", () => {
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema);
    expect(() => cell.increment(1)).toThrow();
  });

  it("removeByValue without a transaction throws", () => {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    expect(() => cell.removeByValue("x")).toThrow();
  });

  it("addUnique onto a non-array value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell(space, "scalar-au", anySchema, tx);
    cell.set(7);
    expect(() => cell.addUnique("x")).toThrow();
  });

  it("increment onto a non-number value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell(space, "scalar-inc", anySchema, tx);
    cell.set("not-a-number");
    expect(() => cell.increment(1)).toThrow();
  });

  it("removeByValue onto a non-array value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell(space, "scalar-rm", anySchema, tx);
    cell.set(7);
    expect(() => cell.removeByValue("x")).toThrow();
  });

  it("addUnique initializes an absent array before adding", () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, "fresh-au", stringListSchema, tx);
    cell.addUnique("x");
    expect(cell.get()).toEqual(["x"]);
  });

  it("push with no items is a no-op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx).push();
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["a"]);
  });

  it("elementById tolerates a non-record schema", () => {
    const tx = rt.edit();
    // A boolean schema (`true`) is a valid JSON schema but not a record, so the
    // derived element schema is absent.
    // deno-lint-ignore no-explicit-any
    const cell = rt.getCell(space, "bool-schema", true as any, tx);
    cell.set([{ a: 1 }]);
    const element = cell.elementById("k1");
    element.set({ a: 2 });
    expect(element.get()).toEqual({ a: 2 });
  });

  it("removeByValue on an absent array is a no-op", () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, "fresh-rm", stringListSchema, tx);
    cell.removeByValue("x");
    expect(cell.get() ?? undefined).toBe(undefined);
  });

  it("elementById tolerates a schema without an items entry", () => {
    const looseListSchema = {
      type: "array",
      // deno-lint-ignore no-explicit-any
    } as any;
    const tx = rt.edit();
    const list = rt.getCell(space, "loose-list", looseListSchema, tx);
    list.set([]);
    const element = list.elementById("k1");
    element.set({ note: "hi" });
    expect(element.get()).toEqual({ note: "hi" });
  });

  it("removeByValue with no matching element is a no-op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a", "b"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx).removeByValue("z");
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["a", "b"]);
  });

  it("addUnique and removeByValue match a keyed element by reference", () => {
    const tx = rt.edit();
    const votes = rt.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx);
    votes.set([]);
    const vote = votes.elementById("alice|opt1");
    vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });

    votes.addUnique(vote);
    // Re-adding the same keyed entity dedups to a single membership entry.
    votes.addUnique(vote);
    expect(votes.get()?.length).toBe(1);

    votes.removeByValue(vote);
    expect(votes.get()?.length ?? 0).toBe(0);
  });

  it("elementById carries `$defs` into the element schema", () => {
    const refListSchema = {
      type: "array",
      items: { $ref: "#/$defs/Item" },
      $defs: {
        Item: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    const tx = rt.edit();
    const list = rt.getCell(space, "ref-list", refListSchema, tx);
    list.set([]);
    const element = list.elementById("k1");
    element.set({ name: "alice" });
    expect(element.get()).toEqual({ name: "alice" });
  });

  it("two addUnique calls on one list in one transaction both land", async () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.addUnique("a");
    cell.addUnique("b");
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect([...await readDurable(server)].sort()).toEqual(["a", "b"]);
  });

  it("increment then decrement in one transaction nets no change", async () => {
    const tx0 = rt.edit();
    rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx0).set(5);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
    cell.increment(1);
    cell.increment(-1);
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(await readDurableNumber(server)).toBe(5);
  });

  describe("a `set()` then an `increment()` in one transaction", () => {
    // The increment's op carries only its delta. The `set()` ahead of it says
    // what the number is, so the increment is committed as part of that value
    // and records no op.

    it("commits the number the transaction computed, over an existing one", async () => {
      const tx0 = rt.edit();
      rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx0).set(5);
      await tx0.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      const tx = rt.edit();
      const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
      cell.set(10);
      cell.increment(1);
      await tx.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(11);
    });

    it("commits the number the transaction computed, on a new document", async () => {
      const tx = rt.edit();
      const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
      cell.set(10);
      cell.increment(1);
      await tx.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(11);
    });
  });

  it("mergeable ops on two fields of one entity both commit", async () => {
    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "multi-field-entity";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ tags: [], count: 0 });
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    // Two distinct mergeable ops on the SAME entity document but different
    // paths: the read-exclusion bookkeeping groups both op paths under one
    // entity key.
    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    doc.key("tags").addUnique("x");
    doc.key("count").increment(2);
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const readBack = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      const cell = rt2.getCell(space, cause, docSchema);
      await cell.sync();
      await cell.pull();
      expect(cell.get()).toEqual({ tags: ["x"], count: 2 });
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  describe("a push that creates its list", () => {
    // A document the transaction is the first to write has no base to diff
    // against. A push that is its only write travels as an op. Beside any
    // other write to the document it goes with that write in one
    // whole-document set, which the store refuses where it already holds the
    // document.

    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      // deno-lint-ignore no-explicit-any
    } as any;

    it("emits an op when it is the document's only write", () => {
      const tx = rt.edit();
      const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
      cell.push("x");

      const { id } = cell.getAsNormalizedFullLink();
      const operation = getDirectTransactionNativeCommit(tx, space)?.operations
        .find((op) => op.id === id);
      expect(operation?.op).toBe("patch");
      expect(
        (operation as { patches: { op: string; path: string }[] }).patches
          .map(({ op, path }) => ({ op, path })),
      ).toEqual([{ op: "append", path: "/value" }]);
    });

    it("commits a sibling field written beside it, in a set that drops the push's intent", async () => {
      const cause = "push-creates-list-beside-sibling";
      const tx = rt.edit();
      const doc = rt.getCell(space, cause, docSchema, tx);
      doc.key("count").set(1);
      doc.key("tags").push("x");
      expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
        .toBe(1);

      const { id } = doc.getAsNormalizedFullLink();
      const operation = getDirectTransactionNativeCommit(tx, space)?.operations
        .find((op) => op.id === id);
      expect(operation?.op).toBe("set");
      expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])])
        .toEqual([]);

      await tx.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();
      expect(await readDurableValue(server, cause, docSchema)).toEqual({
        count: 1,
        tags: ["x"],
      });
    });

    it("commits the rest of a whole-object `set()` made before it", async () => {
      const cause = "push-creates-list-after-object-set";
      const tx = rt.edit();
      const doc = rt.getCell(space, cause, docSchema, tx);
      doc.set({ tags: [], count: 1 });
      doc.key("tags").push("x");
      await tx.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      expect(await readDurableValue(server, cause, docSchema)).toEqual({
        count: 1,
        tags: ["x"],
      });
    });

    it("is refused beside another write when another session's push created the list first", async () => {
      // Both sessions see no document. The first one's push lands as an op and
      // creates the list. The second one's set would replace that list with
      // its own single element, so it has to be refused. Its write beside the
      // push goes straight to the transaction and reads nothing, so the
      // push's own read of the list is the only one that can refuse it.
      const cause = "push-creates-list-store-holds-document";
      const tx0 = rt.edit();
      rt.getCell<string[]>(space, cause, stringListSchema, tx0).push("a");
      await tx0.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      const storage2 = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage2,
      });
      try {
        const tx = rt2.edit();
        const list = rt2.getCell<string[]>(space, cause, stringListSchema, tx);
        list.push("b");
        const { id, scope } = list.getAsNormalizedFullLink();
        tx.writeOrThrow({ space, id, scope, path: ["note"] }, "beside");
        const result = await tx.commit({ resolveAt: "verdict" });
        expect(result.error?.name).toBe("ConflictError");
      } finally {
        await rt2.dispose();
        await storage2.close();
      }

      expect(await readDurableValue(server, cause, stringListSchema)).toEqual([
        "a",
      ]);
    });
  });

  it("a push after a write to the document root emits a set and drops the push's intent", async () => {
    // No patch expresses a write to the document root, so the whole-document
    // set is what carries it. The append is not sent, and its intent must not
    // survive to narrow the array read out of the commit's reads.
    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "push-after-root-write";
    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ tags: ["a"], count: 0 });
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    const { id, scope } = doc.getAsNormalizedFullLink();
    const rootWrite = tx.tx.write(
      { space, id, scope, type: "application/json", path: [] },
      { value: { tags: ["a"], count: 5 } },
    );
    expect(rootWrite.error).toBeUndefined();
    doc.key("tags").push("b");
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);

    const operation = getDirectTransactionNativeCommit(tx, space)?.operations
      .find((op) => op.id === id);
    expect(operation?.op).toBe("set");
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]).toEqual(
      [],
    );

    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();
    expect(await readDurableValue(server, cause, docSchema)).toEqual({
      tags: ["a", "b"],
      count: 5,
    });
  });

  it("mergeable ops route through a TransactionWrapper", () => {
    // A cell whose transaction is a TransactionWrapper (the wrapper
    // Cell.sample() and Cell.sink() install for child cells) routes its
    // mergeable ops through the wrapper's record* delegations to the inner
    // transaction.

    const inner = rt.edit();
    const wrapper = new TransactionWrapper(inner, { childCellTx: inner });

    // Each op records its intent through the wrapper's record* delegation as it
    // runs, so the optimistic local value reflects all four without a commit.
    const list = rt.getCell<string[]>(space, CAUSE, stringListSchema, wrapper);
    list.push("a");
    list.addUnique("b");
    list.removeByValue("a");
    expect(list.get()).toEqual(["b"]);

    const counter = rt.getCell<number>(
      space,
      COUNTER_CAUSE,
      numberSchema,
      wrapper,
    );
    counter.increment(3);
    expect(counter.get()).toBe(3);
  });

  it("an ancestor write poisons the tail intent beneath it", async () => {
    // A whole-value write reaches the intents BENEATH it, not just the one at
    // the exact path it wrote. Asserted on the recorded intents rather than on
    // a commit outcome, because the reshaping `set` also records reads of its
    // own that conflict independently — a commit-level assertion would pass
    // whether or not the intent survived.
    //
    // The sequence is the one length arithmetic alone cannot catch: push,
    // reshape the enclosing object, push. The two pushes sum to a `count` that
    // spans the reshape, so the recorded tail lands back on the base length
    // while covering an element the reshape supplied rather than one an op
    // appended.

    const docSchema = {
      type: "object",
      properties: { rows: { type: "array", items: { type: "string" } } },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "ancestor-poison";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ rows: ["a", "b", "c"] });
    await tx0.commit({ resolveAt: "verdict" });

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    const rows = doc.key("rows") as unknown as Cell<string[]>;

    rows.push("p");
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);

    doc.set({ rows: ["m", "n", "o", "r"] });
    rows.push("q");

    // The ancestor write dropped the intent, and `recordMergeableOp` will not
    // revive a poisoned path, so the second push records nothing either.
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]).toEqual(
      [],
    );
    expect(doc.get()).toEqual({ rows: ["m", "n", "o", "r", "q"] });
  });

  it("a build-time abandon removes the intent from the transaction", async () => {
    // Abandoning at build time must remove the intent from the transaction, not
    // just skip the wire op — a surviving intent keeps narrowing reads out of
    // the conflict set for an op that is no longer being sent. Asserted
    // directly on the intents after `getNativeCommit`, since no commit outcome
    // of a single session distinguishes the two.

    // Asserting on the built commit rather than on the committed transaction
    // matters: finishing a commit clears the intents anyway, so a post-commit
    // assertion would pass whether or not the build dropped them.

    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
      "a",
      "b",
      "c",
    ]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    tx.writeValueOrThrow(cell.getAsNormalizedFullLink(), ["a"]);
    cell.push("d");

    // Recorded while the handler ran: the shrink went straight to the
    // transaction, which poisons nothing, where a `set()` would have.
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);

    // Building the commit is what discovers the tail no longer describes the
    // local value, and it drops the intent rather than just skipping the op.
    getDirectTransactionNativeCommit(tx, space);
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]).toEqual(
      [],
    );
  });

  it("a whole-document transaction emits a set and drops the push's intent", async () => {
    // `markWholeDocumentWrites` replaces every op with a whole-document set —
    // the client speculation overlay's seal, whose entries layer their ops over
    // a confirmed value that moves under them. The append is not sent, so its
    // intent must not survive to narrow the array read out of the commit's
    // reads: that read is a real dependency of the value the set carries, and
    // for a speculative seal it is what the entry's retirement floor is built
    // from.
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a", "b"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.push("c");
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);

    tx.tx.markWholeDocumentWrites!();
    const native = getDirectTransactionNativeCommit(tx, space);
    expect(native?.operations.map((op) => op.op)).toEqual(["set"]);
    expect(
      (native?.operations[0] as { value?: { value?: string[] } }).value?.value,
    ).toEqual(["a", "b", "c"]);
    // The array read the append would have narrowed away is in the sealed
    // commit's reads, which is the claim the abandonment is FOR — the
    // intent count alone cannot show it, and the whole-document write is
    // the value the run computed from that read. Asserted before the
    // intent count so a regression names the consequence, not the
    // mechanism.
    const replica = rt.storageManager.open(space).replica;
    const sealed = replica.sealNative!(
      native!,
      tx.tx,
      new Promise(() => {}),
      { speculative: true },
    );
    const readIds = [
      ...sealed.commit.reads.confirmed,
      ...sealed.commit.reads.pending,
    ].map((read) => read.id);
    expect(readIds).toContain(cell.getAsNormalizedFullLink().id);
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]).toEqual(
      [],
    );

    // Poisoned as well as deleted: a later push on the same transaction
    // records nothing, so the intent cannot come back after the commit
    // was built without it.
    cell.push("d");
    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]).toEqual(
      [],
    );
  });

  it("nested tail ops abandon only the contained one", async () => {
    // Two tail ops where one op's payload contains the other's target: exactly
    // one intent — the CONTAINED one — is abandoned, and the containing op
    // survives to carry the combined value. Which of the two is dropped only
    // shows here: both choices commit the same durable value in the simple
    // case, but abandoning the outer would forfeit the outer list's
    // merge-friendliness instead of the inner one's.
    //
    // The same assertion pins the guard's lower edge: a nested push landing
    // BEFORE the outer tail is in no payload, so both intents survive.

    const nested = {
      type: "array",
      items: { type: "array", items: { type: "string" } },
      // deno-lint-ignore no-explicit-any
    } as any;

    // `["value"]` is the list itself within its document.
    for (
      const { name, seed, index, remains } of [
        // Push a new inner list, then push into it: the outer payload already
        // carries the "y" the inner op would add again, so only the outer op
        // survives.
        { name: "inside-tail", seed: [["a"]], index: 1, remains: [["value"]] },
        // Push into an inner list that was already there: index 0 sits below the
        // outer tail start, so nothing is sent twice and both ops survive.
        {
          name: "before-tail",
          seed: [["a"], ["b"]],
          index: 0,
          remains: [["value"], ["value", "0"]],
        },
      ]
    ) {
      const cause = `nested-intents-${name}`;
      const tx0 = rt.edit();
      rt.getCell<string[][]>(space, cause, nested, tx0).set(seed);
      await tx0.commit({ resolveAt: "verdict" });
      await rt.storageManager.synced();

      const tx = rt.edit();
      const outer = rt.getCell<string[][]>(space, cause, nested, tx);
      outer.push(["x"]);
      (outer.key(index) as unknown as Cell<string[]>).push("y");
      expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
        .toBe(2);

      // Building the commit is where the containment is discovered — both ops
      // were recorded on paths neither write reshaped.
      getDirectTransactionNativeCommit(tx, space);
      expect(
        [...(getDirectTransactionMergeableOpAddresses(tx) ?? [])]
          .map(({ path }) => path),
      ).toEqual(remains);
    }
  });

  it("a write beneath an array leaves the array's intent intact", async () => {
    // The other direction, and the one that pins the predicate: a write BENEATH
    // an array (an element edit) must leave that array's intent alone, whether
    // it lands after the push or ahead of it. Asserted on the intents — the
    // durable value cannot discriminate here, because a concurrent append is
    // add-wins and lands either way.

    const docSchema = {
      type: "object",
      properties: { rows: { type: "array", items: { type: "string" } } },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "beneath-no-poison";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ rows: ["a", "b"] });
    await tx0.commit({ resolveAt: "verdict" });

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    const rows = doc.key("rows") as unknown as Cell<string[]>;

    rows.push("p");
    rows.key(0).set("A");

    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);
    expect(doc.get()).toEqual({ rows: ["A", "b", "p"] });

    const reversed = rt.edit();
    const reversedRows = rt.getCell(space, cause, docSchema, reversed)
      .key("rows") as unknown as Cell<string[]>;
    reversedRows.key(0).set("A");
    reversedRows.push("p");

    expect(
      [...(getDirectTransactionMergeableOpAddresses(reversed) ?? [])].length,
    ).toBe(1);
  });

  it("a sibling write leaves the tail intent intact", async () => {
    // A sibling write must NOT poison a tail intent: only paths at or beneath
    // the write are covered, so an unrelated field keeps the push mergeable,
    // written after the push or ahead of it.

    const docSchema = {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "string" } },
        title: { type: "string" },
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "sibling-no-poison";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({
      rows: ["a"],
      title: "before",
    });
    await tx0.commit({ resolveAt: "verdict" });

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    const rows = doc.key("rows") as unknown as Cell<string[]>;

    rows.push("p");
    doc.key("title").set("after");

    expect([...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length)
      .toBe(1);

    const reversed = rt.edit();
    const reversedDoc = rt.getCell(space, cause, docSchema, reversed);
    reversedDoc.key("title").set("after");
    (reversedDoc.key("rows") as unknown as Cell<string[]>).push("p");

    expect(
      [...(getDirectTransactionMergeableOpAddresses(reversed) ?? [])].length,
    ).toBe(1);
  });

  describe("an op after a whole-value `set()` in the same transaction", () => {
    // A `set()` says what the value is. An op after it, at that path or
    // beneath it, would land on whatever the store holds and add to a value
    // the transaction replaced, so it records no intent and the commit carries
    // the value the transaction computed.

    const intentCount = (tx: ReturnType<Runtime["edit"]>) =>
      [...(getDirectTransactionMergeableOpAddresses(tx) ?? [])].length;

    it("records no intent for a push, an `addUnique()` or an `increment()` at the path", () => {
      const tx = rt.edit();
      const list = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
      list.set(["a"]);
      list.push("b");
      list.addUnique("c");
      const counter = rt.getCell<number>(
        space,
        COUNTER_CAUSE,
        numberSchema,
        tx,
      );
      counter.set(10);
      counter.increment(1);

      expect(intentCount(tx)).toBe(0);
      expect(list.get()).toEqual(["a", "b", "c"]);
      expect(counter.get()).toBe(11);
    });

    it("records no intent for a push beneath the path", () => {
      const docSchema = {
        type: "object",
        properties: { rows: { type: "array", items: { type: "string" } } },
        // deno-lint-ignore no-explicit-any
      } as any;
      const tx = rt.edit();
      const doc = rt.getCell(space, "set-then-push-beneath", docSchema, tx);
      doc.set({ rows: [] });
      (doc.key("rows") as unknown as Cell<string[]>).push("p");

      expect(intentCount(tx)).toBe(0);
    });

    it("records no intent when the `set()` wrote the value already there", async () => {
      const tx0 = rt.edit();
      rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([]);
      await tx0.commit({ resolveAt: "verdict" });

      const tx = rt.edit();
      const list = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
      list.set([]);
      list.push("x");

      expect(intentCount(tx)).toBe(0);
    });

    it("commits one element over a list another session filled", async () => {
      // The writing session never loads the list. Its first attempt claims the
      // list is absent and is refused; the retry runs with the twenty elements
      // loaded and replaces them.
      const twenty = Array.from({ length: 20 }, (_, index) => `e${index}`);
      const retryServer = newSharedServer();
      const fillingStorage = EmulatedStorageManager.connectTo(retryServer, {
        as: signer,
      });
      const writingStorage = EmulatedStorageManager.connectTo(retryServer, {
        as: signer,
      });
      const filling = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: fillingStorage,
      });
      const writing = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writingStorage,
      });
      try {
        const filled = await filling.editWithRetry((tx) => {
          filling.getCell<string[]>(space, CAUSE, stringListSchema, tx)
            .set(twenty);
        });
        expect(filled.error).toBeUndefined();
        await filling.storageManager.synced();

        const written = await writing.editWithRetry((tx) => {
          const list = writing.getCell<string[]>(
            space,
            CAUSE,
            stringListSchema,
            tx,
          );
          list.set([]);
          list.push("x");
        });
        expect(written.error).toBeUndefined();
        await writing.storageManager.synced();

        expect(await readDurable(retryServer)).toEqual(["x"]);
      } finally {
        await writing.dispose();
        await filling.dispose();
        await writingStorage.close();
        await fillingStorage.close();
        await retryServer.close();
      }
    });
  });

  it("a net-zero increment alongside another change is dropped", async () => {
    // An increment that sums to zero is a no-op the op builder drops. Pairing
    // it with another change on the same entity forces the entity to commit, so
    // the builder still visits (and drops) the zero increment.

    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      // deno-lint-ignore no-explicit-any
    } as any;
    const cause = "net-zero-increment";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ tags: [], count: 5 });
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    doc.key("count").increment(1);
    doc.key("count").increment(-1);
    doc.key("tags").addUnique("x");
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const readBack = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      const cell = rt2.getCell(space, cause, docSchema);
      await cell.sync();
      await cell.pull();
      expect(cell.get()).toEqual({ tags: ["x"], count: 5 });
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  it("an append superseded by a non-array set is dropped", async () => {
    // A recorded append whose path is overwritten by a whole-value set before
    // commit is dropped: a non-array (or empty) value at the path produces no
    // tail-relative op, and the whole-value write stands.

    const cause = "append-then-scalar";
    const tx = rt.edit();
    // deno-lint-ignore no-explicit-any
    const cell = rt.getCell(space, cause, anySchema, tx);
    cell.set([]);
    cell.push("x");
    cell.set(5);
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const readBack = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      // deno-lint-ignore no-explicit-any
      const cell2 = rt2.getCell(space, cause, anySchema as any);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toBe(5);
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  it("an append superseded by an empty-array set yields no tail op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.push("x");
    cell.set([]);
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual([]);
  });

  it("two removeByValue calls in one transaction remove both", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
      "a",
      "b",
      "c",
    ]);
    await tx0.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.removeByValue("a");
    cell.removeByValue("b");
    await tx.commit({ resolveAt: "verdict" });
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["c"]);
  });
});

// The home-space `spaces` list shape: an array of `{ name }` records addressed
// by name via `elementById`. Adding sets the keyed entity and add-uniques it
// (dedup by the deterministic link); removing matches that link. This mirrors
// home.tsx's addSpaceHandler / removeSpaceHandler after the keyed migration —
// object elements are stored as links, so membership merges by identity, not by
// whole-record value equality.
interface NamedEntry {
  name: string;
}

const NAMED_CAUSE = "keyed-named-list";

const namedListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" } },
  },
  // deno-lint-ignore no-explicit-any
} as any;

async function readDurableNamed(
  server: MemoryV2Server.Server,
): Promise<NamedEntry[]> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as NamedEntry[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("keyed object list (home spaces shape)", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("two sessions add distinct names concurrently — both survive", async () => {
    // Two sessions add spaces with distinct names against the same base; both
    // memberships merge rather than the second clobbering the first.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema, tx0).set(
        [],
      );
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      const a = spacesA.elementById("alpha");
      a.set({ name: "alpha" });
      spacesA.addUnique(a);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2 still holds [] (has not observed "alpha").
      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      const b = spacesB.elementById("beta");
      b.set({ name: "beta" });
      spacesB.addUnique(b);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two sessions add the same name concurrently — dedups to one", async () => {
    // Two sessions add the SAME name against the same base; the key derives to
    // the same entity, so add-unique dedups by link to one membership entry.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema, tx0).set(
        [],
      );
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      const a = spacesA.elementById("dup");
      a.set({ name: "dup" });
      spacesA.addUnique(a);
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      const b = spacesB.elementById("dup");
      b.set({ name: "dup" });
      spacesB.addUnique(b);
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name)).toEqual(["dup"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("two sessions remove distinct names concurrently — both land", async () => {
    // Two sessions remove different spaces by key concurrently; both removals
    // land instead of clobbering through a whole-list rewrite.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const seed = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        tx0,
      );
      seed.set([]);
      for (const name of ["a", "b", "c"]) {
        const e = seed.elementById(name);
        e.set({ name });
        seed.addUnique(e);
      }
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      spacesA.removeByValue(spacesA.elementById("b"));
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // rt2, still holding all three, removes a different space.
      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      spacesB.removeByValue(spacesB.elementById("c"));
      await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name)).toEqual(["a"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

// The home-space `favorites` list shape: each element is a keyed entity whose
// value CONTAINS a cell reference to the favorited piece, addressed by a key
// derived from that piece's intrinsic link. This mirrors home.tsx's addFavorite
// / removeFavorite after the keyed migration — the favorite's identity is the
// piece, so keying by the piece link dedups a re-favorite and lets an unfavorite
// remove by identity without reading the whole list.
interface FavoriteLike {
  cell: unknown;
  tags: string[];
  userTags: string[];
  spaceName?: string;
}

const FAV_CAUSE = "keyed-favorites-list";

const favoriteLikeSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      cell: { type: "unknown", asCell: ["cell"] },
      tags: { type: "array", items: { type: "string" } },
      userTags: { type: "array", items: { type: "string" } },
      spaceName: { type: "string" },
    },
    required: ["cell"],
  },
  // deno-lint-ignore no-explicit-any
} as any;

// The key a favorite is addressed by: the favorited piece's intrinsic link,
// identical in any session that references the same piece.
function favoriteKeyFor(piece: { getAsNormalizedFullLink(): unknown }): string {
  const link = piece.getAsNormalizedFullLink() as {
    space: string;
    id: string;
    path: readonly unknown[];
  };
  return JSON.stringify([link.space, link.id, link.path]);
}

describe("keyed entity holding a cell reference (home favorites shape)", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storage1?.close();
    await server?.close();
  });

  it("favoriting a piece by its link dedups and removes by identity", () => {
    const tx = rt.edit();
    // The piece being favorited: any cell with a stable link.
    const piece = rt.getCell(space, "favorited-piece", anySchema, tx);
    piece.set({ title: "a piece" });

    const favorites = rt.getCell<FavoriteLike[]>(
      space,
      FAV_CAUSE,
      favoriteLikeSchema,
      tx,
    );
    favorites.set([]);

    const key = favoriteKeyFor(piece);
    const entry = favorites.elementById(key);
    entry.set({ cell: piece, tags: ["x"], userTags: [], spaceName: "s" });
    favorites.addUnique(entry);
    expect(favorites.get()?.length).toBe(1);
    // The stored element carries the piece as a cell reference and the tags.
    expect(favorites.get()?.[0].cell).toBeTruthy();
    expect(favorites.get()?.[0].tags).toEqual(["x"]);

    // Re-favoriting the same piece resolves to the same key — dedups to one.
    const again = favorites.elementById(favoriteKeyFor(piece));
    again.set({ cell: piece, tags: ["x"], userTags: [], spaceName: "s" });
    favorites.addUnique(again);
    expect(favorites.get()?.length).toBe(1);

    // Unfavoriting removes the membership entry by identity.
    favorites.removeByValue(favorites.elementById(favoriteKeyFor(piece)));
    expect(favorites.get()?.length ?? 0).toBe(0);
  });

  it("favorites of two distinct pieces coexist and remove independently", () => {
    const tx = rt.edit();
    const pieceA = rt.getCell(space, "piece-a", anySchema, tx);
    pieceA.set({ title: "A" });
    const pieceB = rt.getCell(space, "piece-b", anySchema, tx);
    pieceB.set({ title: "B" });

    const favorites = rt.getCell<FavoriteLike[]>(
      space,
      FAV_CAUSE,
      favoriteLikeSchema,
      tx,
    );
    favorites.set([]);

    for (const [piece, tag] of [[pieceA, "a"], [pieceB, "b"]] as const) {
      const entry = favorites.elementById(favoriteKeyFor(piece));
      entry.set({ cell: piece, tags: [tag], userTags: [] });
      favorites.addUnique(entry);
    }
    expect(favorites.get()?.length).toBe(2);

    // Removing one leaves the other intact.
    favorites.removeByValue(favorites.elementById(favoriteKeyFor(pieceA)));
    const remaining = favorites.get() ?? [];
    expect(remaining.length).toBe(1);
    // The surviving favorite is pieceB's, identified by its tag.
    expect(remaining[0].tags).toEqual(["b"]);
    expect(remaining[0].cell).toBeTruthy();
  });
});
