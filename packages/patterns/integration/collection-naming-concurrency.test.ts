/**
 * The allocator under real concurrency: two sessions on one memory server,
 * each running `assignName` or `createNamed` over one collection's names map,
 * in transactions that both read the map's keys before either commits.
 *
 * The functions under test are the ones the pattern runtime runs.
 * `collection-naming/naming.ts` cannot be imported by plain Deno — it takes
 * `lift`, `Writable` and `equals` from `commonfabric` as values, and those are
 * ambient declarations that bind nothing outside the pattern runtime's module
 * environment — so the test compiles a fixture that re-exports both
 * allocators through the harness and calls what comes back.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { type Cell, type MemorySpace, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type * as naming from "../collection-naming/naming.ts";

const signer = await Identity.fromPassphrase("collection naming concurrency");

const ROOT = join(import.meta.dirname!, "..");
const ALLOCATOR_FIXTURE = join(
  ROOT,
  "integration/fixtures/collection-naming-allocator.ts",
);

/** `assignName`, with the signature the module declares for it. */
type AssignName = typeof naming.assignName;

/** `createNamed`, with the signature the module declares for it. */
type CreateNamed = typeof naming.createNamed;

/**
 * The names map as a collection declares it: an object whose values are
 * members, held opaque so surveying the keys expands none of them.
 */
const NAMES_SCHEMA = {
  type: "object",
  additionalProperties: {},
} as const;

/**
 * What a member holds: a title, so one member can be told from another, and
 * the name a member built by `createNamed` stores.
 */
interface Item {
  title: string;
  name?: string;
}

const ITEM_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, name: { type: "string" } },
} as const;

/** The name the seeded member holds, so the next name allocated is `2`. */
const SEED_NAME = "1";

