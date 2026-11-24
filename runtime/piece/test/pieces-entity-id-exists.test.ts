import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { PiecesController } from "../src/ops/pieces-controller.ts";

/** The hash a piece reports its own id as, which carries no entity scheme. */
const HASH = "fid1:UxcP-io0AJMETFuGcRTKkR6KFYJvwnnHbMUvXS-9YQY";

/**
 * Stands a controller up over a space whose index holds `held`, and is the
 * controller beside the ids it was asked about.
 *
 * The provider answers by comparing the id it was handed against `held`, which
 * is how the index answers: an id is a key there, and a spelling that is not
 * that key is a key the index does not have.
 */
function indexHolding(held: readonly string[]): {
  pieces: PiecesController;
  asked: string[];
} {
  const asked: string[] = [];
  const runtime = {
    userIdentityDID: "did:key:home",
    getSpaceCell: () => ({ sync: () => Promise.resolve() }),
    storageManager: {
      open: () => ({
        entityIdExists: (id: string) => {
          asked.push(id);
          return Promise.resolve(held.includes(id));
        },
      }),
    },
  };
  const pieces = new PiecesController({
    as: {} as never,
    space: "did:key:test-space" as never,
  }, runtime as never);
  pieces.ready = Promise.resolve();
  return { pieces, asked };
}

describe("PiecesController.entityIdExists", () => {
  it("returns `true` for a piece addressed by the bare hash it reports", async () => {
    // The listing spelling and the index spelling are two, and this is the
    // pair: a piece reports its id as the bare tagged hash, and the index
    // holds the `of:` id over it. An address asked about as written reaches
    // no key here, and the space is reported as holding nothing.
    const { pieces, asked } = indexHolding([`of:${HASH}`]);

    expect(await pieces.entityIdExists(HASH)).toBe(true);
    expect(asked).toEqual([`of:${HASH}`]);
  });

  it("returns `true` for the same piece addressed by its `of:` id", async () => {
    const { pieces, asked } = indexHolding([`of:${HASH}`]);

    expect(await pieces.entityIdExists(`of:${HASH}`)).toBe(true);
    expect(asked).toEqual([`of:${HASH}`]);
  });

  it("returns `false` for a hash the index does not hold", async () => {
    const { pieces } = indexHolding([`of:${HASH}`]);

    expect(await pieces.entityIdExists("fid1:notInThisSpace")).toBe(false);
  });

  it("asks about a `computed:` id as it was given", async () => {
    // A kinded id names an entity of its own, so it is already the key the
    // index holds: scheming it again would ask about nothing.
    const computed = `computed:${HASH}`;
    const { pieces, asked } = indexHolding([computed]);

    expect(await pieces.entityIdExists(computed)).toBe(true);
    expect(asked).toEqual([computed]);
  });

  it("asks about a schema document's `cid:` id as it was given", async () => {
    // Not every id in a space is a piece's. `runtime/fuse` names an entity
    // directory after whatever id the space holds — a `cid:` schema document
    // among them — and reads that name back into this lookup, where an
    // `exists === false` tears the projection down. So an id in another
    // subject's scheme has to reach the index as itself: schemed again it
    // would name nothing, and the space would report a document it holds as
    // absent.
    const schemaDocument = `cid:${HASH}`;
    const { pieces, asked } = indexHolding([schemaDocument]);

    expect(await pieces.entityIdExists(schemaDocument)).toBe(true);
    expect(asked).toEqual([schemaDocument]);
  });

  it("returns `undefined` where the space provider offers no lookup", async () => {
    const runtime = {
      userIdentityDID: "did:key:home",
      getSpaceCell: () => ({ sync: () => Promise.resolve() }),
      storageManager: { open: () => ({}) },
    };
    const pieces = new PiecesController({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);
    pieces.ready = Promise.resolve();

    expect(await pieces.entityIdExists(HASH)).toBeUndefined();
  });

  it("waits until the controller is ready before opening the space", async () => {
    const ready = Promise.withResolvers<void>();
    const { pieces, asked } = indexHolding([`of:${HASH}`]);
    pieces.ready = ready.promise;

    const answer = pieces.entityIdExists(HASH);
    await Promise.resolve();
    expect(asked).toEqual([]);

    ready.resolve();
    expect(await answer).toBe(true);
    expect(asked).toEqual([`of:${HASH}`]);
  });
});
