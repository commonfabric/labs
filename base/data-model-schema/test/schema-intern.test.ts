/**
 * Interning a schema, so that an equal schema becomes the same object and can
 * be named by its hash.
 *
 * Interning is what makes a schema comparable by identity afterward, so the
 * cases cover the several ways one can be asked for -- with and without the
 * hash alongside it, by lookup, by predicate, and as a tagged string -- rather
 * than letting one entry point stand in for the rest.
 *
 * One group checks the interned form against the `data:` id minted for the
 * same schema. They are two separate namings of one thing, and worth setting
 * against each other rather than each being checked alone.
 */

import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import {
  deepFrozenCloneAndInternSchema,
  findInternedSchema,
  internSchema,
  internSchemaAsTaggedHashString,
  internSchemaPairAsKey,
  isInternedSchema,
} from "@/schema-intern.ts";
import { SchemaAndHash } from "@/SchemaAndHash.ts";
import { isDeepFrozen, taggedHashStringOf } from "@commonfabric/data-model";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { toDeepFrozenSchema } from "@/schema-copy.ts";

describe("schema-intern", () => {
  describe("internSchema()", () => {
    it("defaults to `wantSchemaAndHash = false`", () => {
      const result = internSchema({});
      expect(result).not.toBeInstanceOf(SchemaAndHash);
    });

    for (const wantSah of [false, true]) {
      const callIntern = (
        schema: JSONSchema | undefined,
        fullResult = false,
      ) => {
        const result = internSchema(schema, wantSah);

        if (wantSah) {
          assert(result instanceof SchemaAndHash);
          assert(result.hash instanceof FabricHash);
          return fullResult ? result : result.schemaOrUndefined;
        } else {
          return result;
        }
      };

      describe(`with \`wantSchemaAndHash = ${wantSah}\``, () => {
        it("creates a valid result with schema equal to the given one", () => {
          const result = callIntern({ type: "number" });
          expect(result).toEqual({ type: "number" });
        });

        it("returns a deep-frozen schema result", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { name: { type: "string" } },
          };
          const result = callIntern(schema);
          expect(isDeepFrozen(result)).toBe(true);
        });

        it("deep-freezes the caller's original if not already deep-frozen", () => {
          const schema: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          callIntern(schema);
          expect(isDeepFrozen(schema)).toBe(true);
        });

        it("uses an already-deep-frozen schema by reference", () => {
          // Content-unique key guarantees no prior interning has seen this
          // exact schema; interning returns the input by reference.
          const schema = toDeepFrozenSchema({
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
            type: "object",
          }) as JSONSchemaObj;
          expect(isDeepFrozen(schema)).toBe(true);
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("preserves identity for a schema holding `NaN`", () => {
          // `NaN` never `===`-equals itself; identity preservation must not
          // depend on leaf self-equality.
          const schema = toDeepFrozenSchema({
            default: NaN,
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
            type: "number",
          }) as JSONSchemaObj;
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("preserves identity for a schema holding `NaN` in an array", () => {
          // As above, with the leaf inside an array (`examples`).
          const schema = toDeepFrozenSchema({
            examples: [NaN],
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
            type: "number",
          }) as JSONSchemaObj;
          const result = callIntern(schema);
          expect(result).toBe(schema);
        });

        it("uses a never-before-encountered mutable schema by reference", () => {
          // Content-unique: frozen in place and returned by reference,
          // regardless of key order.
          const schema: JSONSchemaObj = {
            type: "object",
            title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
          };
          const result = callIntern(schema);
          expect(result).toBe(schema);
          expect(isDeepFrozen(result)).toBe(true);
        });

        it("returns `true` for the schema `true`", () => {
          const result = callIntern(true);
          expect(result).toBe(true);
        });

        it("returns `false` for the schema `false`", () => {
          const result = callIntern(false);
          expect(result).toBe(false);
        });

        it("returns `undefined` for the schema `undefined`", () => {
          const result = callIntern(undefined);
          expect(result).toBe(undefined);
        });

        it("returns an equal empty object for an empty object schema", () => {
          const result = callIntern({});
          expect(result).toEqual({});
        });

        it("returns same instance for repeated boolean schema", () => {
          const result1 = callIntern(true, true);
          const result2 = callIntern(true, true);
          expect(result1).toBe(result2);
        });

        it("returns same instance for same frozen object schema", () => {
          const schema = toDeepFrozenSchema({
            type: "number",
          }) as JSONSchemaObj;
          const result1 = callIntern(schema, true);
          const result2 = callIntern(schema, true);
          expect(result1).toBe(result2);
        });

        it("returns same instance for repeated unfrozen schema", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "number" }, true);
          expect(result1).toBe(result2);
        });

        it("produces different instances for different schemas", () => {
          const result1 = callIntern({ type: "number" }, true);
          const result2 = callIntern({ type: "string" }, true);
          expect(result1).not.toBe(result2);
        });

        it("interns two property orderings to the same object", () => {
          const result1 = callIntern(
            { type: "object", title: "foo" },
            true,
          );
          const result2 = callIntern(
            { title: "foo", type: "object" },
            true,
          );
          expect(result1).toBe(result2);
        });

        it("returns the same instance for structurally-equal but identity-different schemas", () => {
          const a: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          const b: JSONSchemaObj = {
            type: "object",
            properties: { x: { type: "number" } },
          };
          expect(a).not.toBe(b); // different objects
          const resultA = callIntern(a, true);
          const resultB = callIntern(b, true);
          expect(resultA).toBe(resultB);
        });
      });
    }
  });

  describe("interned key order vs. minted `data:` ids", () => {
    it("mints identical ids for equal-content schemas regardless of interned key order", () => {
      // Interning preserves the object's construction key order; id
      // determinism is entirely the value encoding's job. So a schema
      // interned in non-canonical key order and a never-interned
      // structurally-equal schema in canonical (UTF-8-sorted) order must
      // mint the same content-addressed id.
      const title = `schemaHashTestAt${Date.now()}-${Math.random()}`;
      const scrambled = internSchema({ type: "number", title });
      const sorted: JSONSchemaObj = { title, type: "number" };

      expect(dataUriFromValue({ schema: scrambled }))
        .toBe(dataUriFromValue({ schema: sorted }));
    });
  });

  describe("deepFrozenCloneAndInternSchema()", () => {
    it("interns a deep-frozen clone without freezing the input in place", () => {
      const input: JSONSchema = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      expect(Object.isFrozen(input)).toBe(false); // precondition

      const result = deepFrozenCloneAndInternSchema(input);

      expect(result).not.toBe(input); // a clone, not the same object
      expect(result).toEqual(input); // structurally equal
      expect(isInternedSchema(result)).toBe(true);
      expect(isDeepFrozen(result)).toBe(true);
      // The whole point of this function: the caller's object is untouched,
      // unlike `internSchema()`, which would deep-freeze it in place.
      expect(Object.isFrozen(input)).toBe(false);
    });

    it("interns by content (equal inputs collapse to one instance)", () => {
      const a = deepFrozenCloneAndInternSchema({ type: "number", title: "x" });
      const b = deepFrozenCloneAndInternSchema({ type: "number", title: "x" });
      expect(a).toBe(b);
    });

    it("passes `undefined` and boolean schemas through", () => {
      expect(deepFrozenCloneAndInternSchema(undefined)).toBe(undefined);
      expect(deepFrozenCloneAndInternSchema(true)).toBe(true);
      expect(deepFrozenCloneAndInternSchema(false)).toBe(false);
    });
  });

  describe("isInternedSchema()", () => {
    it("returns `true` for boolean `true`", () => {
      expect(isInternedSchema(true)).toBe(true);
    });

    it("returns `true` for boolean `false`", () => {
      expect(isInternedSchema(false)).toBe(true);
    });

    it("returns `true` for `undefined`", () => {
      expect(isInternedSchema(undefined)).toBe(true);
    });

    it("returns `true` for a freshly interned schema", () => {
      const schema = internSchema({ type: "string" });
      expect(isInternedSchema(schema)).toBe(true);
    });

    it("returns `false` for a non-interned schema", () => {
      const schema: JSONSchemaObj = { type: "string" };
      expect(isInternedSchema(schema)).toBe(false);
    });

    it("returns `false` for an equivalent-but-different object", () => {
      internSchema({ type: "number" });
      const equivalent: JSONSchemaObj = { type: "number" };
      expect(isInternedSchema(equivalent)).toBe(false);
    });
  });

  describe("findInternedSchema()", () => {
    const callFind = (hash: FabricHash | string) => {
      const result = findInternedSchema(hash);

      if (result !== undefined) {
        expect(result).toBeInstanceOf(SchemaAndHash);
        expect(result.hash).toBeInstanceOf(FabricHash);
      }

      return result;
    };

    it("finds a previously interned schema by FabricHash", () => {
      const sah = internSchema(
        { type: "array", items: { type: "string" } },
        true,
      );
      const found = callFind(sah.hash);
      expect(found).toBe(sah);
    });

    it("finds a previously interned schema by hash string", () => {
      const sah = internSchema(
        {
          type: "object",
          properties: { z: { type: "boolean" } },
        },
        true,
      );
      const found = callFind(sah.taggedHashString);
      expect(found).toBe(sah);
    });

    it("returns `undefined` for unknown hash", () => {
      const unknown = new FabricHash(new Uint8Array(32), "fid1");
      const found = callFind(unknown);
      expect(found).toBe(undefined);
    });

    it("finds interned boolean schemas", () => {
      const sahTrue = internSchema(true, true);
      const sahFalse = internSchema(false, true);
      const foundTrue = callFind(sahTrue.hash);
      const foundFalse = callFind(sahFalse.hash);
      expect(foundTrue).toBe(sahTrue);
      expect(foundFalse).toBe(sahFalse);
    });

    it("finds `undefined`", () => {
      const undefinedHash = taggedHashStringOf(undefined);
      const found = callFind(undefinedHash);
      expect(found).not.toBe(undefined);
      expect(found!.schemaOrUndefined).toBe(undefined);
    });
  });

  describe("internSchemaAsTaggedHashString()", () => {
    it("returns the interned schema's `.taggedHashString` for an object", () => {
      const schema: JSONSchema = { type: "number" };
      const sah = internSchema(schema, true);
      expect(internSchemaAsTaggedHashString(schema)).toBe(sah.taggedHashString);
    });

    it("returns the prefab `.taggedHashString` for `true`", () => {
      const expected = internSchema(true, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(true)).toBe(expected);
    });

    it("returns the prefab `.taggedHashString` for `false`", () => {
      const expected = internSchema(false, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(false)).toBe(expected);
    });

    it("returns the prefab `.taggedHashString` for `undefined`", () => {
      const expected = internSchema(undefined, true).taggedHashString;
      expect(internSchemaAsTaggedHashString(undefined)).toBe(expected);
    });

    it("produces matching strings for structurally-equal objects", () => {
      const a: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      const b: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      expect(internSchemaAsTaggedHashString(a)).toBe(
        internSchemaAsTaggedHashString(b),
      );
    });

    it("produces different strings for different schemas", () => {
      expect(internSchemaAsTaggedHashString({ type: "number" })).not.toEqual(
        internSchemaAsTaggedHashString({ type: "string" }),
      );
      expect(internSchemaAsTaggedHashString(true)).not.toEqual(
        internSchemaAsTaggedHashString(false),
      );
    });

    it("interns the input schema as a side effect", () => {
      // Content-unique key guarantees no prior interning has seen this
      // exact schema, so `isInternedSchema` reflects what THIS call did.
      const schema: JSONSchemaObj = {
        type: "number",
        title: `schemaHashTestAt${Date.now()}-${Math.random()}`,
      };
      expect(isInternedSchema(schema)).toBe(false);
      internSchemaAsTaggedHashString(schema);
      expect(isInternedSchema(schema)).toBe(true);
      expect(isDeepFrozen(schema)).toBe(true);
    });

    it("is idempotent on already-interned schemas", () => {
      const schema: JSONSchema = { type: "number" };
      const first = internSchemaAsTaggedHashString(schema);
      const second = internSchemaAsTaggedHashString(schema);
      expect(first).toBe(second);
    });
  });

  describe("internSchemaPairAsKey()", () => {
    it("composes the two interned `.taggedHashString`s with `|`", () => {
      const a: JSONSchema = { type: "number" };
      const b: JSONSchema = { type: "string" };
      const aHash = internSchema(a, true).taggedHashString;
      const bHash = internSchema(b, true).taggedHashString;
      expect(internSchemaPairAsKey(a, b)).toBe(`${aHash}|${bHash}`);
    });

    it("builds the pair key from either side's boolean schema", () => {
      const obj: JSONSchema = { type: "number" };
      const objHash = internSchema(obj, true).taggedHashString;
      const trueHash = internSchema(true, true).taggedHashString;
      const falseHash = internSchema(false, true).taggedHashString;
      expect(internSchemaPairAsKey(true, obj)).toBe(`${trueHash}|${objHash}`);
      expect(internSchemaPairAsKey(obj, false)).toBe(`${objHash}|${falseHash}`);
      expect(internSchemaPairAsKey(true, false)).toBe(
        `${trueHash}|${falseHash}`,
      );
    });

    it("is order-sensitive", () => {
      const a: JSONSchema = { type: "number" };
      const b: JSONSchema = { type: "string" };
      expect(internSchemaPairAsKey(a, b)).not.toEqual(
        internSchemaPairAsKey(b, a),
      );
    });

    it("matches for structurally-equal inputs", () => {
      const a1: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      const a2: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" } },
      };
      const b1: JSONSchema = { type: "array", items: { type: "number" } };
      const b2: JSONSchema = { type: "array", items: { type: "number" } };
      expect(internSchemaPairAsKey(a1, b1)).toBe(internSchemaPairAsKey(a2, b2));
    });

    it("interns both inputs as a side effect", () => {
      // Content-unique keys guarantee no prior interning has seen
      // these exact schemas, so `isInternedSchema` reflects what
      // THIS call did.
      const stamp = `${Date.now()}-${Math.random()}`;
      const a: JSONSchemaObj = {
        type: "number",
        title: `schemaHashTestAt${stamp}-a`,
      };
      const b: JSONSchemaObj = {
        type: "string",
        title: `schemaHashTestAt${stamp}-b`,
      };
      expect(isInternedSchema(a)).toBe(false);
      expect(isInternedSchema(b)).toBe(false);
      internSchemaPairAsKey(a, b);
      expect(isInternedSchema(a)).toBe(true);
      expect(isInternedSchema(b)).toBe(true);
      expect(isDeepFrozen(a)).toBe(true);
      expect(isDeepFrozen(b)).toBe(true);
    });
  });
});
