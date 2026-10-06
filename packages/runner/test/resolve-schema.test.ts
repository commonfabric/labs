/**
 * Unit tests for resolveSchema — basic resolution behavior.
 * Note: Robin's #3118 removed the filterAsCell parameter from resolveSchema,
 * so these tests only cover the single-argument form.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  internSchema,
  isInternedSchema,
  isNontrivialSchema,
  toDeepFrozenSchema,
} from "@commonfabric/data-model-schema";

import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { resolveSchema, resolveSchemaForValue } from "../src/schema.ts";

/** Narrow a JSONSchema | undefined to JSONSchemaObj or fail the test. */
function expectNontrivial(
  schema: JSONSchema | undefined,
): JSONSchemaObj {
  if (!isNontrivialSchema(schema)) {
    throw new Error("expected a nontrivial schema object");
  }
  return schema;
}

describe("resolveSchema", () => {
  describe("basic behavior", () => {
    it("returns undefined for undefined", () => {
      expect(resolveSchema(undefined)).toBe(undefined);
    });

    it("returns an interned empty object for `{}`", () => {
      // `{}` constrains nothing, and it is still a schema that was given.
      const got = resolveSchema({});
      expect(got).toEqual({});
      expect(isInternedSchema(got as JSONSchemaObj)).toBe(true);
    });

    it("returns `true` for the boolean schema `true`", () => {
      expect(resolveSchema(true)).toBe(true);
    });

    it("returns `false` for the boolean schema `false`", () => {
      expect(resolveSchema(false)).toBe(false);
    });

    it("returns the boolean a `$ref` resolves to from a bare ref site", () => {
      // A local ref carries its `$defs` beside it, and those siblings merge
      // into the target, so a boolean arrives as one only with nothing at the
      // ref site to merge — which is what an external ref is. The local
      // spelling is pinned in schema-view.test.ts against a read.
      const local = resolveSchema({
        $ref: "#/$defs/Nothing",
        $defs: { Nothing: false },
      });
      expect(local).toEqual({ not: true, $defs: { Nothing: false } });
    });

    it("returns an equal-but-frozen schema for a non-trivial schema", () => {
      const schema: JSONSchema = { type: "string" };
      const got = resolveSchema(schema);
      expect(got).toEqual(schema);
      expect(Object.isFrozen(got)).toBe(true);
    });

    it("preserves asCell in returned schema", () => {
      const schema: JSONSchema = { type: "string", asCell: ["cell"] };
      const result = expectNontrivial(resolveSchema(schema));
      expect(result.asCell).toEqual(["cell"]);
    });

    it("preserves asCell stream in returned schema", () => {
      const schema: JSONSchema = { type: "string", asCell: ["stream"] };
      const result = expectNontrivial(resolveSchema(schema));
      expect(result.asCell).toEqual(["stream"]);
    });
  });

  describe("canonical intern contract", () => {
    // `resolveSchema` returns the canonical interned reference for its
    // input's structural content. These tests pin down what that means at
    // the edges.
    //
    // Markers use `${...}TestAt${Date.now()}-${Math.random()}` titles to
    // guarantee the input is not already in the intern cache from a prior
    // test run or module load — any static marker string could collide
    // with a previously-interned entry and silently invalidate a
    // "not yet interned" precondition.

    it("returns a deep-frozen interned schema for a non-trivial input", () => {
      // Pins the primitive contract: the returned schema passes
      // `isInternedSchema`. All the other tests in this describe block
      // verify downstream canonicalization behavior; this one confirms
      // the direct invariant that `resolveSchema` interns its output.
      const got = resolveSchema({
        type: "string",
        title: `resolveSchemaInternedTestAt${Date.now()}-${Math.random()}`,
      });
      expect(got).not.toBe(undefined);
      expect(isInternedSchema(got!)).toBe(true);
    });

    it("returns an equal result for a deep-frozen-but-not-interned input", () => {
      const schema: JSONSchema = toDeepFrozenSchema({
        type: "string",
        title: `resolveSchemaEqualTestAt${Date.now()}-${Math.random()}`,
      });
      const got = resolveSchema(schema);
      expect(got).toEqual(schema);
      expect(Object.isFrozen(got)).toBe(true);
    });

    it("returns the canonical interned reference when the input is content-equal to an already-interned schema", () => {
      const marker =
        `resolveSchemaCanonicalTestAt${Date.now()}-${Math.random()}`;
      // Intern a schema first, establishing the canonical reference.
      const canonical = internSchema({ type: "string", title: marker });
      // Build a *different* (but content-equal) deep-frozen reference.
      const lookalike: JSONSchema = toDeepFrozenSchema({
        type: "string",
        title: marker,
      });
      // `resolveSchema` must return the canonical reference, not the
      // caller's lookalike.
      const got = resolveSchema(lookalike);
      expect(got).toBe(canonical);
      expect(got === lookalike).toBe(false);
    });

    it("preserves the caller's reference when the input is already the canonical interned instance", () => {
      // An input that is itself the canonical instance short-circuits
      // through `internSchema`'s WeakMap and comes back unchanged.
      const canonical = internSchema({
        type: "string",
        title: `resolveSchemaPreserveTestAt${Date.now()}-${Math.random()}`,
      });
      expect(resolveSchema(canonical)).toBe(canonical);
    });

    it("canonicalizes compound schemas across calls", () => {
      const marker =
        `resolveSchemaCompoundTestAt${Date.now()}-${Math.random()}`;
      // Two content-equal non-interned inputs produce the same reference
      // on their respective `resolveSchema` calls, because both are
      // canonicalized through the intern cache.
      const first = resolveSchema({
        type: "object",
        title: marker,
        properties: { name: { type: "string" } },
      });
      const second = resolveSchema({
        type: "object",
        title: marker,
        properties: { name: { type: "string" } },
      });
      expect(first).toBe(second);
    });
  });

  describe("resolveSchemaForValue", () => {
    it("does not select literal false compound branches", () => {
      const schema: JSONSchema = {
        anyOf: [
          false,
          {
            type: "string",
            ifc: { integrity: ["string-branch"] },
          },
        ],
      };

      const narrowed = expectNontrivial(resolveSchemaForValue(schema, "ok"));

      expect(narrowed.anyOf).toBe(undefined);
      expect(narrowed.type).toBe("string");
      expect(narrowed.ifc).toEqual({ integrity: ["string-branch"] });
    });

    it("narrows tuple (prefixItems) branches by slot values", () => {
      // CT-1895: a prefixItems-only branch matched ANY array (the matcher
      // fell through to true), so the wrong union branch could be selected
      // for tuple values.
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "array",
            prefixItems: [{ const: "point" }, { type: "number" }],
            ifc: { integrity: ["point-branch"] },
          },
          {
            type: "array",
            prefixItems: [{ const: "label" }, { type: "string" }],
            ifc: { integrity: ["label-branch"] },
          },
        ],
      };

      const narrowed = expectNontrivial(
        resolveSchemaForValue(schema, ["label", "x"]),
      );

      expect(narrowed.anyOf).toBe(undefined);
      expect(narrowed.ifc).toEqual({ integrity: ["label-branch"] });
    });

    it("a closed tuple (items: false) does not match arrays with extras", () => {
      // PR #4969 review: boolean `items` was skipped, so a closed-tuple
      // branch matched arrays with extra elements and could win the union.
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "array",
            prefixItems: [{ const: "cmd" }],
            items: false,
            ifc: { integrity: ["closed-tuple-branch"] },
          },
          {
            type: "array",
            ifc: { integrity: ["open-array-branch"] },
          },
        ],
      };

      const narrowed = expectNontrivial(
        resolveSchemaForValue(schema, ["cmd", "extra"]),
      );
      expect(narrowed.ifc).toEqual({ integrity: ["open-array-branch"] });
    });

    it("matches items only past the tuple slots", () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "array",
            // Slot 0 is a string the rest schema would reject; items must
            // only constrain the elements past the tuple arity.
            prefixItems: [{ type: "string" }],
            items: { type: "number" },
            ifc: { integrity: ["tuple-branch"] },
          },
          { type: "string" },
        ],
      };

      const narrowed = expectNontrivial(
        resolveSchemaForValue(schema, ["cmd", 1, 2]),
      );

      expect(narrowed.ifc).toEqual({ integrity: ["tuple-branch"] });
    });

    it("narrows union branches with nested refs to parent defs", () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: {
              payload: { $ref: "#/$defs/MessageAlice" },
            },
            required: ["payload"],
          },
          {
            type: "object",
            properties: {
              payload: { $ref: "#/$defs/MessageBob" },
            },
            required: ["payload"],
          },
        ],
        $defs: {
          MessageAlice: {
            type: "object",
            properties: {
              author: {
                type: "string",
                enum: ["alice"],
              },
            },
            required: ["author"],
            ifc: {
              integrity: [{ kind: "authored-by", subject: "alice" }],
            },
          },
          MessageBob: {
            type: "object",
            properties: {
              author: {
                type: "string",
                enum: ["bob"],
              },
            },
            required: ["author"],
            ifc: {
              integrity: [{ kind: "authored-by", subject: "bob" }],
            },
          },
        },
      };

      const narrowed = expectNontrivial(
        resolveSchemaForValue(schema, { payload: { author: "alice" } }),
      );

      expect(narrowed.anyOf).toBe(undefined);
      expect(narrowed.properties?.payload).toMatchObject({
        ifc: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      });
    });
  });
});
