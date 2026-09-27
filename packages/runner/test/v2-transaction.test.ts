import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isDeepFrozen } from "@commonfabric/data-model";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { URI } from "../src/storage/interface.ts";
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
  expect((await seed.commit()).ok).toBeTruthy();
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
  expect((await tx.commit()).ok).toBeTruthy();
  return storage.edit().read({ ...address, path: ["value"] }).ok?.value;
};

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

    it("refuses `-` beneath a missing parent short of the leaf, and leaves the value unchanged", async () => {
      const { storage, address, tx } = await transactionOverEditedValue(
        "of:v2-transaction-refused-created-array",
      );
      try {
        const refused = tx.write(
          { ...address, path: ["value", "a", "-", "b"] },
          5,
        );

        expect(refused.error?.name).toBe("TypeMismatchError");
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

    it("refuses a key that is not an index into an existing array short of the leaf", async () => {
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
  });

  describe("writeBatch()", () => {
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
  });
});
