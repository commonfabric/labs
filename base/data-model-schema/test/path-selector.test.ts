import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj, SchemaPathSelector } from "@commonfabric/api";

import { isDeepFrozen } from "@commonfabric/data-model";
import {
  DEFAULT_SELECTOR,
  internPathSelector,
  REJECTING_SELECTOR,
} from "@/path-selector.ts";
import { internSchema, isInternedSchema } from "@/schema-intern.ts";

describe("path-selector", () => {
  describe("internPathSelector()", () => {
    // Interning is keyed by content and outlives any one case, so a schema
    // another case already interned comes back as a hit, and these cases stop
    // exercising the fresh-intern path they mean to. The unique `title`
    // guarantees a miss.
    const uniqueSchema = (): JSONSchemaObj => ({
      type: "object",
      title: `internPathSelectorTestAt${Date.now()}-${Math.random()}`,
    });

    it("freezes `selector.path` and `selector` in place", () => {
      const selector: SchemaPathSelector = {
        path: ["a", "b"],
        schema: uniqueSchema(),
      };
      expect(Object.isFrozen(selector)).toBe(false);
      expect(Object.isFrozen(selector.path)).toBe(false);
      internPathSelector(selector);
      expect(Object.isFrozen(selector)).toBe(true);
      expect(Object.isFrozen(selector.path)).toBe(true);
    });

    it("interns `selector.schema` when it is an object", () => {
      const schema = uniqueSchema();
      const selector: SchemaPathSelector = { path: ["x"], schema };
      expect(isInternedSchema(schema)).toBe(false);
      internPathSelector(selector);
      expect(isInternedSchema(schema)).toBe(true);
      expect(isDeepFrozen(schema)).toBe(true);
    });

    it("canonicalizes `selector.schema` to the interned instance", () => {
      const title = `internPathSelectorCanonAt${Date.now()}-${Math.random()}`;
      // Establish the canonical interned instance from one distinct object...
      const canonical = internSchema({ type: "object", title });
      // ...then intern a selector holding a structurally-equal but distinct
      // schema object. After interning, `selector.schema` should be the shared
      // canonical instance, not the (now-redundant) input object.
      const selector: SchemaPathSelector = {
        path: ["x"],
        schema: { type: "object", title },
      };
      expect(selector.schema).not.toBe(canonical);
      internPathSelector(selector);
      expect(selector.schema).toBe(canonical);
    });

    it("returns a new selector when a frozen input's schema must be canonicalized", () => {
      const title = `internPathSelectorFrozenAt${Date.now()}-${Math.random()}`;
      // Establish the canonical interned instance from one distinct object...
      const canonical = internSchema({ type: "object", title });
      // ...then build a *frozen* selector holding a structurally-equal but
      // distinct (non-canonical) schema object. Since the input is frozen, its
      // schema can't be replaced in place, so interning must allocate and
      // return a new selector carrying the canonical schema.
      const selector = Object.freeze({
        path: Object.freeze(["x"]),
        schema: Object.freeze({ type: "object", title }),
      }) as SchemaPathSelector;
      expect(selector.schema).not.toBe(canonical);
      const result = internPathSelector(selector);
      expect(result).not.toBe(selector);
      expect(result.schema).toBe(canonical);
      expect(result.path).toEqual(["x"]);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("returns the input reference when `selector.schema` is already interned", () => {
      const title =
        `internPathSelectorPreInternedAt${Date.now()}-${Math.random()}`;
      const interned = internSchema({ type: "object", title });
      expect(isInternedSchema(interned)).toBe(true);
      // Even a frozen selector is returned as-is when its schema is already the
      // canonical interned instance: there is nothing to replace, so no clone.
      const selector = Object.freeze({
        path: Object.freeze(["x"]),
        schema: interned,
      }) as SchemaPathSelector;
      const result = internPathSelector(selector);
      expect(result).toBe(selector);
      expect(result.schema).toBe(interned);
    });

    it("interns a selector with an empty path", () => {
      const schema = uniqueSchema();
      const selector: SchemaPathSelector = { path: [], schema };
      const result = internPathSelector(selector);

      expect(result.path).toEqual([]);
      expect(Object.isFrozen(result.path)).toBe(true);
      expect(isInternedSchema(result.schema as JSONSchemaObj)).toBe(true);
    });

    it("keeps an empty path distinct from a non-empty one", () => {
      const schema = uniqueSchema();
      const empty = internPathSelector({ path: [], schema });
      const nonEmpty = internPathSelector({ path: ["a"], schema });

      expect(empty).not.toBe(nonEmpty);
      expect(empty.path).toEqual([]);
      expect(nonEmpty.path).toEqual(["a"]);
    });

    it("canonicalizes to one instance when a frozen path array is reused", () => {
      const schema = uniqueSchema();
      const first = internPathSelector({ path: ["a", "b"], schema });

      // Interning froze the path in place, so the same array identity can be
      // handed back in a fresh selector -- the repeat case the path-key cache
      // exists for. The cache is only populated once the path is frozen, so
      // it takes a third pass to serve one; all three must agree.
      const second = internPathSelector({
        path: first.path,
        schema: first.schema,
      });
      const third = internPathSelector({
        path: first.path,
        schema: first.schema,
      });

      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("keeps paths distinct when a component contains the separator", () => {
      const schema = uniqueSchema();
      const a = internPathSelector({ path: ["a:b"], schema });
      const b = internPathSelector({ path: ["a", "b"], schema });

      expect(a).not.toBe(b);
    });

    it("keeps live entries when the path cache sweeps", () => {
      // The per-schema path map sweeps collected entries once it passes its
      // threshold (2048). Holding every returned selector alive means the
      // sweep runs with nothing to collect, which is the case that must not
      // lose canonical instances: dropping a live entry would silently break
      // canonicalization for that path.
      const schema = uniqueSchema();
      const held: SchemaPathSelector[] = [];
      for (let i = 0; i <= 2048; i++) {
        held.push(internPathSelector({ path: [`p${i}`], schema }));
      }

      // Every path still canonicalizes to the instance interned for it.
      expect(internPathSelector({ path: ["p0"], schema })).toBe(held[0]);
      expect(internPathSelector({ path: ["p2048"], schema })).toBe(held[2048]);
    });

    it("freezes a selector whose `schema` is `undefined`", () => {
      const selector: SchemaPathSelector = { path: ["p"] };
      // Must not throw — `internSchema(undefined)` would, and the guard
      // `if (selector.schema !== undefined)` prevents it.
      internPathSelector(selector);
      expect(Object.isFrozen(selector)).toBe(true);
      expect(Object.isFrozen(selector.path)).toBe(true);
    });

    it("freezes and interns a selector whose `schema` is `true` or `false`", () => {
      const trueSelector: SchemaPathSelector = { path: ["t"], schema: true };
      const falseSelector: SchemaPathSelector = { path: ["f"], schema: false };
      internPathSelector(trueSelector);
      internPathSelector(falseSelector);
      expect(Object.isFrozen(trueSelector)).toBe(true);
      expect(Object.isFrozen(falseSelector)).toBe(true);
      expect(isInternedSchema(true)).toBe(true);
      expect(isInternedSchema(false)).toBe(true);
    });

    it("returns its input reference (does not clone)", () => {
      const selector: SchemaPathSelector = {
        path: ["x"],
        schema: uniqueSchema(),
      };
      const result = internPathSelector(selector);
      expect(result).toBe(selector);
    });

    it("is idempotent: `internPathSelector(x) === internPathSelector(x)`", () => {
      const selector: SchemaPathSelector = {
        path: ["x"],
        schema: uniqueSchema(),
      };
      const first = internPathSelector(selector);
      const second = internPathSelector(selector);
      expect(first).toBe(second);
      expect(first).toBe(selector);
    });

    it("canonicalizes two distinct equal selectors (object schema) to one instance", () => {
      const schema = uniqueSchema();
      const a = internPathSelector({ path: ["x"], schema });
      // A *distinct* selector object carrying a structurally-equal (but
      // separate) schema object must resolve to the very same canonical
      // instance -- not merely the same-object idempotency checked above.
      const b = internPathSelector({ path: ["x"], schema: { ...schema } });
      expect(b).toBe(a);
    });

    it("canonicalizes two distinct equal selectors with primitive/absent schemas", () => {
      // Exercises the primitive-schema map (booleans and the `undefined`
      // "schema") rather than the object `WeakMap`. Fresh unique paths keep
      // prior interning in this process from pre-populating the cache.
      const base = `prim-${Date.now()}-${Math.random()}`;
      for (const schema of [undefined, true, false] as const) {
        const path = [`${base}-${String(schema)}`];
        const a = internPathSelector({ path: [...path], schema });
        const b = internPathSelector({ path: [...path], schema });
        expect(b).toBe(a);
      }
    });

    it("keeps the same path distinct across schema kinds", () => {
      // Same path, schema ∈ {undefined, true, false, object}. Each kind must
      // get its own canonical instance: this guards routing between the object
      // `WeakMap` and the primitive `Map`, plus the per-key separation of
      // `undefined`/`true`/`false` within the primitive map.
      const path = [`kinds-${Date.now()}-${Math.random()}`];
      const results = [
        internPathSelector({ path: [...path] }),
        internPathSelector({ path: [...path], schema: true }),
        internPathSelector({ path: [...path], schema: false }),
        internPathSelector({ path: [...path], schema: uniqueSchema() }),
      ];
      expect(new Set(results).size).toBe(4);
    });

    it("does not conflate paths that share a naive concatenation", () => {
      // Same canonical schema, so path is the only discriminator. A separator
      // join would collide `["a","b"]` with `["a.b"]`; the length-prefixed key
      // keeps all three apart.
      const schema = internSchema(uniqueSchema());
      const s1 = internPathSelector({ path: ["a", "b"], schema });
      const s2 = internPathSelector({ path: ["ab"], schema });
      const s3 = internPathSelector({ path: ["a.b"], schema });
      expect(s1).not.toBe(s2);
      expect(s1).not.toBe(s3);
      expect(s2).not.toBe(s3);
    });

    it("freezes and canonicalizes a mutable input in place even on a cache hit", () => {
      const schema = uniqueSchema();
      const canonical = internPathSelector({ path: ["x"], schema });
      // A distinct, still-mutable selector with equal content. The canonical
      // already exists, so the return value is that canonical one rather than
      // this input. Per the pre-cache contract the input is nonetheless frozen
      // and its schema canonicalized in place, for callers that keep using
      // their own object.
      const dup: SchemaPathSelector = { path: ["x"], schema: { ...schema } };
      expect(Object.isFrozen(dup)).toBe(false);
      const result = internPathSelector(dup);
      expect(result).toBe(canonical);
      expect(result).not.toBe(dup);
      expect(Object.isFrozen(dup)).toBe(true);
      expect(Object.isFrozen(dup.path)).toBe(true);
      expect(dup.schema).toBe(canonical.schema);
    });
  });

  describe("the canonical selectors", () => {
    // Each constant is interned when the module loads, so it holds the cache
    // slot for its content before any caller can build an equivalent. The
    // assertion is that such an equivalent collapses onto the constant rather
    // than becoming a second wrapper for the same selector.
    //
    // The equivalents are built here rather than reusing the constants,
    // because handing a constant back to `internPathSelector()` would let it
    // claim the slot on the spot and pass whether or not the module seeded
    // anything.
    for (
      const [name, constant, path, schema] of [
        ["REJECTING_SELECTOR", REJECTING_SELECTOR, [], false],
        ["DEFAULT_SELECTOR", DEFAULT_SELECTOR, ["value"], true],
      ] as const
    ) {
      it(`returns \`${name}\` for an equivalent selector`, () => {
        expect(internPathSelector({ path: [...path], schema })).toBe(constant);
      });
    }
  });
});
