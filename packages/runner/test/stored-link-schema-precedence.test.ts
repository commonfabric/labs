/**
 * What a link's own stored schema decides for a reader that declared one.
 *
 * A link stored in a document may carry a schema, and link resolution adopts
 * it in place of the schema the reader carries in: the stored one describes
 * the value at the link's target, where the reader's describes the value at
 * the source. A schema that constrains nothing — JSON Schema `true`, or an
 * empty object — describes neither, so the reader's schema keeps traveling.
 * What a read projects is decided by reader precedence, at a read addressed
 * at the element as at every hop of the array's own traversal: a shaped
 * reader's schema governs, so an element read by its own path projects the
 * same as that element read within its array, and an agnostic reader adopts
 * the stored schema. A stored `false`, a stored `unknown`, a reader typed
 * `unknown`, and the strict rollback keep the stored schema at the read's
 * entry. A link into another space carries its stored schema across
 * recomposed, and the entry resolves against it the same way.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import "@commonfabric/utils/equal-ignoring-symbols";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import {
  resetReaderSchemaPrecedenceConfig,
  setReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";
import { Runtime } from "../src/runtime.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { UI } from "../src/shared.ts";
import type { CellLinkRefPayload } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stored link schema precedence");
const space = signer.did();
const otherSpace =
  (await Identity.fromPassphrase("stored link schema precedence, other space"))
    .did();

type Row = { title: string };
type Holder = { rows: Row[] };

/** What a row declares: one required property, out of a wider stored value. */
const rowSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as const satisfies JSONSchema;

const holderSchema = {
  type: "object",
  properties: { rows: { type: "array", items: rowSchema } },
} as const satisfies JSONSchema;

/** A stored shape that selects a different property than the reader. */
const glazeSchema = {
  type: "object",
  properties: { glaze: { type: "string" } },
} as const satisfies JSONSchema;

/** The value a row link points at, wider than the row schema selects. */
const storedRow = { title: "cruller", glaze: "maple" };

