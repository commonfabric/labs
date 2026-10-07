import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type FabricValue, isDeepFrozen } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../src/storage/cache.deno.ts";
import type {
  IMemorySpaceAddress,
  IStorageTransaction,
  StorageNotification,
  URI,
} from "../src/storage/interface.ts";
import {
  ignoreReadForCommit,
  internalVerifierRead,
  isInternalVerifierRead,
  isReadIgnoredForCommit,
  stableInternalVerifierRead,
} from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("v2-transaction");
const space = signer.did();
const type = "application/json" as const;

/** The list shape a search index or an autocomplete list has. */
const list = (length: number) =>
  Array.from({ length }, (_, index) => ({
    label: `entry-${index}`,
    nested: { id: `id-${index}` },
  }));

/**
 * Writes a list of `length` records to one document, reads the whole list
 * back, and reports both what came back and how many property descriptors the
 * read took.
 *
 * A descriptor is the only thing that answers whether a property holds data or
 * an accessor, which is the question the fabric membership check asks of every
 * own property of every record it walks. So the count is how the membership
 * walk announces itself: a total that tracks the length of the list is that
 * walk running over the whole value.
 */
const wholeListRead = async (
  length: number,
): Promise<{ value: unknown; descriptors: number }> => {
  const storage = StorageManager.emulate({ as: signer });
  try {
    const tx = storage.edit();
    const id: URI = `of:v2-transaction-whole-list-${length}`;
    expect(tx.write({ space, id, type, path: [] }, { value: list(length) }).ok)
      .toBeTruthy();

    const descriptorOf = Object.getOwnPropertyDescriptor;
    let descriptors = 0;
    Object.getOwnPropertyDescriptor = ((
      ...args: Parameters<typeof Object.getOwnPropertyDescriptor>
    ) => {
      descriptors++;
      return descriptorOf(...args);
    }) as typeof Object.getOwnPropertyDescriptor;

    let read;
    try {
      read = tx.read({ space, id, type, path: ["value"] });
    } finally {
      Object.getOwnPropertyDescriptor = descriptorOf;
    }

    expect(read.ok).toBeTruthy();
    return { value: read.ok!.value, descriptors };
  } finally {
    await storage.close();
  }
};

/** A keyed map of `length` records, the shape a directory or an index has. */
const keyedMap = (length: number) =>
  Object.fromEntries(
    Array.from({ length }, (_, index) => [
      `key-${index}`,
      { name: `entry-${index}`, nested: { id: `id-${index}` } },
    ]),
  );

/** How many containers a whole hash of a `keyedMap(length)` document feeds. */
const containersOfDocument = (length: number) => 2 + 2 * length;

/**
 * Commits a change to one entry of a document holding a keyed map of `length`
 * records, then has a second session commit a change to another entry, and
 * reports for each how many containers were hashed and what the first
 * session's replica notified.
 *
 * Every comparison on the way asks whether two versions of the document
 * differ. Comparing them by content hash feeds the hasher every container in
 * a version, so a count that tracks the length of the map is one of those
 * comparisons hashing the whole document.
 *
 * The replica watches the document, so the server sends each commit back to
 * it as a copy decoded afresh, sharing nothing with the replica's own. Its own
 * commit comes back holding what it already shows; the other session's comes
 * back holding a change, which is what shows the echo is compared at all.
 */
const oneEntryCommit = async (
  length: number,
): Promise<{
  containersHashed: number;
  changedPaths: string[][];
  echoedPaths: string[][];
  foreignContainersHashed: number;
  foreignPaths: string[][];
}> => {
  await using cleanup = new AsyncDisposableStack();
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  cleanup.defer(() => server.close());
  const [storage, peer] = [0, 1].map(() => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    cleanup.defer(() => manager.close());
    return manager;
  });
  const notifications: StorageNotification[] = [];
  // A subscriber is what makes the replica compute the change a commit makes,
  // for its own commit and again for each echo.
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return undefined;
    },
  });
  const pathsSince = (
    start: number,
    ...types: StorageNotification["type"][]
  ) =>
    notifications.slice(start)
      .filter((notification) => types.includes(notification.type))
      .flatMap((notification) =>
        "changes" in notification
          ? [...notification.changes].map((change) => [...change.address.path])
          : []
      );

  const id: URI = `of:v2-transaction-one-entry-${length}`;
  const seed = storage.edit();
  expect(
    seed.write({ space, id, type, path: [] }, { value: keyedMap(length) }).ok,
  ).toBeTruthy();
  expect((await seed.commit().settled).ok).toBeTruthy();
  for (const manager of [storage, peer]) {
    // Watching the document is what has the server send later commits back.
    expect(
      (await manager.open(space).sync(id, { path: [], schema: true })).ok,
    ).toBeTruthy();
    await manager.synced();
  }

  const before = getContainersHashedForTestingOnly();
  const notified = notifications.length;
  const tx = storage.edit();
  expect(
    tx.write({ space, id, type, path: ["value", "key-0", "name"] }, "edited")
      .ok,
  ).toBeTruthy();
  expect((await tx.commit().settled).ok).toBeTruthy();
  await storage.pullOpenSpacesToHead();
  const containersHashed = getContainersHashedForTestingOnly() - before;
  const changedPaths = pathsSince(notified, "commit");
  const echoedPaths = pathsSince(notified, "integrate", "pull");

  const foreignBefore = getContainersHashedForTestingOnly();
  const foreignNotified = notifications.length;
  const foreign = peer.edit();
  expect(
    foreign.write(
      { space, id, type, path: ["value", "key-5", "name"] },
      "edited elsewhere",
    ).ok,
  ).toBeTruthy();
  expect((await foreign.commit().settled).ok).toBeTruthy();
  await storage.pullOpenSpacesToHead();

  return {
    containersHashed,
    changedPaths,
    echoedPaths,
    foreignContainersHashed: getContainersHashedForTestingOnly() -
      foreignBefore,
    foreignPaths: pathsSince(foreignNotified, "integrate", "pull"),
  };
};

