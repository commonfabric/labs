import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { UI } from "../src/shared.ts";
import type { CellLinkRefPayload } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("render read link schema");
const space = signer.did();

/** A narrow view of a piece, which names two of its keys and not `[UI]`. */
const narrowSchema = {
  type: "object",
  properties: {
    about: { type: "string" },
    $VIEWS: { type: "object", properties: { room: { type: "object" } } },
  },
} as const satisfies JSONSchema;

const vnode = { type: "vnode", name: "div", props: {}, children: ["hi"] };

/** A piece's stored value: what the narrow view names, and its `[UI]`. */
const pieceValue = { about: "Room", $VIEWS: { room: {} }, [UI]: vnode };

describe("render-read-link-schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A holder whose value is a link to a piece, the link built to carry the
   * narrow view as its stored schema.
   */
  const holderOverBuiltLink = (): Cell<unknown> => {
    const piece = runtime.getCell(space, `piece-${seq}`, undefined, tx);
    piece.setRaw(pieceValue);
    const link = piece.getAsNormalizedFullLink();
    const holder = runtime.getCell(space, `holder-${seq}`, undefined, tx);
    holder.setRaw(
      linkRefFrom<CellLinkRefPayload>({
        id: link.id,
        space: link.space,
        scope: link.scope,
        path: [...link.path],
        schema: narrowSchema,
      }) as never,
    );
    return holder;
  };

  /**
   * A holder typed by the narrow view, into which the piece is `set()` as a
   * cell under that view, so the link it stores carries the writer's schema.
   */
  const holderOverSetLink = (): Cell<unknown> => {
    const piece = runtime.getCell(space, `piece-${seq}`, undefined, tx);
    piece.setRaw(pieceValue);
    const holder = runtime.getCell(space, `holder-${seq}`, narrowSchema, tx);
    holder.set(piece.asSchema(narrowSchema) as never);
    return holder as Cell<unknown>;
  };

  describe("a render read at a slot holding a narrowly typed link", () => {
    it("reads `[UI]` through a built link", () => {
      const read = holderOverBuiltLink().asSchema(rendererVDOMSchema)
        .get({ renderRead: true });

      expect(Object.keys(read as object)).toContain(UI);
      expect((read as Record<string, { name: string }>)[UI].name).toBe("div");
    });

    it("reads `[UI]` through a link `set()` stored under the writer's view", () => {
      const read = holderOverSetLink().asSchema(rendererVDOMSchema)
        .get({ renderRead: true });

      expect(Object.keys(read as object)).toContain(UI);
    });

    it("delivers `[UI]` to a render-read sink", async () => {
      const holder = holderOverBuiltLink();
      await tx.commit();
      tx = runtime.edit();
      const delivered: unknown[] = [];

      const cancel = holder.withTx(undefined).asSchema(rendererVDOMSchema)
        .sink((value) => {
          delivered.push(value);
        }, { readOnly: true, renderRead: true });
      cancel();

      expect(delivered).toHaveLength(1);
      expect(Object.keys(delivered[0] as object)).toContain(UI);
    });
  });

  describe("a read at the same slot that is not a render read", () => {
    // The contrast with the block above: the entry crossing adopts the stored
    // schema, so the read projects by the narrow view.

    it("reads the narrow view's keys and not `[UI]`", () => {
      const read = holderOverBuiltLink().asSchema(rendererVDOMSchema).get();

      expect(Object.keys(read as object)).toEqual(["about", "$VIEWS"]);
    });
  });
});
