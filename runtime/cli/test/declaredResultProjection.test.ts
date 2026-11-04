import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/runner";
import { declaredResultProjection } from "../lib/cell-selection.ts";

/**
 * The declared result of a verb that hands an item back, with `Item` naming
 * itself through `parent`. That recursion is the only thing a derived bound
 * cuts, so every case here hangs its own position beside `item` and reads how
 * the derivation treats that position while the walk is already cutting
 * somewhere else. A declaration that re-enters nowhere derives no projection
 * at all, which would leave nothing to read.
 *
 * The declaration shapes below are the ones a compiled pattern cannot be made
 * to produce — a reference out of the document, a reference to a name that is
 * not there, a position with no shape under it — which is why they are driven
 * through the derivation directly rather than through a live verb. The
 * recursion they hang off is the same one the transformer lowers, spelled the
 * same way: a local `$ref` into `$defs`.
 */
function declarationBeside(
  beside: Readonly<Record<string, JSONSchema>>,
): JSONSchema {
  return {
    type: "object",
    properties: { item: { $ref: "#/$defs/Item" }, ...beside },
    $defs: {
      Item: {
        type: "object",
        properties: {
          title: { type: "string" },
          parent: { $ref: "#/$defs/Item" },
        },
      },
    },
  };
}

/** The projection schema {@link declarationBeside}'s declaration derives. */
function derivedSchemaBeside(
  beside: Readonly<Record<string, JSONSchema>>,
): JSONSchema | undefined {
  return declaredResultProjection(declarationBeside(beside))?.schema;
}

/**
 * `item` as the derivation writes it: `title` read as declared, and `parent`
 * rendering its address instead of being followed back into the item. The
 * `false` is what the position holds once its `$link` marker has been lifted
 * out into the projection's `markers`.
 */
const CUT_ITEM = {
  type: "object",
  properties: { title: true, parent: false },
  additionalProperties: false,
};