/**
 * Commits a document holding a keyed map of `length` records, then changes
 * one entry and changes it back within one transaction, and returns how many
 * commit notifications that transaction produced.
 *
 * Each write is a change when it is made, so the transaction reaches its
 * commit holding writes, and only comparing where the document ended with
 * where it started finds that there is nothing to commit.
 */
const revertedWriteCommits = async (length: number): Promise<number> => {
  const storage = StorageManager.emulate({ as: signer });
  try {
    let commits = 0;
    storage.subscribe({
      next(notification) {
        if (notification.type === "commit") commits++;
        return undefined;
      },
    });
    const id: URI = `of:v2-transaction-reverted-${length}`;
    const seed = storage.edit();
    expect(
      seed.write({ space, id, type, path: [] }, { value: keyedMap(length) })
        .ok,
    ).toBeTruthy();
    expect((await seed.commit().settled).ok).toBeTruthy();
    const seeded = commits;

    const tx = storage.edit();
    const path = ["value", "key-0", "name"];
    expect(tx.write({ space, id, type, path }, "changed").ok).toBeTruthy();
    expect(tx.write({ space, id, type, path }, "entry-0").ok).toBeTruthy();
    expect((await tx.commit().settled).ok).toBeTruthy();
    return commits - seeded;
  } finally {
    await storage.close();
  }
};

/** An object of `size` keys, each holding a small record. */
const recordsOfSize = (size: number, prefix: string) => {
  const records: Record<string, { name: string }> = {};
  for (let index = 0; index < size; index++) {
    records[`${prefix}-${index}`] = { name: `${prefix}-${index}` };
  }
  return records;
};

/**
 * Commits a document whose `value` holds `size` keys, then commits a second
 * transaction writing `added` new keys beneath it, and reports how many times
 * that second commit copied a container of at least `size` keys, and what the
 * document held afterward.
 *
 * A container is copied for a mutation by a shallow `Object.assign()` from it,
 * so counting the calls whose source is that large counts the copies of the
 * document's `value`, in the client's replay of its pending write and in the
 * emulated server's application of it alike. A count that tracks `added` is
 * each written key copying the whole object again.
 */
const largeCopiesAddingKeys = async (
  size: number,
  added: number,
): Promise<{ copies: number; keys: number }> => {
  const storage = StorageManager.emulate({ as: signer });
  try {
    const address = {
      space,
      id: `of:v2-transaction-add-${added}` as URI,
      type,
    };
    const seed = storage.edit();
    expect(
      seed.write({ ...address, path: [] }, {
        value: recordsOfSize(size, "key"),
      }).ok,
    ).toBeTruthy();
    expect((await seed.commit().settled).ok).toBeTruthy();

    const tx = storage.edit();
    for (const [key, record] of Object.entries(recordsOfSize(added, "added"))) {
      expect(tx.write({ ...address, path: ["value", key] }, record).ok)
        .toBeTruthy();
    }

    const assign = Object.assign;
    let copies = 0;
    Object.assign = ((target: object, ...sources: object[]) => {
      if (
        sources.some((source) =>
          source != null && Object.keys(source).length >= size
        )
      ) {
        copies++;
      }
      return assign(target, ...sources);
    }) as typeof Object.assign;
    try {
      expect((await tx.commit().settled).ok).toBeTruthy();
    } finally {
      Object.assign = assign;
    }

    const read = storage.edit().read({ ...address, path: ["value"] });
    return { copies, keys: Object.keys(read.ok!.value as object).length };
  } finally {
    await storage.close();
  }
};

/**
 * Commits a document whose `value` holds `size` keys, takes the same shallow
 * read of that `value` `repeats` times in a transaction that validates its
 * reactive reads, changes one of the values from a second transaction, and
 * reports how many times the first transaction's empty commit listed the keys
 * of an object of at least `size` keys, and whether that commit was accepted.
 *
 * The change leaves the key set as it was, so the shallow read still holds, but
 * it gives the value a new identity, so checking the read has to compare key
 * sets. A count that tracks `repeats` is the same read being checked again.
 */
