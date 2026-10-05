import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  dataUriFromValueWithResolvedLinks,
  findAndInlineDataUriLinks,
} from "../src/data-uri.ts";
import { Runtime } from "../src/runtime.ts";
import { externalRefTo } from "./schema-ref-helpers.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data URI inlining", () => {
  // These pins were written against the flag-on writer (reference-form
  // link schemas); the flag's build default is off, so they opt in.
  beforeEach(() => {
    setContentAddressedSchemasConfig(true);
  });
  afterEach(() => {
    resetContentAddressedSchemasConfig();
  });

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

  describe("findAndInlineDataUriLinks", () => {
    it("returns a link-free array holding NaN by reference", () => {
      // The copy-on-write gate must treat an untouched `NaN` leaf as
      // unchanged (`Object.is` semantics), not clone the container.
      const value = [NaN, 1];
      expect(findAndInlineDataUriLinks(value)).toBe(value);
    });

    it("returns a link-free record holding NaN by reference", () => {
      const value = { x: NaN };
      expect(findAndInlineDataUriLinks(value)).toBe(value);
    });

    it("should inline simple data URI links", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("test data");
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toBe("test data");
    });

    it("should inline data URI links with paths", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({
        nested: { value: 42 },
      });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested", "value"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toBe(42);
    });

    it("should inline data URI links in arrays", () => {
      const dataURI1 = dataUriFromValueWithResolvedLinks("first");
      const dataURI2 = dataUriFromValueWithResolvedLinks("second");

      const array = [
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI1,
              path: [],
            },
          },
        },
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI2,
              path: [],
            },
          },
        },
      ];

      const result = findAndInlineDataUriLinks(array);
      expect(result).toEqual(["first", "second"]);
    });

    it("should inline data URI links in objects", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("nested value");
      const obj = {
        key1: "regular value",
        key2: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI,
              path: [],
            },
          },
        },
      };

      const result = findAndInlineDataUriLinks(obj);
      expect(result).toEqual({
        key1: "regular value",
        key2: "nested value",
      });
    });

    it("should handle data URIs containing links", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ value: "inner data" });

      const dataURI = dataUriFromValueWithResolvedLinks(innerCell.getAsLink());
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            id: innerCell.getAsNormalizedFullLink().id,
            path: [],
          },
        },
      });
    });

    it("should handle data URIs with links and paths", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ nested: { value: "inner data" } });

      const dataURI = dataUriFromValueWithResolvedLinks(innerCell.getAsLink());
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested"],
          },
        },
      });
    });

    it("should return undefined for data URIs with invalid paths", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({ a: 1 });
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nonexistent"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toBeUndefined();
    });

    it("should preserve non-data URI links", () => {
      const normalCell = runtime.getCell(space, "normal", undefined, tx);
      const link = normalCell.getAsLink();

      const result = findAndInlineDataUriLinks(link);
      expect(result).toBe(link);
    });

    it("should preserve links whose data: URI carries a foreign media type", () => {
      // Only this codec's media type names content that can be inlined. A
      // `data:` URI of any other media type is left alone, exactly as a link
      // naming a document in a space is.
      for (
        const id of [
          "data:image/png;base64,iVBORw0KGgo",
          "data:text/plain,hello",
          "data:,",
        ]
      ) {
        const link = {
          "/": {
            [LINK_V1_TAG]: {
              id,
              path: [],
            },
          },
        };

        expect(findAndInlineDataUriLinks(link)).toBe(link);
      }
    });

    it("should preserve object identity when no data URI links are present", () => {
      const value = {
        name: "Ada",
        nested: {
          count: 3,
          tags: ["math", "logic"],
        },
      };

      const result = findAndInlineDataUriLinks(value);
      expect(result).toBe(value);
      expect(result.nested).toBe(value.nested);
      expect(result.nested.tags).toBe(value.nested.tags);
    });

    it("should preserve unchanged branches when inlining nested data URI links", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("inline me");
      const untouched = {
        keep: true,
        nested: { count: 1 },
      };
      const value = {
        untouched,
        change: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI,
              path: [],
            },
          },
        },
      };

      const result = findAndInlineDataUriLinks(value);
      expect(result).not.toBe(value);
      expect(result.untouched).toBe(untouched);
      expect(result.change).toBe("inline me");
    });

    it("should handle primitives", () => {
      expect(findAndInlineDataUriLinks("string")).toBe("string");
      expect(findAndInlineDataUriLinks(42)).toBe(42);
      expect(findAndInlineDataUriLinks(true)).toBe(true);
      expect(findAndInlineDataUriLinks(null)).toBe(null);
    });

    it("should deeply traverse nested structures", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("deep value");
      const complex = {
        level1: {
          level2: [
            {
              level3: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: dataURI,
                    path: [],
                  },
                },
              },
            },
          ],
        },
      };

      const result = findAndInlineDataUriLinks(complex);
      expect(result.level1.level2[0].level3).toBe("deep value");
    });

    it("should handle data URIs with schema", () => {
      const dataURI = dataUriFromValueWithResolvedLinks(42);
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
            schema: { type: "number" },
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toBe(42);
    });

    it("should preserve schema when following links in data URIs", () => {
      const innerCell = runtime.getCell(space, "inner", undefined, tx);
      innerCell.set({ nested: { value: "data" } });

      const dataURI = dataUriFromValueWithResolvedLinks(innerCell.getAsLink({
        includeSchema: true,
      }));
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
            schema: { type: "object" },
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested"],
          },
        },
      });
    });

    describe("special objects", () => {
      // A `FabricSpecialObject` is `isObjectOrArray`, so it reaches the record branch
      // rather than the leaf return. What keeps it whole is that the branch
      // only clones when an entry inlines to something new, and a special
      // object has zero enumerable own properties: the loop body never runs,
      // so `next` stays undefined and the original comes back by identity.
      //
      // For a `FabricPrimitive` that is the answer: a leaf holds no link to
      // inline, and the guarantee -- indirect, resting on the zero-property
      // fact -- is pinned so that giving one an enumerable property turns this
      // red.
      //
      // For a `FabricInstance` it is _not_ the answer -- not being flattened is
      // not the same as being handled -- so the walk refuses one.

      it("returns a `FabricBytes` as the same instance", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

        expect(findAndInlineDataUriLinks(bytes)).toBe(bytes);
      });

      it("throws for a `FabricError` rather than passing it through", () => {
        // Passing an instance through hands it back _untransformed_: its state
        // can carry a link this walk exists to inline, so coming back whole
        // means coming back with that link intact.
        //
        // Latent, and refused anyway. A link ends up inside an error only if an
        // author attaches a cell to one, and nothing in the tree does -- so
        // this test builds the producer it does not have. The refusal is the
        // point: it announces itself the moment these classes see real use,
        // where a comment would wait to be read.
        //
        // The control shows the same link inlining on a plain object, so what
        // changes the outcome is visibly the wrapper.
        const dataURI = dataUriFromValueWithResolvedLinks("inlined value");
        const link = { "/": { [LINK_V1_TAG]: { id: dataURI, path: [] } } };
        const failure = new FabricError({
          type: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { attachment: link as unknown as FabricValue },
        });

        expect(findAndInlineDataUriLinks({ e: link })).toEqual({
          e: "inlined value",
        });

        expect(() => findAndInlineDataUriLinks(failure)).toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
            "inlining `data:` URI links.",
        );
      });

      it("throws for a `FabricError` decoded from a root `data:` URI", () => {
        // The bypass this closes: an instance handed over directly is refused,
        // and before this the same one decoded out of a `data:` URI left
        // silently, because a decoded payload is returned rather than walked.
        // A guard with a way around it is worse than none, since it reads as
        // covering the case.
        const failure = new FabricError({
          type: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { attachment: "held" as unknown as FabricValue },
        });
        const uri = dataUriFromValueWithResolvedLinks(
          failure as unknown as FabricValue,
        );
        const link = { "/": { [LINK_V1_TAG]: { id: uri, path: [] } } };

        expect(() => findAndInlineDataUriLinks(link)).toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
            "inlining a `data:` URI whose content is a `FabricInstance`.",
        );
      });

      it("keeps a special object whole while inlining a sibling", () => {
        // The discriminating case. A sibling that does inline forces the
        // record branch to clone, and the clone is a `{ ...value }` spread --
        // so this is where a special object would be flattened if the walk
        // ever descended into one rather than copying the reference across.
        const bytes = new FabricBytes(new Uint8Array([4, 5]));
        const dataURI = dataUriFromValueWithResolvedLinks("inlined value");

        const result = findAndInlineDataUriLinks({
          bytes,
          link: { "/": { [LINK_V1_TAG]: { id: dataURI, path: [] } } },
        });

        expect(result.bytes).toBe(bytes);
        expect(result.link).toBe("inlined value");
      });
    });
  });

  describe("setRaw with data URI inlining", () => {
    it("should inline data URIs when using setRaw", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("inlined value");
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.setRaw({ data: link });
      expect(targetCell.get()).toEqual({ data: "inlined value" });
    });

    it("should inline nested data URIs in objects", () => {
      const dataURI1 = dataUriFromValueWithResolvedLinks("value1");
      const dataURI2 = dataUriFromValueWithResolvedLinks("value2");
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      targetCell.setRaw({
        field1: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI1,
              path: [],
            },
          },
        },
        field2: {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI2,
              path: [],
            },
          },
        },
      });

      expect(targetCell.get()).toEqual({
        field1: "value1",
        field2: "value2",
      });
    });

    it("should inline data URIs in arrays", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("array item");
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      targetCell.setRaw([
        "regular",
        {
          "/": {
            [LINK_V1_TAG]: {
              id: dataURI,
              path: [],
            },
          },
        },
      ]);

      expect(targetCell.get()).toEqual(["regular", "array item"]);
    });
  });

  describe("diffAndUpdate with data URI inlining", () => {
    it("should inline data URIs during diffAndUpdate", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("updated value");
      const targetCell = runtime.getCell(space, "target", undefined, tx);
      targetCell.set({ initial: "value" });

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.set({ data: link });
      expect(targetCell.get()).toEqual({ data: "updated value" });
    });

    it("should handle data URIs with complex nested structures", () => {
      const dataURI = dataUriFromValueWithResolvedLinks({
        nested: {
          array: [1, 2, 3],
          obj: { key: "value" },
        },
      });
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested"],
          },
        },
      };

      targetCell.set({ result: link });
      expect(targetCell.get()).toEqual({
        result: {
          array: [1, 2, 3],
          obj: { key: "value" },
        },
      });
    });

    it("should not write data URIs to storage", () => {
      const dataURI = dataUriFromValueWithResolvedLinks("test");
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: [],
          },
        },
      };

      targetCell.set(link);

      // Read the raw value from storage
      const rawValue = targetCell.getRaw();

      // The raw value should be the inlined value, not the data URI link
      expect(rawValue).toBe("test");
    });

    it("should surface the storage error for a foreign-media-type data URI", () => {
      // Such a link is not inlined, so the write treats it as an ordinary
      // link and reads through it to diff against what it names. That read
      // reports the media type, as the storage layer's typed error. Landing
      // on that error is also what pins the inlining re-entry as unreached;
      // the re-entry recurs on a value the inlining call leaves alone.
      const targetCell = runtime.getCell(space, "target", undefined, tx);

      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: "data:image/png;base64,iVBORw0KGgo",
            path: [],
          },
        },
      };

      let error: { name?: string } | undefined;
      try {
        targetCell.set(link);
      } catch (caught) {
        error = caught as { name?: string };
      }
      expect(error?.name).toBe("UnsupportedMediaTypeError");
    });
  });

  describe("corner cases", () => {
    it("should handle relative links within data URIs", () => {
      // Create a data URI containing both a relative link and the data it
      // points to
      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["other", "path"],
          },
        },
      };
      const dataURI = dataUriFromValueWithResolvedLinks({
        link: relativeLink,
        other: { path: "success" },
      });

      // Create a link to the data URI
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["link"],
          },
        },
      };

      // The relative link should be fully resolved to the actual value
      const result = findAndInlineDataUriLinks(link);

      // Should return the final resolved value "success"
      expect(result).toBe("success");
    });

    it("should resolve schema correctly when path extends beyond data URI content into linked document", () => {
      // Create a cell with nested structure and schema
      const linkedCell = runtime.getCell(space, "linked", undefined, tx);
      linkedCell.set({
        level1: {
          level2: {
            level3: "deep value",
          },
        },
      });

      // Create a link to linkedCell with a schema
      const linkToOtherDoc = {
        "/": {
          [LINK_V1_TAG]: {
            id: entityRefToString(linkedCell.entityId),
            path: [],
            schema: {
              type: "object",
              properties: {
                level1: {
                  type: "object",
                  properties: {
                    level2: {
                      type: "object",
                      properties: {
                        level3: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      // Embed the link in a data URI at some intermediate level
      const dataURI = dataUriFromValueWithResolvedLinks({
        intermediate: linkToOtherDoc,
      });

      // Now create a link that goes through data URI, then through intermediate,
      // and then further into the linked document beyond what data URI describes
      const complexLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["intermediate", "level1", "level2"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(complexLink);

      // Result should be a link pointing into the linked document
      // with the path extended beyond the data URI's structure
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["level1", "level2"],
            // Schema should be resolved for the nested path (and re-emitted
            // as a reference to the narrowed document)
            schema: externalRefTo({
              type: "object",
              properties: {
                level3: { type: "string" },
              },
            }),
          },
        },
      });
    });

    it("should handle data URI with relative link and additional path", () => {
      const baseCell = runtime.getCell(space, "base", undefined, tx);
      baseCell.set({
        target: {
          nested: {
            value: 123,
          },
        },
      });

      // Relative link within data URI
      const relativeLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: baseCell.getAsNormalizedFullLink().id,
            path: ["target"],
          },
        },
      };
      const dataURI = dataUriFromValueWithResolvedLinks(relativeLink);

      // Link with additional path that goes beyond the relative link
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["nested", "value"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);

      // Should combine the paths: relative link's path + additional path
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            id: baseCell.getAsNormalizedFullLink().id,
            path: ["target", "nested", "value"],
          },
        },
      });

      // Verify that the id is NOT a data: URI
      const resultLink = result as any;
      if (resultLink["/"] && resultLink["/"][LINK_V1_TAG]?.id) {
        expect(resultLink["/"][LINK_V1_TAG].id).not.toMatch(/^data:/);
      }
    });

    it("should handle deeply nested data URIs with multiple link layers", () => {
      // Create a target cell
      const targetCell = runtime.getCell(space, "target", undefined, tx);
      targetCell.set({ final: "value" });

      // Create a link to target
      const linkToTarget = targetCell.getAsLink();

      // Wrap it in a data URI
      const dataURI1 = dataUriFromValueWithResolvedLinks({
        wrapped: linkToTarget,
      });

      // Create a link to first data URI
      const linkToDataURI1 = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI1,
            path: ["wrapped"],
          },
        },
      };

      // Wrap that in another data URI
      const dataURI2 = dataUriFromValueWithResolvedLinks({
        doubleWrapped: linkToDataURI1,
      });

      // Create final link
      const finalLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI2,
            path: ["doubleWrapped", "final"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(finalLink);

      // Should eventually resolve to a link to the target cell
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["final"],
          },
        },
      });
    });

    it("should handle data URI with link that has empty path but additional traversal", () => {
      const docCell = runtime.getCell(space, "doc", undefined, tx);
      docCell.set({
        field: {
          subfield: "value",
        },
      });

      // Link to document root with schema
      const linkWithSchema = {
        "/": {
          [LINK_V1_TAG]: {
            id: entityRefToString(docCell.entityId),
            path: [],
            schema: {
              type: "object",
              properties: {
                field: {
                  type: "object",
                  properties: {
                    subfield: { type: "string" },
                  },
                },
              },
            },
          },
        },
      };

      const dataURI = dataUriFromValueWithResolvedLinks(linkWithSchema);

      // Path extends into the linked document
      const link = {
        "/": {
          [LINK_V1_TAG]: {
            id: dataURI,
            path: ["field", "subfield"],
          },
        },
      };

      const result = findAndInlineDataUriLinks(link);

      // Should return a link with the extended path and resolved schema
      expect(result).toMatchObject({
        "/": {
          [LINK_V1_TAG]: {
            path: ["field", "subfield"],
            schema: externalRefTo({ type: "string" }),
          },
        },
      });
    });
  });
});
