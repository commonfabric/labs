import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { describe, it } from "@commonfabric/test-support/test";

import {
  type DocumentReader,
  modelFromDocument,
  streamDeclarationOf,
} from "../model.ts";
import type { EntityDocument } from "../reconstruct.ts";

const link = (id: string, schema?: FabricValue) => ({
  "/": {
    "link@1": { id, path: [], ...(schema === undefined ? {} : { schema }) },
  },
});

const shapeOf = (value: FabricValue) =>
  modelFromDocument({ value }, { id: "of:x" }).valueShape;

describe("model", () => {
  describe("modelFromDocument()", () => {
    it("returns the `schema` shape only for a typed value with properties or $defs", () => {
      expect(shapeOf({ type: "object", properties: {} })).toBe("schema");
      expect(shapeOf({ type: "object", $defs: {} })).toBe("schema");
      expect(shapeOf({ type: "object" })).toBe("object");
      expect(shapeOf({ type: "object", properties: [] })).toBe("object");
      expect(shapeOf({ type: 1, properties: {} })).toBe("object");
    });

    it("returns the `array` and `scalar` shapes for those values", () => {
      expect(shapeOf([1])).toBe("array");
      expect(shapeOf("text")).toBe("scalar");
    });

    it("returns a pattern lineage without a symbol when none is stored", () => {
      const model = modelFromDocument(
        { value: {}, patternIdentity: { identity: "hash" } },
        { id: "of:x" },
      );
      expect(model.lineage.pattern).toEqual({
        identity: "hash",
        symbol: undefined,
      });
    });

    it("returns the `piece-result` shape for a value carrying a render marker", () => {
      expect(shapeOf({ $NAME: "Notes" })).toBe("piece-result");
      expect(shapeOf({ $TILE_UI: {} })).toBe("piece-result");
      expect(shapeOf({ type: "object", properties: {}, $UI: {} })).toBe(
        "piece-result",
      );
    });

    it("skips a manifest entry that is not a record when looking for a stream declaration", () => {
      const owner: EntityDocument = {
        value: { $NAME: "Owner" },
        internal: [
          "not an entry",
          { link: link("of:x", { asCell: ["stream"], type: "object" }) },
        ],
      };
      const readDocument: DocumentReader = (id) =>
        id === "of:owner" ? owner : undefined;
      const model = modelFromDocument(
        { result: link("of:owner") },
        { id: "of:x", readDocument },
      );
      expect(model.kind).toBe("stream");

      const undeclared = modelFromDocument(
        { result: link("of:owner") },
        {
          id: "of:x",
          readDocument: () => ({ internal: ["not an entry"] }),
        },
      );
      expect(undeclared.kind).toBe("owned-cell");
    });
  });

  describe("streamDeclarationOf()", () => {
    const STREAM = { asCell: ["stream"], type: "object" };
    const readerOver =
      (docs: Record<string, EntityDocument>): DocumentReader => (id) =>
        docs[id];
    const declare = (...links: FabricValue[]) =>
      readerOver({
        "of:owner": { value: {}, internal: links.map((link) => ({ link })) },
        "cid:held": { value: STREAM },
      });
    const stream: EntityDocument = { result: link("of:owner") };

    it("reads an inline declaration from the owner's manifest", () => {
      expect(
        streamDeclarationOf("of:s", stream, declare(link("of:s", STREAM))),
      ).toEqual({
        schema: STREAM,
        root: STREAM,
        via: "own",
        owner: "of:owner",
      });
    });

    it("follows an external reference into the schema document", () => {
      expect(
        streamDeclarationOf(
          "of:s",
          stream,
          declare(link("of:s", { $ref: "cid:held" })),
        ),
      ).toEqual({
        schema: STREAM,
        root: STREAM,
        via: "document",
        ref: "cid:held",
        owner: "of:owner",
      });
    });

    it("skips an entry whose reference does not resolve and reads the next", () => {
      const reader = declare(
        link("of:s", { $ref: "cid:missing" }),
        link("of:s", STREAM),
      );
      expect(streamDeclarationOf("of:s", stream, reader)?.via).toBe("own");
      expect(
        streamDeclarationOf(
          "of:s",
          stream,
          declare(link("of:s", { $ref: "cid:missing" })),
        ),
      ).toBeUndefined();
    });

    it("declares nothing for a schema that is not a stream, or another id", () => {
      const cell = { asCell: ["cell"], type: "object" };
      expect(
        streamDeclarationOf("of:s", stream, declare(link("of:s", cell))),
      ).toBeUndefined();
      expect(
        streamDeclarationOf("of:s", stream, declare(link("of:other", STREAM))),
      ).toBeUndefined();
    });
  });
});
