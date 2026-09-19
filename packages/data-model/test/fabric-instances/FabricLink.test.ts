/**
 * A link as a `FabricInstance`: a payload object wrapped so that it can carry
 * arbitrary nested values, a stored schema among them.
 *
 * Being an instance rather than a primitive is the first consequence -- a link
 * is mutable until frozen rather than born immutable. The payload is validated
 * on the way in, and the keys it refuses are the prototype-bearing ones: a
 * payload is a plain record, and a key that would reach the prototype chain is
 * not data.
 *
 * Cloning carries the interesting promises. A frozen deep clone shares an
 * already-deep-frozen subtree rather than copying it, a mutable deep clone
 * shares nothing, and a mutable shallow clone shares the payload reference
 * outright.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  cloneIfNecessary,
  deepFreeze,
  FabricInstance,
  FabricPrimitive,
  hashOf,
  isDeepFrozen,
  type MutableFabricPlainObjectLayer,
} from "@";
import {
  CODEC,
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common";
import { DEEP_FREEZE, IS_DEEP_FROZEN } from "@/fabric-bases";
import { FabricLink } from "@/fabric-instances";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";
import { fabricFromJsonValue, jsonFromFabricValue } from "@/codecs.ts";

describe("FabricLink", () => {
  it("extends `FabricInstance` (not `FabricPrimitive`)", () => {
    // Pure type-identity / supertype check: cross-cutting carve-out per the
    // rule (doesn't fit a single member, isn't construction mechanics).

    const link = new FabricLink({ id: "fid1:abc" });
    expect(link instanceof FabricInstance).toBe(true);
    expect(link instanceof FabricPrimitive).toBe(false);
  });

  describe("constructor()", () => {
    it("wraps and exposes the payload", () => {
      const payload = {
        id: "fid1:abc",
        path: ["a", "b"],
        overwrite: "redirect",
      };
      const link = new FabricLink(payload);
      expect(link.payload).toBe(payload);
    });

    it("is mutable until frozen (not born frozen, unlike a primitive)", () => {
      expect(Object.isFrozen(new FabricLink({ id: "fid1:abc" }))).toBe(false);
    });

    it("keeps a non-string payload value, such as an outgoing ref's schema", () => {
      const link = new FabricLink({
        id: "fid1:abc",
        schema: { type: "object", properties: { x: { type: "string" } } },
      });
      expect(link.payload.schema).toEqual({
        type: "object",
        properties: { x: { type: "string" } },
      });
    });

    it("keeps an empty payload empty", () => {
      expect(new FabricLink({}).payload).toEqual({});
    });

    describe("validation", () => {
      it("throws given a non-plain-object payload", () => {
        expect(() => new FabricLink([] as unknown as Record<string, never>))
          .toThrow("must be a plain object");
      });

      it("throws given `null`", () => {
        expect(() => new FabricLink(null as unknown as Record<string, never>))
          .toThrow("must be a plain object");
      });

      it("throws given a `__proto__` key", () => {
        const evil = JSON.parse('{ "__proto__": "x" }');
        expect(() => new FabricLink(evil)).toThrow("forbidden key");
      });

      it("throws given a `constructor` key", () => {
        const evil = JSON.parse('{ "constructor": "x" }');
        expect(() => new FabricLink(evil)).toThrow("forbidden key");
      });
    });
  });

  describe("deep-freeze protocol", () => {
    describe("deepFreeze()", () => {
      it("freezes the instance, its payload, and nested values", () => {
        const link = new FabricLink({
          id: "fid1:abc",
          schema: { type: "object" },
        });
        const frozen = deepFreeze(link);
        expect(frozen).toBe(link); // frozen in place
        expect(isDeepFrozen(frozen)).toBe(true);
        expect(Object.isFrozen(frozen.payload)).toBe(true);
        expect(Object.isFrozen(frozen.payload.schema)).toBe(true);
      });
    });

    describe("isDeepFrozen()", () => {
      it("is `false` for a mutable instance", () => {
        expect(isDeepFrozen(new FabricLink({ id: "fid1:abc" }))).toBe(false);
      });
    });

    describe("`[IS_DEEP_FROZEN]` (direct)", () => {
      it("is `false` before and `true` after `[DEEP_FREEZE]`", () => {
        // Direct member invocation: `isDeepFrozen()` short-circuits via
        // `deepFreeze()`'s cache, so the protocol method only runs when called
        // straight, as here.
        const link = new FabricLink({ id: "fid1:abc", path: ["a"] });
        expect(link[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
        link[DEEP_FREEZE](subFreeze);
        expect(link[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("instance members", () => {
    describe("deepClone()", () => {
      it("returns a deep-frozen clone with an equal payload", () => {
        const link = new FabricLink({ id: "fid1:abc", path: ["a"] });
        const clone = link.deepClone(true) as FabricLink;
        expect(isDeepFrozen(clone)).toBe(true);
        expect(clone.payload).toEqual(link.payload);
      });

      it("identity-returns an already-deep-frozen instance", () => {
        const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));
        expect(link.deepClone(true)).toBe(link);
      });

      it("returns an independent mutable clone (no shared payload structure)", () => {
        const link = new FabricLink({ id: "fid1:abc" });
        const clone = link.deepClone(false) as FabricLink;
        expect(Object.isFrozen(clone)).toBe(false);
        expect(clone.payload).not.toBe(link.payload);
        (clone.payload as MutableFabricPlainObjectLayer).id = "fid1:xyz";
        expect(link.payload.id).toBe("fid1:abc");
      });

      it("returns a frozen clone that identity-shares an already-deep-frozen payload subtree", () => {
        // The `[DEEP_CLONE_CORE](frozen)` core clones the payload to the
        // requested frozenness, so the "maximal structural sharing" the
        // `deepClone()` contract promises holds: a nested subtree that is
        // already deep-frozen rides into the frozen clone by identity.
        const schema = deepFreeze({ type: "object" });
        const link = new FabricLink({ id: "fid1:abc", schema });
        const clone = link.deepClone(true) as FabricLink;
        expect(clone).not.toBe(link);
        expect(isDeepFrozen(clone)).toBe(true);
        expect(clone.payload.schema).toBe(schema);
      });
    });

    describe("shallowClone()", () => {
      it("returns a mutable shallow clone that shares the payload reference", () => {
        const link = new FabricLink({ id: "fid1:abc" });
        const clone = link.shallowClone(false) as FabricLink;
        expect(clone).not.toBe(link);
        expect(clone.payload).toBe(link.payload);
      });

      it("identity-returns an already-frozen instance when asked for frozen", () => {
        const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));
        expect(link.shallowClone(true)).toBe(link);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricLink[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Link;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Link` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricLink`, rejecting other values", () => {
          expect(codec.canEncode(new FabricLink({ id: "fid1:abc" }))).toBe(
            true,
          );
          expect(codec.canEncode("not a link")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to the payload object", () => {
          const link = new FabricLink({ id: "fid1:abc", path: ["a", "b"] });
          expect(codec.encode(link, env)).toEqual({
            id: "fid1:abc",
            path: ["a", "b"],
          });
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record", () => {
          expect(codec.canDecode({ id: "fid1:abc" })).toBe(true);
        });

        it("returns `false` for state that is not a record", () => {
          expect(codec.canDecode("nope")).toBe(false);
        });
      });

      describe("decode()", () => {
        it("returns a `ProblematicValue` for a payload the constructor rejects", () => {
          // `canDecode()` accepts any record, so what reaches the `catch` is a
          // record the constructor will not take. A reserved key is one such
          // payload, and the wire is where it plausibly arrives: `JSON.parse`
          // is what creates that name as an own property.
          const evil = JSON.parse('{ "id": "fid1:abc", "__proto__": "x" }');
          const result = codec.decode(expectedTag, evil, env);

          expect(result).toBeInstanceOf(ProblematicValue);
          expect((result as ProblematicValue).wireTypeTag).toBe(expectedTag);
          expect((result as ProblematicValue).error).toMatch(/forbidden key/);
        });

        it("round-trips a payload with a nested schema value", () => {
          const link = new FabricLink({
            id: "fid1:abc",
            schema: { type: "object" },
          });
          const decoded = codec.decode(
            expectedTag,
            codec.encode(link, env),
            env,
          ) as FabricLink;
          expect(decoded).toBeInstanceOf(FabricLink);
          expect(decoded.payload).toEqual(link.payload);
        });
      });
    });
  });

  describe("round-trip via `jsonFromFabricValue()` / `fabricFromJsonValue()`", () => {
    // Free functions exercising `FabricLink` rather than members of the class
    // itself, so they live directly under the class `describe()`.

    it("round-trips a `FabricLink`, including a nested schema", () => {
      const original = new FabricLink({
        id: "fid1:abc",
        path: ["a", "b"],
        schema: { type: "object", properties: { x: { type: "number" } } },
      });
      const restored = fabricFromJsonValue(
        jsonFromFabricValue(original),
      ) as FabricLink;
      expect(restored).toBeInstanceOf(FabricLink);
      expect(restored.payload).toEqual(original.payload);
    });
  });

  describe("hashOf()", () => {
    it("produces a 32-byte (SHA-256) hash via the generic instance path", () => {
      const hash = hashOf(new FabricLink({ id: "fid1:abc" }));
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it("produces the same hash for equal payloads", () => {
      const h1 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      expect(h1).toEqual(h2);
    });

    it("produces a different hash for a different payload", () => {
      const h1 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricLink({ id: "fid1:xyz" })).bytes;
      expect(h1).not.toEqual(h2);
    });
  });

  describe("generic clone dispatch (nested in a container)", () => {
    // A `FabricLink` nested in a container must clone through the generic
    // `FabricInstance` clone path (no dedicated dispatch case anymore).

    it("deep-clones a container holding one without throwing", () => {
      const link = new FabricLink({ id: "fid1:abc" });
      const cloned = cloneIfNecessary({ link }, { frozen: true });
      expect(isDeepFrozen(cloned)).toBe(true);
      expect(cloned.link).toBeInstanceOf(FabricLink);
      expect((cloned.link as FabricLink).payload).toEqual(link.payload);
    });
  });
});
