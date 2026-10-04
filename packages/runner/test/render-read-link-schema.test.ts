import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
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
   * A holder whose value is a link to a piece, the link built to carry
   * `storedSchema`, the narrow view unless another is given.
   */
  const holderOverBuiltLink = (
    storedSchema: JSONSchema = narrowSchema,
  ): Cell<unknown> => {
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
        schema: storedSchema,
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
        .get();

      expect(Object.keys(read as object)).toContain(UI);
      expect((read as Record<string, { name: string }>)[UI].name).toBe("div");
    });

    it("reads `[UI]` through a link `set()` stored under the writer's view", () => {
      const read = holderOverSetLink().asSchema(rendererVDOMSchema)
        .get();

      expect(Object.keys(read as object)).toContain(UI);
    });

    it("delivers `[UI]` to a renderer's sink", async () => {
      const holder = holderOverBuiltLink();
      await tx.commit();
      tx = runtime.edit();
      const delivered: unknown[] = [];

      const cancel = holder.withTx(undefined).asSchema(rendererVDOMSchema)
        .sink((value) => {
          delivered.push(value);
        }, { readOnly: true });
      cancel();

      expect(delivered).toHaveLength(1);
      expect(Object.keys(delivered[0] as object)).toContain(UI);
    });
  });

  describe("a render read at a slot whose link holds the read back", () => {
    // A stored `false` or `unknown` keeps its answer at a read's entry
    // whatever the reader declared, a renderer included.

    it("selects nothing through a stored `false`", () => {
      const read = holderOverBuiltLink(false).asSchema(rendererVDOMSchema)
        .get();

      expect(read).toBeUndefined();
    });

    it("holds a reference without `[UI]` through a stored `unknown`", () => {
      const read = holderOverBuiltLink({ type: "unknown" })
        .asSchema(rendererVDOMSchema).get();

      expect(isCellResult(read)).toBe(true);
      expect(Object.keys(read as object)).not.toContain(UI);
    });
  });
});