describe("stored-link-schema-precedence", () => {
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
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A stored link to `cell` carrying `schema`. Built rather than minted:
   * `getAsLink({ includeSchema: true })` leaves out a schema that constrains
   * nothing, so it cannot produce one of these.
   */
  const linkCarrying = (cell: Cell<unknown>, schema: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      schema,
    });
  };

  /** A one-row array whose single element link carries `storedSchema`. */
  const holderOverLinkCarrying = (storedSchema: JSONSchema): Cell<Holder> => {
    const row = runtime.getCell(space, `row-${seq}`, undefined, tx);
    row.setRaw(storedRow);
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}`,
      holderSchema,
      tx,
    );
    holder.setRaw({ rows: [linkCarrying(row, storedSchema)] } as never);
    return holder;
  };

  const elementByPath = (holder: Cell<Holder>) =>
    holder.key("rows").key(0).get();

  const elementWithinArray = (holder: Cell<Holder>) =>
    holder.key("rows").get()[0];

  /**
   * A read's own enumerable properties. An unconstrained projection hands back
   * a live query-result proxy, which a structural diff renders as `{}`; the
   * spread makes what a read exposes both comparable and printable whichever
   * form it took.
   */
  const projectionOf = (value: unknown) => ({ ...(value as object) });

  describe("a stored schema that constrains nothing", () => {
    it("projects an element by path the same way as within its array", () => {
      const holder = holderOverLinkCarrying(true);

      expect(projectionOf(elementByPath(holder)))
        .toEqual(projectionOf(elementWithinArray(holder)));
    });

    it("projects an element by path through the reader's row schema", () => {
      const holder = holderOverLinkCarrying(true);

      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
    });

    it("projects an empty stored schema the same way as `true`", () => {
      const holder = holderOverLinkCarrying({});

      expect(projectionOf(elementByPath(holder)))
        .toEqual(projectionOf(elementWithinArray(holder)));
      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
    });

    it("resolves the element link to the schema the reader carried in", () => {
      const holder = holderOverLinkCarrying(true);
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: rowSchema as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(rowSchema);
    });

    it("resolves through a stored schema that is only a `cell` stamp to the reader's schema", () => {
      const holder = holderOverLinkCarrying({ asCell: ["cell"] });
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: rowSchema as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(rowSchema);
    });
  });

  describe("a stored schema that only declares a stream", () => {
    const streamStamp = { asCell: ["stream"] } as const satisfies JSONSchema;

    it("governs in place of a reader's schema that does not declare the stream", () => {
      const holder = holderOverLinkCarrying(streamStamp);
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: rowSchema as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(streamStamp);
    });

    it("keeps a reader's schema that declares the stream and types its event", () => {
      const holder = holderOverLinkCarrying(streamStamp);
      const typedStream = {
        ...rowSchema,
        asCell: ["stream"],
      } as const satisfies JSONSchema;
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: typedStream as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(typedStream);
    });
  });

  describe("a stored schema that constrains", () => {
    it("projects an element by path through the reader's row schema", () => {
      const holder = holderOverLinkCarrying(glazeSchema);

      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
    });

    it("projects an element by path the same way as within its array", () => {
      // The same link, the same declared row type, one projection: the read
      // addressed at the element and the array's traversal both cross the
      // link under the reader's item schema (`combineSchemaForLink`).
      const holder = holderOverLinkCarrying(glazeSchema);

      expect(projectionOf(elementByPath(holder)))
        .toEqual(projectionOf(elementWithinArray(holder)));
      expect(projectionOf(elementWithinArray(holder))).toEqual({
        title: "cruller",
      });
    });

    it("selects nothing for a `false` reader by path", () => {
      const holder = holderOverLinkCarrying(glazeSchema);

      expect(holder.key("rows").key(0).asSchema(false).get()).toBeUndefined();
    });

    it("selects nothing when the stored schema is `false`", () => {
      const holder = holderOverLinkCarrying(false);

      expect(elementByPath(holder)).toBeUndefined();
    });

    it("projects an element by path through the stored schema under the strict rollback", () => {
      // With `readerSchemaPrecedence` off, a read addressed at the element
      // follows link resolution's rule: the stored schema replaces the
      // reader's.
      const holder = holderOverLinkCarrying(glazeSchema);

      setReaderSchemaPrecedenceConfig(false);
      try {
        expect(projectionOf(elementByPath(holder))).toEqual({
          glaze: "maple",
        });
      } finally {
        resetReaderSchemaPrecedenceConfig();
      }
    });

    it("types an agnostic reader by the nearest stored schema along a chain", () => {
      // The slot is reached through one link and holds another. A reader that
      // declares no shape adopts the second link's schema, which describes
      // the value the read lands on, not the first link's description of the
      // slot.
      const slotSchema = {
        type: "object",
        properties: { slot: rowSchema },
      } as const satisfies JSONSchema;
      const row = runtime.getCell(space, `row-${seq}-chain`, undefined, tx);
      row.setRaw(storedRow);
      const middle = runtime.getCell(space, `middle-${seq}`, undefined, tx);
      middle.setRaw({ slot: linkCarrying(row, glazeSchema) } as never);
      const outer = runtime.getCell(space, `outer-${seq}`, undefined, tx);
      outer.setRaw({ middle: linkCarrying(middle, slotSchema) } as never);

      expect(projectionOf(outer.key("middle").key("slot").get())).toEqual({
        glaze: "maple",
      });
    });
  });

  describe("a stored schema narrower than a renderer's", () => {
    it("reads a piece's `$UI` through a link holding a view that leaves it out", () => {
      // A link written from a cell typed by a narrow view of a piece carries
      // that view. A renderer reads the slot by its own schema, which selects
      // the piece's UI, and the view has no say in it.
      const narrowSchema = {
        type: "object",
        properties: { about: { type: "string" } },
      } as const satisfies JSONSchema;
      const vnode = { type: "vnode", name: "div", props: {}, children: [] };
      const piece = runtime.getCell(space, `piece-${seq}`, undefined, tx);
      piece.setRaw({ about: "Room", [UI]: vnode });
      const holder = runtime.getCell(
        space,
        `holder-${seq}-ui`,
        narrowSchema,
        tx,
      );
      holder.set(piece.asSchema(narrowSchema) as never);

      const rendered = holder.asSchema(rendererVDOMSchema).get() as Record<
        string,
        unknown
      >;
      expect(rendered[UI]).toMatchObject({ type: "vnode", name: "div" });
    });
  });

  describe("an `unknown` at the read's entry", () => {
    const unknownSchema = { type: "unknown" } as const satisfies JSONSchema;

    it("adopts the stored schema for a reader typed `unknown`", () => {
      // The handle a caller keys into is typed `unknown`; the stored schema
      // is what describes the value the handle reaches.
      const holder = holderOverLinkCarrying(glazeSchema);
      const element = holder.key("rows").key(0).asSchema(unknownSchema).get();

      expect(projectionOf(element)).toEqual({ glaze: "maple" });
    });

    it("keeps a shaped reader's read by path a reference under a stored `unknown`", () => {
      // A stored `unknown` is built here, not minted: `set()` carries the
      // target's own schema, never the writer's. Read by path, the stored
      // declaration governs and the read holds the reference, a live
      // query-result proxy exposing nothing; read within the array, the
      // reader's item schema governs the same link and reads through.
      const holder = holderOverLinkCarrying(unknownSchema);

      const byPath = elementByPath(holder);
      expect(isCellResult(byPath)).toBe(true);
      expect(projectionOf(byPath)).toEqual({});
      expect(projectionOf(elementWithinArray(holder))).toEqual({
        title: "cruller",
      });
    });
  });

  describe("a link into another space", () => {
    // A minted link carries its stored schema as a `cid:` reference whose
    // documents live in the space holding the link. Resolution hands it back
    // recomposed into a self-contained form at the crossing, so the target
    // space need not hold the documents
    // (docs/specs/content-addressed-schemas.md, "Space boundaries"); read by
    // path or within the array, the reader's row schema governs the
    // projection, as it does in one space.

    it("projects an element by path through the reader's row schema, the stored one recomposed", async () => {
      const row = runtime.getCell(
        otherSpace,
        `row-${seq}-other`,
        glazeSchema,
        tx,
      );
      row.setRaw(storedRow);
      // One transaction writes one space: the row lands before the holder.
      await tx.commit();
      tx = runtime.edit();
      const holder = runtime.getCell<Holder>(
        space,
        `holder-${seq}-other`,
        holderSchema,
        tx,
      );
      holder.set({ rows: [row] } as never);
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: rowSchema as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(glazeSchema);
      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
      expect(projectionOf(elementWithinArray(holder))).toEqual({
        title: "cruller",
      });
    });
  });

  describe("a stored schema that describes more than the reader selects", () => {
    // Read within the array, the reader's item schema takes precedence over
    // the stored one (`combineSchemaForLink`): a property the reader did not
    // select stays out of the read, and the stored schema's `required` for
    // that property cannot void the row.

    const wideStoredSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        glaze: { type: "string" },
      },
      required: ["title", "glaze"],
    } as const satisfies JSONSchema;

    it("excludes a stored-schema property the reader did not select", () => {
      const holder = holderOverLinkCarrying(wideStoredSchema);

      expect(projectionOf(elementWithinArray(holder))).toEqual({
        title: "cruller",
      });
    });

    it("reads a row missing a field only the stored schema requires", () => {
      const row = runtime.getCell(space, `row-${seq}-narrow`, undefined, tx);
      row.setRaw({ title: "cruller" });
      const holder = runtime.getCell<Holder>(
        space,
        `holder-${seq}-narrow`,
        holderSchema,
        tx,
      );
      holder.setRaw({ rows: [linkCarrying(row, wideStoredSchema)] } as never);

      expect(projectionOf(elementWithinArray(holder))).toEqual({
        title: "cruller",
      });
    });

    it("hands an asCell reader a handle that reads a row missing a stored-required field", () => {
      // An asCell reader crossing the link gets a handle whose schema keeps
      // reader precedence: the stored schema's extra requirement must not
      // ride the handle and void a read of a target that satisfies
      // everything the reader itself demanded.

      const row = runtime.getCell(space, `row-${seq}-handle`, undefined, tx);
      row.setRaw({ title: "cruller" });
      const holder = runtime.getCell<Holder>(
        space,
        `holder-${seq}-handle`,
        holderSchema,
        tx,
      );
      holder.setRaw({ rows: [linkCarrying(row, wideStoredSchema)] } as never);

      const handle = holder.key("rows").key(0)
        .asSchema(
          {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            asCell: ["cell"],
          } as const satisfies JSONSchema,
        )
        .get() as unknown as Cell<Row>;
      expect(projectionOf(handle.get())).toEqual({ title: "cruller" });
    });

    describe("a stored schema that is nothing but a default", () => {
      // A stored schema can be NOTHING BUT a default — a top-level `default` is
      // otherwise a true schema, and narrowing can reduce a stored schema to
      // one. The resolution carry must not treat that as saying nothing: the
      // default is the nearest declaration and stands in for the absent value.

      it("inherits a default-only stored schema's default across the crossing", () => {
        const target = runtime.getCell(space, `row-${seq}-seed`, undefined, tx);
        // Deliberately never written: the stored default is all a read has.
        const holder = runtime.getCell<Holder>(
          space,
          `holder-${seq}-seed`,
          holderSchema,
          tx,
        );
        holder.setRaw(
          {
            rows: [linkCarrying(target, { default: { title: "seeded" } })],
          } as never,
        );

        expect(projectionOf(elementByPath(holder))).toEqual({
          title: "seeded",
        });
      });

      it("carries a trivial stored default onto a boolean-true reader at resolution", () => {
        const target = runtime.getCell(
          space,
          `row-${seq}-truecarry`,
          undefined,
          tx,
        );
        const holder = runtime.getCell<Holder>(
          space,
          `holder-${seq}-truecarry`,
          holderSchema,
          tx,
        );
        holder.setRaw(
          {
            rows: [linkCarrying(target, { default: { title: "seeded" } })],
          } as never,
        );
        const readerLink = {
          ...holder.getAsNormalizedFullLink(),
          path: ["rows", "0"],
          schema: true as JSONSchema,
        };

        expect(resolveLink(runtime, tx, readerLink).schema).toEqual({
          default: { title: "seeded" },
        });
      });

      it("keeps a false reader false across a defaulted trivial stored schema", () => {
        const target = runtime.getCell(
          space,
          `row-${seq}-falsecarry`,
          undefined,
          tx,
        );
        const holder = runtime.getCell<Holder>(
          space,
          `holder-${seq}-falsecarry`,
          holderSchema,
          tx,
        );
        holder.setRaw(
          {
            rows: [linkCarrying(target, { default: { title: "seeded" } })],
          } as never,
        );
        const readerLink = {
          ...holder.getAsNormalizedFullLink(),
          path: ["rows", "0"],
          schema: false as JSONSchema,
        };

        // The reader selected nothing; no default stands in.
        expect(resolveLink(runtime, tx, readerLink).schema).toBe(false);
      });

      it("inherits a default the narrowing reduced the stored schema to", () => {
        const storedSchema = {
          type: "object",
          properties: { glaze: { default: "seed" } },
        } as const satisfies JSONSchema;
        const row = runtime.getCell(
          space,
          `row-${seq}-narrow-seed`,
          undefined,
          tx,
        );
        row.setRaw({ title: "cruller" });
        const holder = runtime.getCell<Holder>(
          space,
          `holder-${seq}-narrow-seed`,
          holderSchema,
          tx,
        );
        holder.setRaw({ rows: [linkCarrying(row, storedSchema)] } as never);

        const glaze = holder.key("rows").key(0)
          .asSchema(
            {
              type: "object",
              properties: { glaze: { type: "string" } },
            } as const satisfies JSONSchema,
          )
          .key("glaze").get();
        expect(glaze).toEqual("seed");
      });
    });

    it("inherits the stored schema's default for an absent selected field", () => {
      // `default` crosses the precedence line: narrowed to the read path, the
      // stored schema's default is inherited onto the reader's schema and
      // stands in for the absent value.

      const defaultedStoredSchema = {
        type: "object",
        properties: {
          title: { type: "string" },
          glaze: { type: "string", default: "maple" },
        },
      } as const satisfies JSONSchema;
      const row = runtime.getCell(space, `row-${seq}-default`, undefined, tx);
      row.setRaw({ title: "cruller" });
      const holder = runtime.getCell<Holder>(
        space,
        `holder-${seq}-default`,
        holderSchema,
        tx,
      );
      holder.setRaw(
        { rows: [linkCarrying(row, defaultedStoredSchema)] } as never,
      );

      const glaze = holder.key("rows").key(0)
        .asSchema(
          {
            type: "object",
            properties: { glaze: { type: "string" } },
          } as const satisfies JSONSchema,
        )
        .key("glaze").get();
      expect(glaze).toEqual("maple");
    });
  });
});