describe("collection naming under concurrent creates", () => {
  let compilerStorage: ReturnType<typeof StorageManager.emulate>;
  let compilerRuntime: Runtime;
  let assignName: AssignName;
  let createNamed: CreateNamed;

  let server: ReturnType<typeof newLoopbackServer>;
  let aliceStorage: EmulatedStorageManager;
  let aliceRuntime: Runtime;
  let bobStorage: EmulatedStorageManager;
  let bobRuntime: Runtime;
  let space: MemorySpace;

  beforeAll(async () => {
    compilerStorage = StorageManager.emulate({ as: signer });
    compilerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: compilerStorage,
    });
    const program = await resolveLocalProgram(
      (resolver) => compilerRuntime.harness.resolve(resolver),
      { main: ALLOCATOR_FIXTURE, root: ROOT },
    );
    const { main } = await compilerRuntime.harness.compileAndEvaluateModules(
      program,
    );
    const allocators = main as {
      assignName?: AssignName;
      createNamed?: CreateNamed;
    };
    assignName = allocators.assignName!;
    createNamed = allocators.createNamed!;
    // The seam is a cast, so a fixture that stopped exporting an allocator
    // would hand every test below `undefined` and fail somewhere that says
    // nothing about why.
    expect(typeof assignName).toBe("function");
    expect(typeof createNamed).toBe("function");
  });

  afterAll(async () => {
    await compilerRuntime?.dispose();
    await compilerStorage?.close();
  });

  /** The one names map, addressed the same way from either session. */
  function namesOf(runtime: Runtime): Cell<naming.NamesMap> {
    return runtime.getCell<naming.NamesMap>(
      space,
      "collection-names",
      NAMES_SCHEMA,
    );
  }

  /** A member, addressed the same way from either session. */
  function itemOf(runtime: Runtime, cause: string): Cell<Item> {
    return runtime.getCell<Item>(space, cause, ITEM_SCHEMA);
  }

  /** Opens the two sessions against `server`. */
  function openSessions(): void {
    aliceStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    aliceRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceStorage,
    });
    bobStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobStorage,
    });
    space = signer.did() as MemorySpace;
  }

  /**
   * Writes the documents both sessions start from — one named member, plus
   * whatever `members` names — and leaves Bob's replica holding them.
   */
  async function seed(members: string[]): Promise<void> {
    const tx = aliceRuntime.edit();
    const seedItem = itemOf(aliceRuntime, "seed-item");
    seedItem.withTx(tx).set({ title: "seed" });
    for (const member of members) {
      itemOf(aliceRuntime, member).withTx(tx).set({ title: member });
    }
    namesOf(aliceRuntime).withTx(tx).set({ [SEED_NAME]: seedItem });
    await tx.commit({ resolveAt: "verdict" });
    await aliceStorage.synced();

    await namesOf(bobRuntime).sync();
    await namesOf(bobRuntime).pull();
    for (const member of members) await itemOf(bobRuntime, member).sync();
  }

  afterEach(async () => {
    await bobRuntime?.dispose();
    await aliceRuntime?.dispose();
    await bobStorage?.close();
    await aliceStorage?.close();
    await server?.close();
  });

  describe("two creates that both read the keys before either commits", () => {
    // Fan-out on its prompt cadence: a frame crosses one turn of the event
    // loop, which is the boundary a deployed client sees. Nothing here needs a
    // frame withheld, because `editWithRetry` calls its action synchronously
    // (runtime.ts) — so starting both creates in one turn has both actions
    // read the map before either commit is awaited, whatever the two clients
    // do afterwards.

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      openSessions();
      await seed(["alice-item", "bob-item"]);
    });

    /**
     * A create, counting its attempts into `attempts`: `editWithRetry` calls
     * its action once per attempt, so the entries count the attempts across
     * both sessions.
     */
    function create(
      attempts: string[],
      runtime: Runtime,
      who: string,
      member: string,
    ) {
      return runtime.editWithRetry((tx) => {
        attempts.push(who);
        return assignName(namesOf(runtime).withTx(tx), itemOf(runtime, member));
      });
    }

    /**
     * A create through `createNamed`, counting its attempts as `create` does,
     * that builds its member holding the name: the member's `name` is written
     * in the transaction that records the member under that name.
     */
    function createHolding(
      attempts: string[],
      runtime: Runtime,
      who: string,
      member: string,
    ) {
      return runtime.editWithRetry((tx) => {
        attempts.push(who);
        return createNamed(namesOf(runtime).withTx(tx), (name) => {
          itemOf(runtime, member).withTx(tx).key("name").set(name);
          return itemOf(runtime, member);
        }).name;
      });
    }

    it("gives them distinct consecutive names, at the cost of one re-run", async () => {
      const attempts: string[] = [];
      const aliceCreate = create(attempts, aliceRuntime, "alice", "alice-item");
      const bobCreate = create(attempts, bobRuntime, "bob", "bob-item");
      const [alice, bob] = await Promise.all([aliceCreate, bobCreate]);

      expect(alice.error).toBeUndefined();
      expect(bob.error).toBeUndefined();
      expect([alice.ok, bob.ok].toSorted()).toEqual(["2", "3"]);
      // One session ran twice and the other once. Which of them lost is not
      // asserted: either order satisfies the collection's rule, and nothing
      // here decides which commit the server judged first.
      expect(attempts.length).toBe(3);

      // Each name reached the member its own session was naming, and the
      // seeded member kept the name it had.
      await aliceStorage.synced();
      await bobStorage.synced();
      const map = namesOf(aliceRuntime);
      await map.sync();
      await map.pull();
      expect(Object.keys(map.get() ?? {}).toSorted()).toEqual(["1", "2", "3"]);
      expect(map.key(alice.ok!).get()).toEqual({ title: "alice-item" });
      expect(map.key(bob.ok!).get()).toEqual({ title: "bob-item" });
    });

    it("builds each member holding the name the map records for it, at the cost of one re-run", async () => {
      // The loser's first attempt built its member holding the name the winner
      // took. Its re-run has to build the member again with the next name, or
      // the member stores a name the map gives someone else — which the
      // distinct consecutive names alone would not show.

      const attempts: string[] = [];
      const aliceCreate = createHolding(
        attempts,
        aliceRuntime,
        "alice",
        "alice-item",
      );
      const bobCreate = createHolding(attempts, bobRuntime, "bob", "bob-item");
      const [alice, bob] = await Promise.all([aliceCreate, bobCreate]);

      expect(alice.error).toBeUndefined();
      expect(bob.error).toBeUndefined();
      expect([alice.ok, bob.ok].toSorted()).toEqual(["2", "3"]);
      expect(attempts.length).toBe(3);

      await aliceStorage.synced();
      await bobStorage.synced();
      const map = namesOf(aliceRuntime);
      await map.sync();
      await map.pull();
      expect(Object.keys(map.get() ?? {}).toSorted()).toEqual(["1", "2", "3"]);
      expect(map.key(alice.ok!).get()).toEqual({
        title: "alice-item",
        name: alice.ok,
      });
      expect(map.key(bob.ok!).get()).toEqual({
        title: "bob-item",
        name: bob.ok,
      });
    });

    it("takes one attempt each when the second create runs after the first", async () => {
      // The control for the attempt counts above. Two names being distinct and
      // consecutive says nothing on its own — two creates in a row produce
      // exactly that — so it is the attempt count that separates the two
      // cases, and this is what gives that count a value to differ from.
      const attempts: string[] = [];
      const alice = await create(
        attempts,
        aliceRuntime,
        "alice",
        "alice-item",
      );
      await aliceStorage.synced();
      await namesOf(bobRuntime).sync();
      await namesOf(bobRuntime).pull();
      const bob = await create(attempts, bobRuntime, "bob", "bob-item");

      expect(alice.error).toBeUndefined();
      expect(bob.error).toBeUndefined();
      expect([alice.ok, bob.ok]).toEqual(["2", "3"]);
      expect(attempts).toEqual(["alice", "bob"]);
    });
  });

  describe("the read the rejection rests on", () => {
    // What `assignName`'s safety rests on: whether reading the map's keys
    // inside the transaction puts them in the commit's read set, so that a key
    // added while this basis was current rejects the commit instead of letting
    // it allocate over a name it never saw.
    //
    // Two sessions on one server with fan-out held manual, so a stale basis is
    // a gated state rather than a timing accident. The key Alice adds is one
    // no allocation issues, so it is a different key from the one the
    // allocation writes; disjoint keys of one container merge
    // (docs/specs/memory-v2/08-conflict-granularity.md), which leaves the read
    // as the only thing either commit can carry a conflict on — and the second
    // test is what shows the write alone carries none. The two differ in the
    // read alone, and each asserts the name allocated, so they are known to
    // have staged the same write.

    /** A key no allocation issues, which `naming.ts` admits the map can hold. */
    const FOREIGN_KEY = "abc";

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: "manual" });
      openSessions();
      await seed(["bob-item"]);

      // Alice adds her key. Bob's basis is now behind, and the held fan-out
      // keeps it there.
      const tx = aliceRuntime.edit();
      namesOf(aliceRuntime).withTx(tx).key(FOREIGN_KEY).set(
        itemOf(aliceRuntime, "seed-item"),
      );
      await tx.commit({ resolveAt: "verdict" });
      await aliceStorage.synced();
    });

    /**
     * The map as `assignName` sees it with the keyset read taken out: the keys
     * Bob's basis holds, answered without reading the cell — the allocator
     * reads nothing but the keys, so what stands under them does not matter —
     * and the same `key()` to write through. The allocation is therefore
     * identical, and the transaction differs only in what it read.
     */
    function withoutKeysetRead(
      names: Cell<naming.NamesMap>,
    ): naming.NamesMapCell {
      return {
        get: () => ({ [SEED_NAME]: true }),
        key: (name: string) => names.key(name),
      };
    }

    /**
     * Bob's transaction: it allocates a name for his member over a basis Alice
     * has already added a key to, reading the map's keys when `readTheKeys`
     * says so. Answers the name allocated and the commit's rejection, or
     * `undefined` for a commit the server took.
     */
    async function allocateFromStaleBasis(
      readTheKeys: boolean,
    ): Promise<{ name: string; error?: { name?: string } }> {
      const tx = bobRuntime.edit();
      const names = namesOf(bobRuntime).withTx(tx);
      const name = assignName(
        readTheKeys ? names : withoutKeysetRead(names),
        itemOf(bobRuntime, "bob-item"),
      );
      const { error } = await tx.commit({ resolveAt: "verdict" });
      return { name, error };
    }

    it("rejects the commit when the body read the keys another session added to", async () => {
      const { name, error } = await allocateFromStaleBasis(true);
      expect(name).toBe("2");
      expect(error?.name).toBe("ConflictError");
    });

    it("commits the same allocation when the body did not read those keys", async () => {
      const { name, error } = await allocateFromStaleBasis(false);
      expect(name).toBe("2");
      expect(error).toBeUndefined();
    });
  });
});
