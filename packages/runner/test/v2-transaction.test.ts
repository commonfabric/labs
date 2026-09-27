import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isDeepFrozen } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { StorageNotification, URI } from "../src/storage/interface.ts";
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

/** A keyed map of `length` records, the shape a directory or an index has. */
const keyedMap = (length: number) =>
  Object.fromEntries(
    Array.from({ length }, (_, index) => [
      `key-${index}`,
      { name: `entry-${index}`, nested: { id: `id-${index}` } },
    ]),
  );

/**
 * Commits a change to one entry of a document holding a keyed map of `length`
 * records, and reports how many containers were hashed from the commit through
 * the replica's integration of the server's echo, together with the paths the
 * commit's notification named.
 *
 * Every comparison on that path asks whether two versions of the document
 * differ. Comparing them by content hash feeds the hasher every container in
 * a version, so a count that tracks the length of the map is one of those
 * comparisons hashing the whole document.
 *
 * The echo is a copy of the document decoded afresh, sharing nothing with the
 * replica's own, so the paths its integration notifies are reported too.
 */
const oneEntryCommit = async (
  length: number,
): Promise<{
  containersHashed: number;
  changedPaths: string[][];
  echoedPaths: string[][];
}> => {
  const storage = StorageManager.emulate({ as: signer });
  const notifications: StorageNotification[] = [];
  // A subscriber is what makes the replica compute the change a commit makes,
  // for its own commit and again for the echo.
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return undefined;
    },
  });
  try {
    const id: URI = `of:v2-transaction-one-entry-${length}`;
    const seed = storage.edit();
    expect(
      seed.write({ space, id, type, path: [] }, { value: keyedMap(length) }).ok,
    ).toBeTruthy();
    expect((await seed.commit()).ok).toBeTruthy();
    // Watching the document is what has the server send the commit below back
    // to this replica.
    expect(
      (await storage.open(space).sync(id, { path: [], schema: true })).ok,
    ).toBeTruthy();
    await storage.synced();

    const before = getContainersHashedForTestingOnly();
    const notified = notifications.length;
    const tx = storage.edit();
    expect(
      tx.write({ space, id, type, path: ["value", "key-0", "name"] }, "edited")
        .ok,
    ).toBeTruthy();
    expect((await tx.commit()).ok).toBeTruthy();
    await storage.pullOpenSpacesToHead();
    const containersHashed = getContainersHashedForTestingOnly() - before;

    const pathsOf = (type: StorageNotification["type"]) =>
      notifications.slice(notified)
        .filter((notification) => notification.type === type)
        .flatMap((notification) =>
          "changes" in notification
            ? [...notification.changes].map((change) => [
              ...change.address.path,
            ])
            : []
        );
    return {
      containersHashed,
      changedPaths: pathsOf("commit"),
      echoedPaths: [...pathsOf("integrate"), ...pathsOf("pull")],
    };
  } finally {
    await storage.close();
  }
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

  describe("commit()", () => {
    it("hashes as many containers committing one entry of a long map as of a short one", async () => {
      const short = await oneEntryCommit(20);
      const long = await oneEntryCommit(2_000);

      // Both are needed: the equality alone passes a count that is flat but
      // large, and the bound alone passes one that grows slowly with the map.
      // Hashing the short document whole once already feeds the hasher 42
      // containers.
      expect(long.containersHashed).toBe(short.containersHashed);
      expect(long.containersHashed).toBeLessThan(20);
    });

    it("notifies the one path the commit changed, and no path for its echo", async () => {
      // What the count above must not be bought with: the notification is
      // what reactivity reads, and it has to name the change and only that.
      // The echo holds what the replica already shows, so comparing the two
      // finds nothing to notify.
      const { changedPaths, echoedPaths } = await oneEntryCommit(2_000);

      expect(changedPaths).toEqual([["value", "key-0", "name"]]);
      expect(echoedPaths).toEqual([]);
    });
  });
});
