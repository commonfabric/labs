/**
 * Objects with many `Default<>`-like fields keep their values when pushed to
 * arrays.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Mimics the Person interface from parking-coordinator with many fields
interface Person {
  name: string;
  email: string;
  phone: string;
  usualCommuteMode: string;
  livesNearby: boolean;
  spotPreferences: number[];
  compatibleSpots: number[];
  defaultSpot: number | null;
  priorityRank: number;
  totalBookings: number;
  lastBookingDate: string | null;
  createdAt: number;
}

describe("array push with complex objects", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should preserve all fields for multiple complex objects pushed to array", () => {
    const arrayCell = runtime.getCell<Person[]>(
      space,
      "test-complex-array",
      undefined,
      tx,
    );
    arrayCell.set([]);

    const frame = {
      cause: "test-frame-complex",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    const pushed = pushFrame(frame);

    try {
      // Push first person (Alice)
      arrayCell.push({
        name: "Alice",
        email: "alice@example.com",
        phone: "123-456-7890",
        usualCommuteMode: "drive",
        livesNearby: false,
        spotPreferences: [1, 5],
        compatibleSpots: [1, 5, 12],
        defaultSpot: 1,
        priorityRank: 1,
        totalBookings: 0,
        lastBookingDate: null,
        createdAt: 1000,
      });

      // Push second person (Bob)
      arrayCell.push({
        name: "Bob",
        email: "bob@example.com",
        phone: "098-765-4321",
        usualCommuteMode: "bart",
        livesNearby: true,
        spotPreferences: [5, 12],
        compatibleSpots: [1, 5, 12],
        defaultSpot: 5,
        priorityRank: 2,
        totalBookings: 3,
        lastBookingDate: "2024-01-15",
        createdAt: 2000,
      });

      // Push third person (Charlie)
      arrayCell.push({
        name: "Charlie",
        email: "charlie@example.com",
        phone: "555-555-5555",
        usualCommuteMode: "bike",
        livesNearby: false,
        spotPreferences: [12],
        compatibleSpots: [1, 5, 12],
        defaultSpot: 12,
        priorityRank: 3,
        totalBookings: 10,
        lastBookingDate: "2024-01-10",
        createdAt: 3000,
      });
    } finally {
      popFrame(pushed);
    }

    // Read back via get()
    const items = arrayCell.get();

    console.log("Items via get():", JSON.stringify(items, null, 2));

    expect(items.length).toBe(3);

    // Verify ALICE (first item)
    expect(items[0].name).toBe("Alice");
    expect(items[0].email).toBe("alice@example.com");
    expect(items[0].defaultSpot).toBe(1);
    expect(items[0].priorityRank).toBe(1);
    expect(items[0].createdAt).toBe(1000);

    // Verify BOB (second item) - THIS IS WHERE THE BUG MANIFESTS
    expect(items[1].name).toBe("Bob");
    expect(items[1].email).toBe("bob@example.com");
    expect(items[1].defaultSpot).toBe(5);
    expect(items[1].priorityRank).toBe(2);
    expect(items[1].totalBookings).toBe(3);
    expect(items[1].lastBookingDate).toBe("2024-01-15");
    expect(items[1].createdAt).toBe(2000);

    // Verify CHARLIE (third item)
    expect(items[2].name).toBe("Charlie");
    expect(items[2].email).toBe("charlie@example.com");
    expect(items[2].defaultSpot).toBe(12);
    expect(items[2].priorityRank).toBe(3);
    expect(items[2].totalBookings).toBe(10);
    expect(items[2].createdAt).toBe(3000);
  });

  it("should handle separate push calls correctly", () => {
    const arrayCell = runtime.getCell<Person[]>(
      space,
      "test-separate-pushes",
      undefined,
      tx,
    );
    arrayCell.set([]);

    // First frame - push Alice
    const frame1 = {
      cause: "frame-1",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    const pushed1 = pushFrame(frame1);
    try {
      // Minted inside the frame: `Cell.push` anchors from the frame its cell was
      // constructed in, which is what makes the counter reset below observable.
      runtime.getCell<Person[]>(space, "test-separate-pushes", undefined, tx)
        .push({
          name: "Alice",
          email: "",
          phone: "",
          usualCommuteMode: "drive",
          livesNearby: false,
          spotPreferences: [],
          compatibleSpots: [1, 5, 12],
          defaultSpot: 1,
          priorityRank: 1,
          totalBookings: 0,
          lastBookingDate: null,
          createdAt: 1000,
        });
    } finally {
      popFrame(pushed1);
    }

    // Second frame - push Bob (simulating a separate handler call)
    const frame2 = {
      cause: "frame-2",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0, // NOTE: Counter resets!
      inHandler: true,
    };
    const pushed2 = pushFrame(frame2);
    try {
      runtime.getCell<Person[]>(space, "test-separate-pushes", undefined, tx)
        .push({
          name: "Bob",
          email: "",
          phone: "",
          usualCommuteMode: "drive",
          livesNearby: false,
          spotPreferences: [],
          compatibleSpots: [1, 5, 12],
          defaultSpot: 5,
          priorityRank: 2,
          totalBookings: 0,
          lastBookingDate: null,
          createdAt: 2000,
        });
    } finally {
      popFrame(pushed2);
    }

    const items = arrayCell.get();
    console.log("Separate pushes result:", JSON.stringify(items, null, 2));

    expect(items.length).toBe(2);
    expect(items[0].name).toBe("Alice");
    expect(items[0].defaultSpot).toBe(1);
    expect(items[1].name).toBe("Bob");
    expect(items[1].defaultSpot).toBe(5);
  });
});
