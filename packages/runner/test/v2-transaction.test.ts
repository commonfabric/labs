import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isDeepFrozen, valueEqual } from "@commonfabric/data-model";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IMemorySpaceAddress,
  IStorageTransaction,
  URI,
} from "../src/storage/interface.ts";
import {
  internalVerifierRead,
  isInternalVerifierRead,
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
    expect((await seed.commit()).ok).toBeTruthy();

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
      expect((await tx.commit()).ok).toBeTruthy();
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
    expect((await seed.commit()).ok).toBeTruthy();

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
    expect((await writer.commit()).ok).toBeTruthy();

    const keys = Object.keys;
    let listings = 0;
    Object.keys = ((target: object) => {
      const listed = keys(target);
      if (listed.length >= size) listings++;
      return listed;
    }) as typeof Object.keys;
    let accepted;
    try {
      accepted = (await reader.commit()).error === undefined;
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

describe("v2-transaction", () => {
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
        expect((await tx.commit()).ok).toBeDefined();
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
  });

  describe("writeBatch()", () => {
    it("keeps the writes ahead of a refused array `length`, and reads and commits them", async () => {
      // The document is stored before the transaction opens, so the batch is
      // the transaction's first write to it.

      const storage = StorageManager.emulate({ as: signer });
      try {
        const address = { space, id: "of:batch-length-stored" as URI, type };
        const seed = storage.edit();
        expect(seed.write({ ...address, path: [] }, { value: { arr: [1] } }).ok)
          .toBeDefined();
        expect((await seed.commit()).ok).toBeDefined();
        const tx = storage.edit();

        const result = writeBatchEndingInOutOfRangeLength(tx, address);

        expect(result.error?.name).toBe("InvalidArrayLengthError");
        expect(tx.read({ ...address, path: ["value"] }).ok?.value).toEqual({
          arr: [1],
          x: 9,
        });
        expect((await tx.commit()).ok).toBeDefined();
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
        expect((await tx.commit()).ok).toBeDefined();
        expect(
          storage.edit().read({ ...address, path: ["value"] }).ok?.value,
        ).toEqual({ arr: [1], x: 9 });
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
      expect((await seed.commit()).ok).toBeTruthy();
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

    it("returns what a refused write left changed in the document", async () => {
      // A write of `-` beneath a missing parent is refused only after the
      // parent is created in the working value, so the refusal can leave the
      // document changed. Whether it should is the write's business. What is
      // pinned here is that paths kept from before the refused write are not
      // reused after it: beneath `value`, a path this transaction wrote, the
      // log follows whatever the refusal left there.

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
        const left = tx.read({ ...address, path: ["value"] }, {
          meta: stableInternalVerifierRead,
        }).ok!.value;
        expect(tx.getReactivityLog!().writes.map(({ path }) => path))
          .toEqual(valueEqual(left, { a: 1 }) ? [] : [["value"]]);
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
  });
});
