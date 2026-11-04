/**
 * `Cell.push` anchors an element that carries no explicit identity, so it is
 * stored as its own entity document and the array holds a link to it rather
 * than inline data.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { isPrimitiveCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("array push anchors its elements", () => {
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

  it("anchors objects pushed without an explicit identity", () => {
    // Create a cell with an empty array
    const arrayCell = runtime.getCell<{ name: string }[]>(
      space,
      "test-array-push-id",
      undefined,
      tx,
    );
    arrayCell.set([]);

    // Create a frame context (simulates being inside a handler)
    const frame = {
      cause: "test-frame",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    const pushed = pushFrame(frame);

    try {
      // Minted inside the frame: `Cell.push` anchors from the frame its cell was
      // constructed in. Pushed without an explicit identity, so anchoring is
      // what turns each element into its own entity.
      const inFrame = runtime.getCell<{ name: string }[]>(
        space,
        "test-array-push-id",
        undefined,
        tx,
      );
      inFrame.push({ name: "Alice" });
      inFrame.push({ name: "Bob" });
    } finally {
      popFrame(pushed);
    }

    // Read back the raw array data
    const result = tx.readValueOrThrow(
      arrayCell.getAsNormalizedFullLink(),
    ) as any[];

    console.log("Result array:", JSON.stringify(result, null, 2));

    // The array should have 2 items
    expect(result.length).toBe(2);

    // Each item should be stored as a cell link (entity reference), not
    // inline data: anchoring creates an entity document per pushed object
    // and stores a link to it in the array.
    for (let i = 0; i < result.length; i++) {
      const item = result[i];
      console.log(`Item ${i}:`, item, "isLink:", isPrimitiveCellLink(item));

      // Each item is a cell link, never an inline object like
      // `{ name: "Alice" }`.
      expect(isPrimitiveCellLink(item)).toBe(true);
    }
  });

  it("should persist all fields correctly for second+ items", () => {
    // Every field of every pushed item, not only the first, survives the push.
    const arrayCell = runtime.getCell<
      { name: string; priority: number; createdAt: number }[]
    >(
      space,
      "test-array-persistence",
      undefined,
      tx,
    );
    arrayCell.set([]);

    const frame = {
      cause: "test-frame-2",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    const pushed = pushFrame(frame);

    try {
      // Push multiple items with all fields populated
      arrayCell.push({ name: "Alice", priority: 1, createdAt: 1000 });
      arrayCell.push({ name: "Bob", priority: 2, createdAt: 2000 });
      arrayCell.push({ name: "Charlie", priority: 3, createdAt: 3000 });
    } finally {
      popFrame(pushed);
    }

    // Read back via the cell's get() method (which resolves links)
    const items = arrayCell.get();

    console.log("Items via get():", JSON.stringify(items, null, 2));

    expect(items.length).toBe(3);

    // Verify ALL items have correct values (not just the first one)
    expect(items[0]).toEqual({ name: "Alice", priority: 1, createdAt: 1000 });
    expect(items[1]).toEqual({ name: "Bob", priority: 2, createdAt: 2000 });
    expect(items[2]).toEqual({
      name: "Charlie",
      priority: 3,
      createdAt: 3000,
    });
  });
});
