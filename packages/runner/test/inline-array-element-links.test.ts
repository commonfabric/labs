import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("inline-array-element-links");
const space = signer.did();

const OWNER = {
  type: "object",
  properties: { first: { type: "string" } },
} as const satisfies JSONSchema;

/** The two ways a cell read materializes its value, by `describe()` title. */
const READS = [["an eager read", false], ["a lazy view", true]] as const;

describe("inline-array-element-links", () => {
  // An inline object or array element is read at a `data:` address carrying a
  // snapshot of its value. A link inside the element that names no document
  // resolves against the document storing the element, at the link's own
  // path. Every case stores its value raw, since `set()` would
  // give each object element a document of its own.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A link naming no document: the path `shared` of whichever stores it. */
  const sharedLink = (): FabricValue => ({
    "/": { [LINK_V1_TAG]: { path: ["shared"] } },
  });

  /**
   * Stores `{ first: "Bob" }` in a document of its own, and `build(shared)` in
   * a second document under `cause`, where `shared` is a link to the first.
   */
  const seed = async (
    cause: string,
    build: (shared: FabricValue) => FabricValue,
  ): Promise<void> => {
    const tx = runtime.edit();
    const target = runtime.getCell<{ first: string }>(
      space,
      `${cause}-target`,
      undefined,
      tx,
    );
    target.set({ first: "Bob" });
    runtime.getCell(space, cause, undefined, tx).setRawUntyped(
      build(target.getAsLink() as FabricValue),
    );
    await tx.commit().settled;
  };

  /** Reads the document under `cause` through `schema`, eagerly or lazily. */
  const read = async (
    cause: string,
    schema: JSONSchema,
    lazy: boolean,
    inspect: (value: unknown) => void,
  ): Promise<void> => {
    const tx = runtime.edit();
    if (lazy) tx.markLazyMaterialize(true);
    try {
      inspect(runtime.getCell(space, cause, schema, tx).get());
    } finally {
      await tx.commit().settled;
    }
  };

  for (const [mode, lazy] of READS) {
    describe(mode, () => {
      it("returns the value a path-only link inside an object element reaches", async () => {
        // `direct.owner` holds the same link outside any array. It resolves
        // the same way, so the two reads return the same value.

        await seed(`object-element-${mode}`, (shared) => ({
          items: [{ owner: sharedLink() }],
          shared,
          direct: { owner: sharedLink() },
        }));

        await read(
          `object-element-${mode}`,
          {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "object", properties: { owner: OWNER } },
              },
              direct: { type: "object", properties: { owner: OWNER } },
            },
          },
          lazy,
          (value) => {
            const { items, direct } = value as {
              items: Array<{ owner?: { first: string } }>;
              direct: { owner?: { first: string } };
            };
            expect(direct.owner?.first).toBe("Bob");
            expect(items[0].owner?.first).toBe("Bob");
          },
        );
      });

      it("returns the value a path-only link inside an array element reaches", async () => {
        await seed(`array-element-${mode}`, (shared) => ({
          rows: [[sharedLink()]],
          shared,
        }));

        await read(
          `array-element-${mode}`,
          {
            type: "object",
            properties: {
              rows: {
                type: "array",
                items: { type: "array", items: OWNER },
              },
            },
          },
          lazy,
          (value) => {
            const { rows } = value as { rows: Array<Array<{ first: string }>> };
            expect(rows[0][0].first).toBe("Bob");
          },
        );
      });

      it("returns a handle on the link's target for an `asCell` property of an element", async () => {
        await seed(`handle-in-element-${mode}`, (shared) => ({
          items: [{ owner: sharedLink() }],
          shared,
        }));

        await read(
          `handle-in-element-${mode}`,
          {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { owner: { ...OWNER, asCell: ["cell"] } },
                },
              },
            },
          },
          lazy,
          (value) => {
            const { items } = value as {
              items: Array<{ owner: { get(): { first: string } } }>;
            };
            expect(items[0].owner.get().first).toBe("Bob");
          },
        );
      });

      it("returns no `owner` for a path-only link whose path only the element holds", async () => {
        // The link names `shared` in the storing document, which holds
        // nothing there. The element's own `shared` is not what it names.

        await seed(`absent-target-${mode}`, () => ({
          items: [{ owner: sharedLink(), shared: { first: "Mallory" } }],
        }));

        await read(
          `absent-target-${mode}`,
          {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "object", properties: { owner: OWNER } },
              },
            },
          },
          lazy,
          (value) => {
            const { items } = value as {
              items: Array<{ owner?: { first?: string } }>;
            };
            expect(items[0].owner?.first).toBeUndefined();
          },
        );
      });
    });
  }

  describe("writing an element read through its array into another slot", () => {
    const ITEMS = {
      type: "array",
      items: { type: "object", properties: { owner: OWNER } },
    } as const satisfies JSONSchema;

    type Items = Array<{ owner: { first: string } }>;

    /**
     * Seeds two elements under `cause`, the first holding a path-only link,
     * and writes the first, as read through the array, into the second slot.
     */
    const copyFirstIntoSecond = async (cause: string) => {
      await seed(cause, (shared) => ({
        items: [{ owner: sharedLink() }, { owner: { first: "Alice" } }],
        shared,
      }));
      const tx = runtime.edit();
      const items = runtime.getCell(space, cause, undefined, tx)
        .key("items").asSchema(ITEMS);
      items.key(1).set((items.get() as Items)[0]);
      await tx.commit().settled;
      return items;
    };

    const ownersOf = async (
      items: Awaited<ReturnType<typeof copyFirstIntoSecond>>,
    ): Promise<string[]> => {
      const tx = runtime.edit();
      try {
        return (items.withTx(tx).get() as Items).map((item) =>
          item.owner.first
        );
      } finally {
        await tx.commit().settled;
      }
    };

    it("returns the link's target from the element and from its copy", async () => {
      // The copy stores the link in full, so the two elements differ as stored
      // and encode to one snapshot.

      const items = await copyFirstIntoSecond("copy-reads-target");

      expect(await ownersOf(items)).toEqual(["Bob", "Bob"]);
    });

    it("returns the link's target from the copy after the source slot is replaced", async () => {
      // A link to slot 0 would read whatever that slot holds next.

      const items = await copyFirstIntoSecond("copy-outlives-source");

      const tx = runtime.edit();
      items.withTx(tx).key(0).set({ owner: { first: "Carol" } });
      await tx.commit().settled;

      expect(await ownersOf(items)).toEqual(["Carol", "Bob"]);
    });
  });
});