const listingsValidatingRepeatedShallowReads = async (
  size: number,
  repeats: number,
): Promise<{ listings: number; accepted: boolean }> => {
  const storage = StorageManager.emulate({ as: signer });
  try {
    const address = {
      space,
      id: `of:v2-transaction-shallow-${repeats}` as URI,
      type,
    };
    const seed = storage.edit();
    expect(
      seed.write({ ...address, path: [] }, {
        value: recordsOfSize(size, "key"),
      }).ok,
    ).toBeTruthy();
    expect((await seed.commit().settled).ok).toBeTruthy();

    const reader = storage.edit();
    reader.validateReactiveReads = true;
    for (let index = 0; index < repeats; index++) {
      expect(
        reader.read({ ...address, path: ["value"] }, { nonRecursive: true })
          .ok,
      ).toBeTruthy();
    }

    const writer = storage.edit();
    expect(
      writer.write({ ...address, path: ["value", "key-0", "name"] }, "renamed")
        .ok,
    ).toBeTruthy();
    expect((await writer.commit().settled).ok).toBeTruthy();

    const keys = Object.keys;
    let listings = 0;
    Object.keys = ((target: object) => {
      const listed = keys(target);
      if (listed.length >= size) listings++;
      return listed;
    }) as typeof Object.keys;
    let accepted;
    try {
      accepted = (await reader.commit().settled).error === undefined;
    } finally {
      Object.keys = keys;
    }
    return { listings, accepted };
  } finally {
    await storage.close();
  }
};

/**
 * Writes `x: 9` into the value of the document at `address`, then sets the
 * `length` of its `arr` to `2 ** 32`, as one batch.
 */
const writeBatchEndingInOutOfRangeLength = (
  tx: IStorageTransaction,
  address: Omit<IMemorySpaceAddress, "path">,
) =>
  tx.writeBatch!([
    { address: { ...address, path: ["value", "x"] }, value: 9 },
    {
      address: { ...address, path: ["value", "arr", "length"] },
      value: 2 ** 32,
    },
  ]);

/**
 * Commits `{ x: 1 }` as the value of the document `id`, and opens a
 * transaction that has written it `{ x: 2 }`. That transaction edits its
 * working value in place from then on, and the commit sends what that value
 * holds, so a later write that changed it would show in both.
 */
const transactionOverEditedValue = async (id: URI) => {
  const storage = StorageManager.emulate({ as: signer });
  const address = { space, id, type };
  const seed = storage.edit();
  expect(seed.write({ ...address, path: [] }, { value: { x: 1 } }).ok)
    .toBeTruthy();
  expect((await seed.commit().settled).ok).toBeTruthy();
  const tx = storage.edit();
  expect(tx.write({ ...address, path: ["value"] }, { x: 2 }).ok).toBeTruthy();
  return { storage, address, tx };
};

/** Commits `tx`, and returns the value `storage` then holds at `address`. */
const committedValue = async (
  storage: ReturnType<typeof StorageManager.emulate>,
  address: { space: typeof space; id: URI; type: typeof type },
  tx: ReturnType<ReturnType<typeof StorageManager.emulate>["edit"]>,
): Promise<unknown> => {
  expect((await tx.commit().settled).ok).toBeTruthy();
  return storage.edit().read({ ...address, path: ["value"] }).ok?.value;
};

