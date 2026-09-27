import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isDeepFrozen } from "@commonfabric/data-model";
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
});