describe("declaredResultProjection", () => {
  it("returns a `$link` marker at the position where the declaration re-enters", () => {
    expect(declaredResultProjection(declarationBeside({}))).toEqual({
      source: "<the verb's declared result>",
      schema: {
        type: "object",
        properties: { item: CUT_ITEM },
        additionalProperties: false,
      },
      markers: {
        properties: { item: { properties: { parent: { marked: true } } } },
      },
      kind: "json",
      flag: "--schema",
    });
  });

  const wrapperWithOwnItem: JSONSchema = {
    type: "object",
    $defs: {
      Item: {
        type: "object",
        properties: {
          title: { type: "string" },
          parent: { $ref: "#/$defs/Item" },
        },
      },
    },
    properties: { item: { $ref: "#/$defs/Item" } },
  };

  it("derives nothing through a `$defs` below a root that declares none", () => {
    // `#/$defs/Item` names a definition of the root, which declares none;
    // the wrapper's own `$defs` is inert, so nothing re-enters anywhere.

    const declared: JSONSchema = {
      type: "object",
      properties: { wrapper: wrapperWithOwnItem },
    };
    expect(declaredResultProjection(declared)).toBeUndefined();
  });

  it("derives nothing when the root's `$defs` names the definition and that one does not recurse", () => {
    // `#/$defs/Item` names the root's `Item`; the wrapper's own `$defs` is
    // inert below the root's map, and the root's `Item` re-enters nowhere.

    const declared: JSONSchema = {
      type: "object",
      properties: { wrapper: wrapperWithOwnItem },
      $defs: {
        Item: { type: "object", properties: { title: { type: "string" } } },
      },
    };
    expect(declaredResultProjection(declared)).toBeUndefined();
  });

  it("keeps the keys an index signature declares beside the position it cuts", () => {
    // An interface carrying an index signature over its own members lowers to
    // `properties` AND `additionalProperties`, which says the value holds keys
    // the declaration does not name. A projection stating no
    // `additionalProperties` of its own is supplied `false`, so writing
    // `properties` alone would close the position and drop them — an answer
    // narrower than the verb declared, over a bound that is only supposed to
    // remove the circle.

    const declared: JSONSchema = {
      type: "object",
      properties: { item: { $ref: "#/$defs/Item" } },
      additionalProperties: { type: "string" },
      $defs: {
        Item: {
          type: "object",
          properties: {
            title: { type: "string" },
            parent: { $ref: "#/$defs/Item" },
          },
        },
      },
    };
    expect(declaredResultProjection(declared)?.schema).toEqual({
      type: "object",
      properties: { item: CUT_ITEM },
      additionalProperties: true,
    });
  });

  describe('the `"shape"` bound', () => {
    /**
     * A verb that hands back a piece and declares a compact row over it: two
     * scalars, re-entering nowhere. The circle a readback of that piece closes
     * is at no position this declaration names, so there is nothing for the
     * recursion bound to cut and the shape itself is the only boundary in
     * reach.
     */
    const ROW: JSONSchema = {
      type: "object",
      properties: {
        row: {
          type: "object",
          properties: {
            title: { type: "string" },
            createdAt: { type: "number" },
          },
        },
      },
    };

    it("holds every object position to the fields it declares", () => {
      expect(declaredResultProjection(ROW, "shape")?.schema).toEqual({
        type: "object",
        properties: {
          row: {
            type: "object",
            properties: { title: true, createdAt: true },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      });
    });

    it("reads every key stored at an object the declaration leaves open", () => {
      // The shape bound holds an object to the fields it declares, and a
      // declaration carrying an index signature declares the rest of them too.
      // Closing that position would hand back less than the verb states it
      // returns, which is the one thing a bound over a committed handling must
      // not do.

      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            row: {
              type: "object",
              properties: { title: { type: "string" } },
              additionalProperties: { type: "string" },
            },
            other: {
              type: "object",
              properties: { note: { type: "string" } },
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {
          // Nothing below `row` narrows and the position itself narrows
          // nothing, so it reads whatever is stored — the same answer an
          // unbounded readback gives there.
          row: true,
          other: {
            type: "object",
            properties: { note: true },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      });
    });

    it("writes an open object open where something below it narrows", () => {
      // The position still has to be written, because the closed object under
      // it is the bound. Written closed it would drop the keys the index
      // signature declares; written open they read as they always did, and the
      // narrowing below still stands.

      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            row: {
              type: "object",
              properties: {
                inner: {
                  type: "object",
                  properties: { note: { type: "string" } },
                },
              },
              additionalProperties: { type: "string" },
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {
          row: {
            type: "object",
            properties: {
              inner: {
                type: "object",
                properties: { note: true },
                additionalProperties: false,
              },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      });
    });

    it("holds an object the declaration closes with `false` to its fields", () => {
      // A declaration writing `additionalProperties: false` closed the
      // position itself, so the shape bound is stating what the author already
      // stated rather than narrowing anything.

      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            row: {
              type: "object",
              properties: { title: { type: "string" } },
              additionalProperties: false,
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {
          row: {
            type: "object",
            properties: { title: true },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      });
    });

    it("holds an object the declaration closes over no fields to `{}`", () => {
      // Naming no fields and saying the value has none are different
      // statements. `Record<string, never>` lowers to `properties: {}` beside
      // `additionalProperties: false` and is the second, so the shape bound
      // has something to hold the position to and `{}` is what comes back —
      // which is a bound, and bounds a circle sitting at that position.

      expect(
        declaredResultProjection({
          type: "object",
          properties: {},
          additionalProperties: false,
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            ack: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {
          ack: { type: "object", properties: {}, additionalProperties: false },
        },
        additionalProperties: false,
      });
    });

    it("derives nothing from the same declaration under the recursion bound", () => {
      // The contrast is the whole reason the stronger bound exists, and the
      // default is the weaker one: a declaration that re-enters nowhere bounds
      // nothing on its own, so a result that renders is never narrowed.

      expect(declaredResultProjection(ROW)).toBeUndefined();
      expect(declaredResultProjection(ROW, "recursion")).toBeUndefined();
    });

    it("still renders the address where the declaration does re-enter", () => {
      // The stronger bound adds to the weaker one rather than replacing it:
      // `parent` is where the declared type re-enters, and it renders its
      // address under both.

      expect(declaredResultProjection(declarationBeside({}), "shape")?.schema)
        .toEqual({
          type: "object",
          properties: { item: CUT_ITEM },
          additionalProperties: false,
        });
    });

    it("returns `undefined` for a declaration whose positions state no fields", () => {
      // Bare types and an unconstrained object read no less than the value
      // does, so there is nothing here that a readback does not already do —
      // and answering with a projection that changes nothing would report a
      // bound where none was found. `{ type: "object", properties: {} }` is
      // what an empty interface lowers to: it names no fields and closes
      // nothing, which accepts whatever is stored.

      expect(declaredResultProjection({ type: "object" }, "shape"))
        .toBeUndefined();
      expect(declaredResultProjection({}, "shape")).toBeUndefined();
      expect(
        declaredResultProjection(
          { type: "object", properties: {} },
          "shape",
        ),
      ).toBeUndefined();
      expect(declaredResultProjection({ type: "string" }, "shape"))
        .toBeUndefined();
      // An object naming fields beside an index signature reads every key
      // stored at it, which is what a readback already does, so a projection
      // written from it would report a bound that bounds nothing.
      expect(
        declaredResultProjection({
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: { type: "string" },
        }, "shape"),
      ).toBeUndefined();
    });

    it("leaves a union position as wide as it was declared", () => {
      // A projection states one shape per position and a union does not, so
      // the position is left wide under this bound too — the same answer
      // `allOf` gets, and for the same reason. Only re-entry turns a union
      // into an address.

      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            author: {
              anyOf: [
                { type: "object", properties: { name: { type: "string" } } },
                { type: "null" },
              ],
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: { author: true },
        additionalProperties: false,
      });
    });

    it("holds an array's elements to the fields they declare", () => {
      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { title: true },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      });
    });

    it("drops a stream position, which holds no value to read", () => {
      expect(
        declaredResultProjection({
          type: "object",
          properties: {
            title: { type: "string" },
            rename: { asCell: ["stream"] },
          },
        }, "shape")?.schema,
      ).toEqual({
        type: "object",
        properties: { title: true },
        additionalProperties: false,
      });
    });
  });

  it("returns `undefined` where the verb declares no result to bound with", () => {
    expect(declaredResultProjection(undefined)).toBeUndefined();
    expect(declaredResultProjection(true)).toBeUndefined();
  });

  it("returns `undefined` for a declaration that re-enters nowhere", () => {
    expect(declaredResultProjection({
      type: "object",
      properties: {
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    })).toBeUndefined();
  });

  it("returns `true` at an array position that declares no `items`", () => {
    expect(derivedSchemaBeside({ history: { type: "array" } })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, history: true },
      additionalProperties: false,
    });
  });

  it("returns `true` at a position declared as `true`", () => {
    expect(derivedSchemaBeside({ anything: true })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, anything: true },
      additionalProperties: false,
    });
  });

  it("returns `true` at an object position that declares no properties", () => {
    expect(derivedSchemaBeside({ metadata: { type: "object" } })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, metadata: true },
      additionalProperties: false,
    });
  });

  it("returns a `$link` marker at a position one branch of a union re-enters", () => {
    // `anyOf`/`oneOf` are a choice of shape, and a projection states one shape
    // per position. An address answers every branch at once, since it names the
    // position rather than describing what sits at it.

    expect(derivedSchemaBeside({
      origin: { anyOf: [{ $ref: "#/$defs/Item" }, { type: "null" }] },
    })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, origin: false },
      additionalProperties: false,
    });
  });

  it("returns `true` at a conjunction, rather than one member's shape without the others", () => {
    // `allOf` is a conjunction: the value satisfies every member at once, so a
    // member that re-enters does not make the position a choice between shapes.
    // Answering with the re-entering member alone would drop `at`, which is a
    // projection handing back a different value than the declaration describes.
    // The derivation cannot state two shapes at one position, so it leaves the
    // position as wide as it was declared; a readback that then still closes a
    // circle refuses legibly, naming the position it closes at.

    expect(derivedSchemaBeside({
      origin: {
        allOf: [
          { type: "object", properties: { of: { $ref: "#/$defs/Item" } } },
          { type: "object", properties: { at: { type: "string" } } },
        ],
      },
    })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, origin: true },
      additionalProperties: false,
    });
  });

  describe("a `$ref` the declaration does not resolve", () => {
    /** What every case in this group derives: the reference contributes no
     * bound, so its position is read exactly as an unbounded readback reads
     * it, and the recursion beside it is still cut. */
    const unbounded = {
      type: "object",
      properties: { item: CUT_ITEM, origin: true },
      additionalProperties: false,
    };

    it("returns `true` at a position whose `$ref` names nothing in the declaration", () => {
      expect(derivedSchemaBeside({ origin: { $ref: "#/$defs/Missing" } }))
        .toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` points outside the declaration", () => {
      expect(
        derivedSchemaBeside({
          origin: { $ref: "https://example.com/item.json#/$defs/Item" },
        }),
      ).toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` names an anchor rather than a pointer", () => {
      expect(derivedSchemaBeside({ origin: { $ref: "#Item" } }))
        .toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` walks past a name the declaration does not have", () => {
      // `$defs/Item` has no `title` of its own — the title sits under
      // `properties` — so the walk runs out of document with a segment left.

      expect(
        derivedSchemaBeside({ origin: { $ref: "#/$defs/Item/title/type" } }),
      ).toEqual(unbounded);
    });
  });
});