describe("v2-transaction", () => {
  describe("trackReadPaths()", () => {
    it("omits ignored commit validation while retaining read activity", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        for (
          const [ignored, nonRecursive] of [
            [false, false],
            [false, true],
            [true, false],
            [true, true],
          ]
        ) {
          const address = {
            space,
            id:
              `of:batched-commit-validation-${ignored}-${nonRecursive}` as URI,
            type,
          };
          const seed = storage.edit();
          expect(seed.write({ ...address, path: [] }, { value: 1 }).ok)
            .toBeDefined();
          expect((await seed.commit().settled).ok).toBeDefined();

          const candidate = storage.edit();
          expect(
            candidate.trackReadPaths!(address, [["value"]], {
              nonRecursive,
              ...(ignored ? { meta: ignoreReadForCommit } : {}),
            }).ok,
          ).toBeDefined();
          const reads = [...candidate.getReadActivities!()];
          expect(reads).toHaveLength(1);
          expect(reads[0].path).toEqual(["value"]);
          expect(reads[0].nonRecursive === true).toBe(nonRecursive);
          expect(isReadIgnoredForCommit(reads[0].meta)).toBe(ignored);
          expect(isInternalVerifierRead(reads[0].meta)).toBe(false);
          expect(
            candidate.write({
              ...address,
              id: `${address.id}-destination` as URI,
              path: [],
            }, { value: "unrelated" }).ok,
          ).toBeDefined();

          const concurrent = storage.edit();
          expect(concurrent.write({ ...address, path: [] }, { value: 2 }).ok)
            .toBeDefined();
          expect((await concurrent.commit().settled).ok).toBeDefined();

          const committed = await candidate.commit().settled;
          if (ignored) {
            expect(committed.ok).toBeDefined();
          } else {
            expect(committed.error?.name).toBe(
              "StorageTransactionInconsistent",
            );
          }
        }
      } finally {
        await storage.close();
      }
    });
  });

  describe("getPotentiallyExternalReadActivities()", () => {
    it("retains every raw clock position while excluding sealed verifier records", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = { space, id: "of:candidate-clock" as URI, type };
        expect(tx.write({ ...address, path: [] }, { value: { a: 1, b: 2 } }).ok)
          .toBeDefined();
        const before = [...tx.getReadActivities!()];
        expect(tx.read({ ...address, path: ["value", "a"] }).ok).toBeDefined();
        expect(
          tx.read({ ...address, path: ["value", "a"] }, {
            meta: stableInternalVerifierRead,
          }).ok,
        ).toBeDefined();
        expect(
          tx.trackReadPaths!(address, [["value", "a"], ["value", "b"]], {
            meta: stableInternalVerifierRead,
            nonRecursive: true,
          }).ok,
        ).toBeDefined();
        expect(
          tx.trackReadPaths!(address, [["value"]], {
            meta: stableInternalVerifierRead,
          }).ok,
        ).toBeDefined();
        expect(tx.read({ ...address, path: ["value", "b"] }).ok).toBeDefined();
        const raw = [...tx.getReadActivities!()].slice(before.length);
        const candidates = [...tx.getPotentiallyExternalReadActivities!()!]
          .filter((read) => !before.includes(read));
        expect(raw).toHaveLength(6);
        expect(candidates).toEqual([raw[0], raw[5]]);
        expect(raw.map((read) => read.journalIndex)).toEqual(
          Array.from({ length: 6 }, (_, i) => raw[0].journalIndex! + i),
        );
        for (const read of raw.slice(1, 5)) {
          expect(Object.isFrozen(read)).toBe(true);
          expect(Object.isFrozen(read.meta)).toBe(true);
          expect(() => {
            read.meta = {};
          }).toThrow(TypeError);
        }
        expect(Object.isFrozen(raw[0])).toBe(false);
        expect(Object.isFrozen(raw[5])).toBe(false);
      } finally {
        await storage.close();
      }
    });

    it("keeps mutable internal metadata available for reclassification", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = {
          space,
          id: "of:candidate-mutable" as URI,
          type,
          path: [],
        };
        expect(tx.write(address, { value: "body" }).ok).toBeDefined();
        const meta = { ...internalVerifierRead };
        expect(tx.read(address, { meta }).ok).toBeDefined();
        const read = [...tx.getReadActivities!()].at(-1)!;
        expect([...tx.getPotentiallyExternalReadActivities!()!]).toContain(
          read,
        );
        expect(isInternalVerifierRead(read.meta)).toBe(true);
        for (const key of Reflect.ownKeys(meta)) delete meta[key];
        expect(isInternalVerifierRead(read.meta)).toBe(false);
        expect([...tx.getPotentiallyExternalReadActivities!()!]).toContain(
          read,
        );
        read.meta = { ...internalVerifierRead };
        expect(isInternalVerifierRead(read.meta)).toBe(true);
        expect([...tx.getPotentiallyExternalReadActivities!()!]).toContain(
          read,
        );
        const copied = Object.freeze({ ...stableInternalVerifierRead });
        expect(tx.read(address, { meta: copied }).ok).toBeDefined();
        const copiedRead = [...tx.getReadActivities!()].at(-1)!;
        expect(Object.isFrozen(copiedRead)).toBe(false);
        expect([...tx.getPotentiallyExternalReadActivities!()!]).toContain(
          copiedRead,
        );
      } finally {
        await storage.close();
      }
    });

    it("clears both read logs after a completed storage commit", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = {
          space,
          id: "of:candidate-finish" as URI,
          type,
          path: [],
        };
        expect(tx.write(address, { value: "body" }).ok).toBeDefined();
        expect(tx.read(address).ok).toBeDefined();
        expect(tx.read(address, { meta: stableInternalVerifierRead }).ok)
          .toBeDefined();
        expect([...tx.getPotentiallyExternalReadActivities!()!].length)
          .toBeGreaterThan(0);
        expect((await tx.commit().settled).ok).toBeDefined();
        expect([...tx.getReadActivities!()]).toEqual([]);
        expect([...tx.getPotentiallyExternalReadActivities!()!]).toEqual([]);
      } finally {
        await storage.close();
      }
    });
  });

  describe("read()", () => {
    it("takes the same number of property descriptors for a long list as for a short one", async () => {
      const short = await wholeListRead(20);
      const long = await wholeListRead(200);

      expect((short.value as unknown[]).length).toBe(20);
      expect((long.value as unknown[]).length).toBe(200);

      // What the read hands back is a value the write path already converted
      // to fabric form, so nothing about it has to be established a second
      // time. Both bounds are needed: the equality alone would hold for two
      // counts that each grew with their own list, and the bound alone would
      // hold for a count that grew slowly.
      expect(long.descriptors).toBe(short.descriptors);
      expect(long.descriptors).toBeLessThan(20);
    });

    it("returns a deep-frozen value", async () => {
      // The read owes its caller a value that later writes cannot change
      // under it. That is what the count above must not be bought with.
      const { value } = await wholeListRead(20);

      expect(isDeepFrozen(value)).toBe(true);
    });
  });

  describe("write()", () => {
    it("returns an `InvalidArrayLengthError` for an array `length` of `2 ** 32`, and leaves the array as it was", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = { space, id: "of:write-length-range" as URI, type };
        expect(tx.write({ ...address, path: [] }, { value: { arr: [1] } }).ok)
          .toBeDefined();

        const result = tx.write(
          { ...address, path: ["value", "arr", "length"] },
          2 ** 32,
        );

        expect(result.error?.name).toBe("InvalidArrayLengthError");
        expect(
          result.error?.name === "InvalidArrayLengthError"
            ? result.error.address.path
            : undefined,
        ).toEqual(["value", "arr", "length"]);
        expect(tx.read({ ...address, path: ["value"] }).ok?.value).toEqual({
          arr: [1],
        });
      } finally {
        await storage.close();
      }
    });

    it("leaves the value unchanged when it refuses a leaf of `-` beneath a missing parent", async () => {
      // `a` is missing, and the array a write would create for it takes no
      // key but an index.

      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-refused-leaf",
      );
      try {
        const refused = tx.write({ ...address, path: ["value", "a", "-"] }, 5);

        expect(refused.error?.name).toBe("TypeMismatchError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ x: 2 });
        expect(await committedValue(storage, address, tx)).toEqual({ x: 2 });
      } finally {
        await storage.close();
      }
    });

    it("returns a `TypeMismatchError` for `-` beneath a missing parent short of the leaf, and leaves the value unchanged", async () => {
      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-refused-created-array",
      );
      try {
        const refused = tx.write(
          { ...address, path: ["value", "a", "-", "b"] },
          5,
        );

        expect(
          refused.error?.name === "TypeMismatchError" && {
            path: refused.error.address.path,
            actualType: refused.error.actualType,
          },
        ).toEqual({ path: ["value", "a", "-"], actualType: "array" });
        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ x: 2 });
        expect(await committedValue(storage, address, tx)).toEqual({ x: 2 });
      } finally {
        await storage.close();
      }
    });

    it("returns a `TypeMismatchError` for a key other than an index into an existing array, short of the leaf", async () => {
      // An array holds nothing under `name`, so what the write would put
      // there is a value no read of the array reports and no commit carries.

      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-refused-array-key",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "x"] }, [1, 2]).ok)
          .toBeTruthy();

        const refused = tx.write(
          { ...address, path: ["value", "x", "name", "first"] },
          "Ada",
        );

        expect(
          refused.error?.name === "TypeMismatchError" && {
            path: refused.error.address.path,
            actualType: refused.error.actualType,
          },
        ).toEqual({ path: ["value", "x", "name"], actualType: "array" });
        expect(
          tx.read({ ...address, path: ["value", "x", "name", "first"] }).ok
            ?.value,
        ).toBeUndefined();
        expect(await committedValue(storage, address, tx)).toEqual({
          x: [1, 2],
        });
      } finally {
        await storage.close();
      }
    });

    it("deletes nothing through a key the value only inherits", async () => {
      // `toString` names a member of every record's prototype and no slot of
      // this one, so the delete has nothing to remove.

      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-delete-inherited",
      );
      try {
        expect(
          tx.write(
            { ...address, path: ["value", "toString", "x"] },
            undefined,
            { delete: true },
          ).ok,
        ).toBeTruthy();

        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ x: 2 });
        expect(await committedValue(storage, address, tx)).toEqual({ x: 2 });
      } finally {
        await storage.close();
      }
    });

    it("deletes nothing through a key an array cannot hold, or through a primitive", async () => {
      // Neither path reaches a slot, so each delete has nothing to remove;
      // `writeBatch()` answers the same, below.

      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-delete-unreachable",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "x"] }, [1, 2]).ok)
          .toBeTruthy();

        for (
          const path of [["value", "x", "name"], ["value", "x", "0", "y"]]
        ) {
          expect(
            tx.write({ ...address, path }, undefined, { delete: true }).error,
          ).toBeUndefined();
        }

        expect(await committedValue(storage, address, tx)).toEqual({
          x: [1, 2],
        });
      } finally {
        await storage.close();
      }
    });
  });

  describe("writeBatch()", () => {
    /** A value `cloneIfNecessary()` throws on, as a run clones each value. */
    const unclonable = new (class Unclonable {})() as unknown as FabricValue;

    it("keeps the writes ahead of a refused array `length`, and reads and commits them", async () => {
      // The document is stored before the transaction opens, so the batch is
      // the transaction's first write to it.

      const storage = StorageManager.emulate({ as: signer });
      try {
        const address = { space, id: "of:batch-length-stored" as URI, type };
        const seed = storage.edit();
        expect(seed.write({ ...address, path: [] }, { value: { arr: [1] } }).ok)
          .toBeDefined();
        expect((await seed.commit().settled).ok).toBeDefined();
        const tx = storage.edit();

        const result = writeBatchEndingInOutOfRangeLength(tx, address);

        expect(result.error?.name).toBe("InvalidArrayLengthError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value).toEqual({
          arr: [1],
          x: 9,
        });
        expect((await tx.commit().settled).ok).toBeDefined();
        expect(
          storage.edit().read({ ...address, path: ["value"] }).ok?.value,
        ).toEqual({ arr: [1], x: 9 });
      } finally {
        await storage.close();
      }
    });

    it("returns the writes ahead of a refused array `length` to a read repeated after the batch", async () => {
      // The transaction writes the document and reads `value` back before the
      // batch, which caches a frozen snapshot of it and keeps the root for
      // readers. The second read sees the kept write only if the batch
      // installs a new root and drops that snapshot.

      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = { space, id: "of:batch-length-read" as URI, type };
        expect(tx.write({ ...address, path: [] }, { value: { arr: [1] } }).ok)
          .toBeDefined();
        expect(tx.read({ ...address, path: ["value"] }).ok?.value).toEqual({
          arr: [1],
        });

        const result = writeBatchEndingInOutOfRangeLength(tx, address);

        expect(result.error?.name).toBe("InvalidArrayLengthError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value).toEqual({
          arr: [1],
          x: 9,
        });
        expect((await tx.commit().settled).ok).toBeDefined();
        expect(
          storage.edit().read({ ...address, path: ["value"] }).ok?.value,
        ).toEqual({ arr: [1], x: 9 });
      } finally {
        await storage.close();
      }
    });

    it("returns what separate writes return for the same list, and records the same write details", async () => {
      // Each list is applied twice over the same document: as separate
      // `write()`s, stopping at the first refusal as a batch does, and as one
      // batch. Each starts by writing `value/e`, so the rest land on a working
      // value the transaction already edits in place.

      type Step = [path: string[], value: FabricValue, isDelete?: boolean];
      const lists: Step[][] = [
        [
          [["value", "y"], 3],
          [["value", "x", "name"], undefined, true],
          [["value", "z"], 4],
        ],
        [[["value", "y"], 3], [["value", "a", "-"], 5], [["value", "z"], 4]],
        [[["value", "x", "0"], 9], [["value", "x", "length"], 1]],
        [[["value", "n", "q"], undefined, true], [["value", "y"], 3]],
        [
          [["value", "new", "deep", "k"], 1],
          [["value", "new", "deep", "j"], 2],
        ],
        [[["value"], undefined, true], [["value", "a"], 1]],
      ];

      const outcome = async (steps: Step[], asBatch: boolean) => {
        const storage = StorageManager.emulate({ as: signer });
        try {
          const address = {
            space,
            id: "of:v2-transaction-parity" as URI,
            type,
          };
          const seed = storage.edit();
          expect(
            seed.write({ ...address, path: [] }, {
              value: { x: [1, 2], n: 5 },
            }).ok,
          ).toBeTruthy();
          expect((await seed.commit().settled).ok).toBeTruthy();

          const tx = storage.edit();
          expect(tx.write({ ...address, path: ["value", "e"] }, 1).ok)
            .toBeTruthy();
          let error: string | undefined;
          if (asBatch) {
            error = tx.writeBatch!(
              steps.map(([path, value, isDelete]) => ({
                address: { ...address, path },
                value,
                delete: isDelete,
              })),
            ).error?.name;
          } else {
            for (const [path, value, isDelete] of steps) {
              error = tx.write(
                { ...address, path },
                value,
                isDelete ? { delete: true } : undefined,
              ).error?.name;
              if (error !== undefined) break;
            }
          }
          return {
            error,
            value: tx.read({ ...address, path: ["value"] }).ok?.value,
            details: [...tx.getWriteDetails!(space)],
          };
        } finally {
          await storage.close();
        }
      };

      for (const steps of lists) {
        const separate = await outcome(steps, false);
        const batched = await outcome(steps, true);

        expect({ steps, ...batched }).toEqual({ steps, ...separate });
      }
    });

    it("keeps the writes ahead of a refused one, and nothing of the refused one", async () => {
      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-batch-refused-later",
      );
      try {
        const result = tx.writeBatch!([
          { address: { ...address, path: ["value", "y"] }, value: 3 },
          { address: { ...address, path: ["value", "a", "-"] }, value: 5 },
          { address: { ...address, path: ["value", "z"] }, value: 4 },
        ]);

        expect(result.error?.name).toBe("TypeMismatchError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ x: 2, y: 3 });
        expect(await committedValue(storage, address, tx)).toEqual({
          x: 2,
          y: 3,
        });
      } finally {
        await storage.close();
      }
    });

    it("leaves the value unchanged when its first write is refused", async () => {
      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-batch-refused-first",
      );
      try {
        const result = tx.writeBatch!([
          { address: { ...address, path: ["value", "a", "-"] }, value: 5 },
          { address: { ...address, path: ["value", "y"] }, value: 3 },
        ]);

        expect(result.error?.name).toBe("TypeMismatchError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ x: 2 });
        expect(await committedValue(storage, address, tx)).toEqual({ x: 2 });
      } finally {
        await storage.close();
      }
    });

    it("deletes nothing through a key an array cannot hold, alone or beside another write", async () => {
      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-batch-delete-unreachable",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "x"] }, [1, 2]).ok)
          .toBeTruthy();
        const unreachable = {
          address: { ...address, path: ["value", "x", "name"] },
          value: undefined,
          delete: true,
        };

        expect(tx.writeBatch!([unreachable]).error).toBeUndefined();
        expect(
          tx.writeBatch!([
            unreachable,
            { address: { ...address, path: ["value", "y"] }, value: 3 },
          ]).error,
        ).toBeUndefined();

        expect(await committedValue(storage, address, tx)).toEqual({
          x: [1, 2],
          y: 3,
        });
      } finally {
        await storage.close();
      }
    });

    it("applies the writes before one that throws, for reads and for the commit", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = { space, id: "of:write-batch-throw" as URI, type };
        expect(tx.write({ ...address, path: [] }, { value: { list: [1] } }).ok)
          .toBeDefined();
        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ list: [1] });

        expect(() =>
          tx.writeBatch!([
            { address: { ...address, path: ["value", "z"] }, value: 5 },
            {
              address: { ...address, path: ["value", "w"] },
              value: unclonable,
            },
          ])
        ).toThrow("Cannot clone");

        expect(tx.read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ list: [1], z: 5 });
        expect((await tx.commit().settled).ok).toBeDefined();
        expect(storage.edit().read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ list: [1], z: 5 });
      } finally {
        await storage.close();
      }
    });

    it("applies the writes before one that throws to paths read before the run, on a root it edits in place", async () => {
      // The second write leaves the document's root mutable, so the run
      // edits that root where it stands, under reads cached before the run of
      // each path it writes.

      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = {
          space,
          id: "of:write-batch-throw-in-place" as URI,
          type,
        };
        expect(tx.write({ ...address, path: [] }, { value: { list: [1] } }).ok)
          .toBeDefined();
        expect(tx.write({ ...address, path: ["value", "list", "0"] }, 2).ok)
          .toBeDefined();
        expect(tx.read({ ...address, path: ["value", "z"] }).ok?.value)
          .toBeUndefined();
        expect(tx.read({ ...address, path: ["value", "y"] }).ok?.value)
          .toBeUndefined();

        expect(() =>
          tx.writeBatch!([
            { address: { ...address, path: ["value", "z"] }, value: 5 },
            { address: { ...address, path: ["value", "y"] }, value: 6 },
            {
              address: { ...address, path: ["value", "w"] },
              value: unclonable,
            },
          ])
        ).toThrow("Cannot clone");

        expect(tx.read({ ...address, path: ["value", "z"] }).ok?.value)
          .toBe(5);
        expect(tx.read({ ...address, path: ["value", "y"] }).ok?.value)
          .toBe(6);
        expect((await tx.commit().settled).ok).toBeDefined();
        expect(storage.edit().read({ ...address, path: ["value"] }).ok?.value)
          .toEqual({ list: [2], z: 5, y: 6 });
      } finally {
        await storage.close();
      }
    });

    it("leaves `hasWrites()` returning `true` after a throw only when a write before it changed the document", async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const tx = storage.edit();
        const address = {
          space,
          id: "of:write-batch-throw-first" as URI,
          type,
        };
        expect(tx.hasWrites!()).toBe(false);

        expect(() =>
          tx.writeBatch!([
            {
              address: { ...address, path: ["value", "w"] },
              value: unclonable,
            },
            { address: { ...address, path: ["value", "z"] }, value: 5 },
          ])
        ).toThrow("Cannot clone");
        expect(tx.hasWrites!()).toBe(false);

        expect(() =>
          tx.writeBatch!([
            { address: { ...address, path: ["value", "z"] }, value: 5 },
            {
              address: { ...address, path: ["value", "w"] },
              value: unclonable,
            },
          ])
        ).toThrow("Cannot clone");
        expect(tx.hasWrites!()).toBe(true);
      } finally {
        await storage.close();
      }
    });
  });

  describe("getReactivityLog()", () => {
    // A document's written paths are computed once and kept until the next
    // write to it, so what these cases pin is that the log still follows the
    // writes: a write after the log was built shows up in the next one, and a
    // read in between changes nothing about them.

    /** Commits a document holding `{ value: { a: 1 } }` and opens a writer. */
    const writerOverCommittedDocument = async (id: URI) => {
      const storage = StorageManager.emulate({ as: signer });
      const address = { space, id, type };
      const seed = storage.edit();
      expect(seed.write({ ...address, path: [] }, { value: { a: 1 } }).ok)
        .toBeTruthy();
      expect((await seed.commit().settled).ok).toBeTruthy();
      return { storage, address, tx: storage.edit() };
    };

    it("returns a write made after the log was last built", async () => {
      const { storage, address, tx } = await writerOverCommittedDocument(
        "of:v2-transaction-log-after-build",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "b"] }, 2).ok)
          .toBeTruthy();
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual([["value"], ["value", "b"]]);

        expect(tx.write({ ...address, path: ["value", "c"] }, 3).ok)
          .toBeTruthy();
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual([["value"], ["value", "b"], ["value", "c"]]);

        expect(tx.write({ ...address, path: ["value", "c"] }, 4).ok)
          .toBeTruthy();
        expect(
          tx.write({ ...address, path: ["value", "b"] }, undefined, {
            delete: true,
          }).ok,
        ).toBeTruthy();
        // `b` is back where it began, so only `c` and the key set it grew are
        // left to report.
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual([["value"], ["value", "c"]]);
      } finally {
        await storage.close();
      }
    });

    it("returns the writes of a batch made after the log was last built", async () => {
      const { storage, address, tx } = await writerOverCommittedDocument(
        "of:v2-transaction-log-after-batch",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "b"] }, 2).ok)
          .toBeTruthy();
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual([["value"], ["value", "b"]]);

        expect(
          tx.writeBatch!([
            { address: { ...address, path: ["value", "c"] }, value: 3 },
            { address: { ...address, path: ["value", "a"] }, value: 9 },
          ]).ok,
        ).toBeTruthy();
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual([
            ["value"],
            ["value", "a"],
            ["value", "b"],
            ["value", "c"],
          ]);
      } finally {
        await storage.close();
      }
    });

    it("returns no writes after a refused write, which leaves the document as it was", async () => {
      // The two writes ahead of the refused one leave the working value edited
      // in place yet equal to what was committed, so the log holds no writes.
      // A refusal that changed that value would show here as a write under
      // `value`.

      const { storage, address, tx } = await writerOverCommittedDocument(
        "of:v2-transaction-log-refused-write",
      );
      try {
        expect(tx.write({ ...address, path: ["value"] }, { a: 2 }).ok)
          .toBeTruthy();
        expect(tx.write({ ...address, path: ["value"] }, { a: 1 }).ok)
          .toBeTruthy();
        expect(tx.getReactivityLog!().writes).toEqual([]);

        expect(tx.write({ ...address, path: ["value", "b", "-"] }, 5).error)
          .toBeDefined();

        expect(
          tx.read({ ...address, path: ["value"] }, {
            meta: stableInternalVerifierRead,
          }).ok?.value,
        ).toEqual({ a: 1 });
        expect(tx.getReactivityLog!().writes).toEqual([]);
      } finally {
        await storage.close();
      }
    });

    it("returns no writes after a refused batch, which leaves the document as it was", async () => {
      // The batch counterpart of the case above: the batch's first write is
      // refused, so the batch applies nothing, and a refusal that changed the
      // working value would show here as a write under `value`.

      const { storage, address, tx } = await writerOverCommittedDocument(
        "of:v2-transaction-log-refused-batch",
      );
      try {
        expect(tx.write({ ...address, path: ["value"] }, { a: 2 }).ok)
          .toBeTruthy();
        expect(tx.write({ ...address, path: ["value"] }, { a: 1 }).ok)
          .toBeTruthy();
        expect(tx.getReactivityLog!().writes).toEqual([]);

        expect(
          tx.writeBatch!([
            { address: { ...address, path: ["value", "b", "-"] }, value: 5 },
            { address: { ...address, path: ["value", "c"] }, value: 1 },
          ]).error,
        ).toBeDefined();

        expect(
          tx.read({ ...address, path: ["value"] }, {
            meta: stableInternalVerifierRead,
          }).ok?.value,
        ).toEqual({ a: 1 });
        expect(tx.getReactivityLog!().writes).toEqual([]);
      } finally {
        await storage.close();
      }
    });

    it("returns the same writes after a read as before it", async () => {
      const { storage, address, tx } = await writerOverCommittedDocument(
        "of:v2-transaction-log-across-read",
      );
      try {
        expect(tx.write({ ...address, path: ["value", "b"] }, 2).ok)
          .toBeTruthy();
        const before = tx.getReactivityLog!();

        expect(tx.read({ ...address, path: ["value", "a"] }).ok).toBeTruthy();
        const after = tx.getReactivityLog!();

        expect(after.writes).toEqual(before.writes);
        expect(after.reads.map(({ path }) => path)).toContainEqual([
          "value",
          "a",
        ]);
      } finally {
        await storage.close();
      }
    });
  });

  describe("commit()", () => {
    it("checks a shallow read of a large object once however often it was taken", async () => {
      const short = await listingsValidatingRepeatedShallowReads(1000, 10);
      const long = await listingsValidatingRepeatedShallowReads(1000, 100);

      expect(short.accepted).toBe(true);
      expect(long.accepted).toBe(true);
      // The floor keeps the probe honest: were the key sets no longer listed
      // through `Object.keys()`, both counts would read zero and agree.
      expect(short.listings).toBeGreaterThan(0);
      expect(long.listings).toBe(short.listings);
    });

    it("copies a large object as often for many written keys beneath it as for few", async () => {
      const short = await largeCopiesAddingKeys(1000, 10);
      const long = await largeCopiesAddingKeys(1000, 100);

      expect(short.keys).toBe(1010);
      expect(long.keys).toBe(1100);
      // The floor keeps the probe honest: were the copy no longer made through
      // `Object.assign()`, both counts would read zero and agree.
      expect(short.copies).toBeGreaterThan(0);
      expect(long.copies).toBe(short.copies);
    });

    it("hashes as many containers committing one entry of a long map as of a short one", async () => {
      const short = await oneEntryCommit(20);
      const long = await oneEntryCommit(2_000);

      // Both are needed: the equality alone passes a count that is flat but
      // large, and the bound alone passes one that grows slowly with the map.
      // The bound is one whole hash of the short document.
      expect(long.containersHashed).toBe(short.containersHashed);
      expect(long.containersHashed).toBeLessThan(containersOfDocument(20));
      expect(long.foreignContainersHashed).toBe(
        short.foreignContainersHashed,
      );
      expect(long.foreignContainersHashed).toBeLessThan(
        containersOfDocument(20),
      );
    });

    it("notifies the path each commit changed: its own once, and another session's through the echo", async () => {
      // What the count above must not be bought with: the notification is
      // what reactivity reads, and it has to name the change and only that.
      // The replica's own echo holds what it already shows, so it notifies
      // nothing; the other session's change arriving the same way is what
      // shows the echo is compared at all.
      const { changedPaths, echoedPaths, foreignPaths } = await oneEntryCommit(
        2_000,
      );

      expect(changedPaths).toEqual([["value", "key-0", "name"]]);
      expect(echoedPaths).toEqual([]);
      expect(foreignPaths).toEqual([["value", "key-5", "name"]]);
    });

    it("commits nothing when writes leave the document equal to where it started", async () => {
      expect(await revertedWriteCommits(2_000)).toBe(0);
    });
  });
});
