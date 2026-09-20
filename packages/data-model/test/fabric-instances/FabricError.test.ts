/**
 * `Error` as a `FabricValue`, where most of the difficulty is that a JS
 * error carries two names and arbitrary extra properties.
 *
 * `type` and `name` are stored separately, and the encoding leans on their
 * usual agreement: `name` is written as `null` when it matches `type`, and
 * written out only when it does not. Decoding has to invert that, rebuild the
 * right `Error` subclass from `type`, and still accept older state in which
 * only `name` was present.
 *
 * Everything beyond the fixed slots goes to the extras bag, which is where the
 * refusals concentrate. A slot's own name cannot be used as an extras key, and
 * a prototype-reaching key is refused on the way in and dropped again when it
 * arrives from the wire -- state parsed from outside cannot be assumed to have
 * been built by this code.
 *
 * One case records a gap rather than a guarantee: a mutable deep clone still
 * shares its nested `cause`, and the assertion states that as the behavior
 * today.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  deepFreeze,
  FabricInstance,
  type FabricValue,
  isDeepFrozen,
  isValidDeepFrozenFabricValue,
} from "@";
import { CODEC, CODEC_TYPE_TAGS, NULL_LIVE_ENVIRONMENT } from "@/codec-common";
import { DEEP_FREEZE, IS_DEEP_FROZEN } from "@/fabric-bases";
import { FabricError, FabricNativeWrapper } from "@/fabric-instances";
import { FabricEpochNsec } from "@/fabric-primitives";
import { dummyEnv, subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricError", () => {
  // Pure type-identity / supertype checks: they don't fit a single member and
  // aren't about construction mechanics, so they live directly under the class
  // `describe()` (the rule's cross-cutting carve-out).

  it("implements `FabricInstance`", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricInstance).toBe(true);
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const se = FabricError.fromNativeError(new Error("test"));
    expect(se instanceof FabricNativeWrapper).toBe(true);
  });

  it("has no own properties", () => {
    // The `FabricInstance` contract, checked on the state-heaviest of the
    // concrete classes: an own property here would leak into any structural
    // view of the instance (spread, `Object.keys()`, a debug rendering).

    const se = FabricError.fromNativeError(new Error("test"));
    se.setExtra("extra", 1);
    expect(Object.getOwnPropertyNames(se)).toEqual([]);
    expect({ ...se }).toEqual({});
  });

  describe("`fromNativeError()` reads the class from the prototype", () => {
    // The `type` this records is stored, and `errorClassFromType()` rebuilds
    // the error from it on the way back -- so where the name is read from
    // decides which class a value comes back as. An own `constructor` property
    // is ordinary data, and reading it there would let a value pick that class
    // for itself.

    it("ignores an own `constructor` naming another class", () => {
      const error = new Error("boom");
      Object.defineProperty(error, "constructor", {
        value: { name: "RangeError" },
      });
      expect(FabricError.fromNativeError(error).type).toBe("Error");
    });

    it("keeps the real class of a subclass instance", () => {
      expect(FabricError.fromNativeError(new RangeError("r")).type).toBe(
        "RangeError",
      );
    });

    it("ignores a prototype whose `constructor` is not callable", () => {
      // The name has to come from something that could have constructed the
      // value. A `constructor` that is not callable did not, so it names no
      // class, and the value is recorded as the `Error` it still is.

      class Sneaky extends Error {}
      Object.defineProperty(Sneaky.prototype, "constructor", {
        value: { name: "RangeError" },
      });
      expect(FabricError.fromNativeError(new Sneaky("x")).type).toBe("Error");
    });

    it("ignores a prototype whose `constructor` accessor throws", () => {
      // Reading the class is this conversion's business; failing to read it is
      // not the caller's problem, and the accessor's error must not arrive in
      // place of a converted value.

      class Hostile extends Error {}
      Object.defineProperty(Hostile.prototype, "constructor", {
        get() {
          throw new Error("this must not reach the caller");
        },
      });
      expect(FabricError.fromNativeError(new Hostile("x")).type).toBe("Error");
    });

    it("gives a message-less severed-prototype error an empty message", () => {
      // `message` is inherited from `Error.prototype` unless the constructor
      // was given one, so severing the prototype takes it away entirely.
      // `FabricError` declares a `string`.

      const bare = Object.setPrototypeOf(new Error(), null) as Error;
      const converted = FabricError.fromNativeError(bare);
      expect(typeof converted.message).toBe("string");
      expect(converted.message).toBe("");
    });

    it("names a severed-prototype error `Error`", () => {
      // Such a value names no class at all. It is still an error --
      // `Error.isError()` sees it, and the dispatch tags it so -- and the
      // conversion has to produce something rather than fail reading a name.

      const severed = Object.setPrototypeOf(new Error("severed"), null);
      expect(FabricError.fromNativeError(severed).type).toBe("Error");
    });
  });

  describe("constructor()", () => {
    it("wraps the `Error`'s `FabricValue`-shaped state", () => {
      const err = new TypeError("bad");
      const se = FabricError.fromNativeError(err);
      expect(se.type).toBe("TypeError");
      expect(se.name).toBe("TypeError");
      expect(se.message).toBe("bad");
    });
  });

  describe("instance members", () => {
    describe("fixed-schema slots", () => {
      it("reads back each value assigned while unfrozen", () => {
        const se = FabricError.fromNativeError(new Error("orig"));
        se.type = "RangeError";
        se.name = "Renamed";
        se.message = "changed";
        se.stack = "at nowhere";
        se.cause = { detail: 1 };
        expect(se.type).toBe("RangeError");
        expect(se.name).toBe("Renamed");
        expect(se.message).toBe("changed");
        expect(se.stack).toBe("at nowhere");
        expect(se.cause).toEqual({ detail: 1 });
        // The JS projection reflects the mutated state (no stale cache).
        expect(se.toNativeValue(true).message).toBe("changed");
      });

      it("throws on assignment to any slot once frozen", () => {
        const se = FabricError.fromNativeError(new Error("orig"));
        se.stack = "at nowhere";
        se.cause = { detail: 1 };
        Object.freeze(se);

        const assignments: Array<() => void> = [
          () => se.type = "nope",
          () => se.name = "nope",
          () => se.message = "nope",
          () => se.stack = "nope",
          () => se.cause = "nope",
        ];
        for (const assign of assignments) {
          expect(assign).toThrow("Cannot modify frozen `FabricError`");
        }

        expect(se.type).toBe("Error");
        expect(se.name).toBe("Error");
        expect(se.message).toBe("orig");
        expect(se.stack).toBe("at nowhere");
        expect(se.cause).toEqual({ detail: 1 });
      });
    });

    describe("`[CODEC]` `encode()` state", () => {
      const env = NULL_LIVE_ENVIRONMENT;

      it("returns `type`, `name=null` (common case), `message`, `stack`", () => {
        const se = FabricError.fromNativeError(new Error("hello"));
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("Error");
        expect(state.name).toBe(null);
        expect(state.message).toBe("hello");
        expect(typeof state.stack).toBe("string");
      });

      it("sets `name` to `null` when `type === name` (`TypeError`)", () => {
        const se = FabricError.fromNativeError(new TypeError("bad"));
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe(null);
      });

      it("sets `name` non-null when `type !== name`", () => {
        const err = new TypeError("bad");
        err.name = "CustomName";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe("CustomName");
      });

      it("includes cause when present", () => {
        const inner = FabricError.fromNativeError(new Error("inner"));
        const outer = FabricError.fromNativeError(
          new Error("outer", { cause: inner }),
        );
        const state = FabricError[CODEC].encode(outer, env) as Record<
          string,
          FabricValue
        >;
        expect(state.cause).toBe(inner);
      });

      it("includes custom enumerable properties", () => {
        const err = new Error("oops");
        (err as unknown as Record<string, unknown>).code = 42;
        (err as unknown as Record<string, unknown>).detail = "more info";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.code).toBe(42);
        expect(state.detail).toBe("more info");
      });

      it("does not copy __proto__ or constructor keys", () => {
        const err = new Error("test");
        Object.defineProperty(err, "__proto__", {
          value: "bad",
          enumerable: true,
        });
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(Object.hasOwn(state, "__proto__")).toBe(false);
      });

      it("does not let custom props override built-in fields", () => {
        const err = new Error("original");
        // Manually set an enumerable "message" property -- should not override
        Object.defineProperty(err, "message", {
          value: "original",
          enumerable: true,
        });
        (err as unknown as Record<string, unknown>).name = "Error";
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.message).toBe("original");
      });

      it("omits `stack` when it is `undefined`", () => {
        const err = new Error("no stack");
        // The same `[[Set]]` as `err.stack = undefined`, which
        // `exactOptionalPropertyTypes` refuses on an optional `string`.
        Object.assign(err, { stack: undefined });
        const se = FabricError.fromNativeError(err);
        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect("stack" in state).toBe(false);
      });

      it("round-trips through `[CODEC]` `encode()` and `decode()`", () => {
        const original = new Error("round trip");
        original.name = "CustomError";
        (original as unknown as Record<string, unknown>).code = 42;
        const se = FabricError.fromNativeError(original);

        const state = FabricError[CODEC].encode(se, env);
        const restored = FabricError[CODEC].decode(
          CODEC_TYPE_TAGS.Error,
          state,
          dummyEnv,
        ) as unknown as FabricError;

        expect(restored.name).toBe("CustomError");
        expect(restored.message).toBe("round trip");
        expect(restored.getExtra("code")).toBe(42);
      });

      it("round-trips a `TypeError` with overridden `name`", () => {
        const original = new TypeError("bad value");
        original.name = "SpecialType";
        const se = FabricError.fromNativeError(original);

        const state = FabricError[CODEC].encode(se, env) as Record<
          string,
          FabricValue
        >;
        expect(state.type).toBe("TypeError");
        expect(state.name).toBe("SpecialType");

        const restored = FabricError[CODEC].decode(
          CODEC_TYPE_TAGS.Error,
          state,
          dummyEnv,
        ) as unknown as FabricError;
        expect(restored.toNativeValue(true)).toBeInstanceOf(TypeError);
        expect(restored.name).toBe("SpecialType");
      });
    });

    describe("extras bag", () => {
      it("round-trips a value through `setExtra()` / `getExtra()`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("code", 404);
        expect(fe.getExtra("code")).toBe(404);
      });

      it("returns `undefined` from `getExtra()` for an absent key", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(fe.getExtra("nope")).toBe(undefined);
      });

      it("reports presence via `hasExtra()`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("code", 404);
        expect(fe.hasExtra("code")).toBe(true);
        expect(fe.hasExtra("other")).toBe(false);
      });

      it("reports the entry count via `extraSize`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(fe.extraSize).toBe(0);
        fe.setExtra("a", 1);
        fe.setExtra("b", 2);
        expect(fe.extraSize).toBe(2);
      });

      it("overwrites rather than duplicates an existing key", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("a", 1);
        fe.setExtra("a", 2);
        expect(fe.getExtra("a")).toBe(2);
        expect(fe.extraSize).toBe(1);
      });

      it("enumerates keys and entries", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("a", 1);
        fe.setExtra("b", 2);
        expect([...fe.extraKeys()]).toEqual(["a", "b"]);
        expect([...fe.extraEntries()]).toEqual([["a", 1], ["b", 2]]);
      });

      it("reports removal success via `deleteExtra()`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("a", 1);
        expect(fe.deleteExtra("a")).toBe(true);
        expect(fe.hasExtra("a")).toBe(false);
        expect(fe.deleteExtra("a")).toBe(false);
      });

      it("throws given a fixed-schema slot name as an extras key", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        for (const key of ["type", "name", "message", "stack", "cause"]) {
          expect(() => fe.setExtra(key, 1)).toThrow(
            `Cannot use fixed-schema slot name in \`FabricError\` extras: \`${key}\``,
          );
        }
      });

      it("throws given a prototype-sensitive extras key", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        for (const key of ["__proto__", "constructor"]) {
          expect(() => fe.setExtra(key, 1)).toThrow(
            `Cannot use unsafe key in \`FabricError\` extras: \`${key}\``,
          );
        }
        expect(fe.extraSize).toBe(0);
      });

      it("refuses mutation once frozen", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("a", 1);
        Object.freeze(fe);

        expect(() => fe.setExtra("b", 2)).toThrow(
          "Cannot modify frozen `FabricError`",
        );
        expect(() => fe.deleteExtra("a")).toThrow(
          "Cannot modify frozen `FabricError`",
        );
        expect(fe.getExtra("a")).toBe(1);
        expect(fe.extraSize).toBe(1);
      });

      it("drops unsafe and reserved keys supplied to the constructor", () => {
        // The constructor filters its `extras` input independently of the
        // codec, which filters again on the way in. Both layers matter: extras
        // carry whatever the wire supplied, and the constructor is public.

        const fe = new FabricError({
          type: "Error",
          name: "Error",
          message: "m",
          stack: undefined,
          cause: undefined,
          extras: [
            ["__proto__", "bad"],
            ["constructor", "bad"],
            ["type", "bad"],
            ["message", "bad"],
            ["kept", 1],
          ] as Array<[string, FabricValue]>,
        });

        expect([...fe.extraKeys()]).toEqual(["kept"]);
        expect(fe.message).toBe("m");
      });

      it("still reads while frozen", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        fe.setExtra("a", 1);
        Object.freeze(fe);

        expect(fe.getExtra("a")).toBe(1);
        expect(fe.hasExtra("a")).toBe(true);
        expect([...fe.extraKeys()]).toEqual(["a"]);
      });
    });

    describe("toNativeValue()", () => {
      it("returns a frozen `Error` projection when `frozen` is `true`", () => {
        const err = new Error("native");
        const se = FabricError.fromNativeError(err);
        const result = se.toNativeValue(true);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("native");
        expect(Object.isFrozen(result)).toBe(true);
        // The originating JS `Error` is not stored / not mutated.
        expect(Object.isFrozen(err)).toBe(false);
      });

      it("caches the projection once frozen", () => {
        const se = FabricError.fromNativeError(new Error("native"));
        // While mutable, repeated calls rebuild (no stale cache risk).
        expect(se.toNativeValue(true)).not.toBe(se.toNativeValue(true));
        // Once frozen, the projection is cached and returned by identity.
        Object.freeze(se);
        const a = se.toNativeValue(true);
        const b = se.toNativeValue(true);
        expect(a).toBe(b);
        expect(Object.isFrozen(a)).toBe(true);
      });

      it("returns a fresh unfrozen `Error` projection when `frozen` is `false`", () => {
        const se = FabricError.fromNativeError(new Error("native"));
        const result = se.toNativeValue(false);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe("native");
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("returns a fresh copy each call when `frozen` is `false`", () => {
        const se = FabricError.fromNativeError(new Error("native"));
        const a = se.toNativeValue(false);
        const b = se.toNativeValue(false);
        expect(a).not.toBe(b);
        expect(a.message).toBe(b.message);
      });
    });

    describe("[DEEP_FREEZE]", () => {
      describe("via dispatch", () => {
        it("freezes wrapper + recurses cause", () => {
          const inner = FabricError.fromNativeError(new Error("cause"));
          const fe = FabricError.fromNativeError(
            new Error("outer", { cause: inner }),
          );
          const result = deepFreeze(fe);
          expect(result).toBe(fe); // freeze-in-place identity
          expect(Object.isFrozen(fe)).toBe(true);
          expect(isDeepFrozen(inner)).toBe(true);
        });

        it("recurses enumerable custom props (preserved via extras)", () => {
          const err = new Error("e");
          const childObj = { nested: 1 };
          (err as unknown as Record<string, unknown>).custom = childObj;
          const fe = FabricError.fromNativeError(err);
          deepFreeze(fe);
          // Non-string custom state is preserved AND deep-frozen.
          expect(fe.getExtra("custom")).toBe(childObj);
          expect(Object.isFrozen(childObj)).toBe(true);
        });
      });

      describe("via direct member invocation", () => {
        it("freezes wrapper + recurses cause", () => {
          const inner = FabricError.fromNativeError(new Error("cause"));
          const fe = FabricError.fromNativeError(
            new Error("outer", { cause: inner }),
          );
          const result = fe[DEEP_FREEZE](subFreeze);
          expect(result).toBe(fe); // freeze-in-place identity
          expect(Object.isFrozen(fe)).toBe(true);
          expect(isDeepFrozen(inner)).toBe(true);
        });

        it("recurses enumerable custom props (preserved via extras)", () => {
          const err = new Error("e");
          const childObj = { nested: 1 };
          (err as unknown as Record<string, unknown>).custom = childObj;
          const fe = FabricError.fromNativeError(err);
          fe[DEEP_FREEZE](subFreeze);
          // Non-string custom state is preserved AND deep-frozen.
          expect(fe.getExtra("custom")).toBe(childObj);
          expect(Object.isFrozen(childObj)).toBe(true);
        });
      });
    });

    describe("[IS_DEEP_FROZEN]", () => {
      describe("via dispatch", () => {
        it("is `true` only when wrapper + cause are frozen", () => {
          const fe = FabricError.fromNativeError(new Error("test"));
          expect(isValidDeepFrozenFabricValue(fe)).toBe(false);
          Object.freeze(fe); // wrapper only; some descendants still mutable
          // (May be true since this particular FabricError has no nested
          // FabricValue descendants beyond primitive strings.)
          deepFreeze(fe);
          expect(isValidDeepFrozenFabricValue(fe)).toBe(true);
        });
      });

      describe("via direct member invocation", () => {
        it("is `true` only when wrapper is frozen", () => {
          const fe = FabricError.fromNativeError(new Error("test"));
          expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
          fe[DEEP_FREEZE](subFreeze);
          expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });
    });

    describe("deepClone()", () => {
      // `FabricError` inherits the `deepClone()` template from
      // `BaseFabricInstance` and supplies only its `[DEEP_CLONE_CORE]` (a codec
      // round-trip). These cases pin the template contract for this concrete
      // implementor.

      it("returns a deep-frozen clone with equal state", () => {
        const fe = FabricError.fromNativeError(
          new Error("boom", { cause: { detail: 1 } }),
        );
        const clone = fe.deepClone(true) as FabricError;
        expect(clone).not.toBe(fe);
        expect(isDeepFrozen(clone)).toBe(true);
        expect(clone.message).toBe("boom");
        expect(clone.cause).toEqual({ detail: 1 });
      });

      it("identity-returns an already-deep-frozen instance", () => {
        const fe = deepFreeze(FabricError.fromNativeError(new Error("x")));
        expect(fe.deepClone(true)).toBe(fe);
      });

      it("does NOT identity-return a merely-shallowly-frozen instance", () => {
        // Frozen wrapper, but a still-mutable nested `cause`: not deep-frozen,
        // so the deep-clone identity gate must allocate rather than alias.

        const fe = FabricError.fromNativeError(new Error("outer"));
        fe.cause = { detail: 1 }; // mutable nested FabricValue
        Object.freeze(fe); // shallow freeze only
        expect(Object.isFrozen(fe)).toBe(true);
        expect(isDeepFrozen(fe)).toBe(false);
        expect(fe.deepClone(true)).not.toBe(fe);
      });

      it("returns a distinct, mutable clone with equal state", () => {
        const fe = FabricError.fromNativeError(
          new Error("outer", { cause: { detail: 1 } }),
        );
        const clone = fe.deepClone(false) as FabricError;
        expect(clone).not.toBe(fe);
        expect(Object.isFrozen(clone)).toBe(false);
        expect(clone.message).toBe("outer");
        expect(clone.cause).toEqual({ detail: 1 });
        // The top-level instance is independent: reassigning a slot on the
        // clone does not write through to the original.
        clone.message = "changed";
        expect(fe.message).toBe("outer");
      });

      it("returns a mutable clone that currently SHARES the nested `cause` reference (known gap)", () => {
        // KNOWN GAP (pre-existing): the clone core round-trips through
        // `[CODEC]`, whose `encode()` passes `cause` (and extras) through by
        // reference, so an *unfrozen* deep clone still shares its nested
        // `cause` with the original -- contrary to the `deepClone(false)`
        // contract on `FabricInstance`. Pinned to record the actual behavior,
        // not to bless it.

        const cause = { detail: 1 };
        const fe = FabricError.fromNativeError(new Error("outer", { cause }));
        const clone = fe.deepClone(false) as FabricError;
        expect(clone.cause).toBe(cause);
      });
    });
  });

  describe("static members", () => {
    describe("fromNativeError()", () => {
      it("returns an instance whose `cause` and extras are converted", () => {
        const inner = new Error("inner");
        const outer = Object.assign(new Error("outer", { cause: inner }), {
          when: new Date(0),
        });
        const fe = FabricError.fromNativeError(outer);
        expect(fe.cause).toBeInstanceOf(FabricError);
        expect((fe.cause as FabricError).message).toBe("inner");
        expect(fe.getExtra("when")).toBeInstanceOf(FabricEpochNsec);
      });

      it("returns an unfrozen instance", () => {
        const fe = FabricError.fromNativeError(new Error("mutable"));
        expect(Object.isFrozen(fe)).toBe(false);
      });

      it("returns `cause` and the extras as `options.convert` returns them", () => {
        const cause = new Error("kept");
        const error = Object.assign(new Error("outer", { cause }), { n: 1 });
        const fe = FabricError.fromNativeError(error, {
          convert: (value) => (value === cause) ? "was cause" : "was extra",
        });
        expect(fe.cause).toBe("was cause");
        expect(fe.getExtra("n")).toBe("was extra");
      });

      it("throws given an extra that cannot be converted", () => {
        const error = Object.assign(new Error("bad"), { fn: () => 1 });
        expect(() => FabricError.fromNativeError(error)).toThrow();
      });

      it("throws given a cycle through `cause`", () => {
        const error = new Error("loop") as Error & { cause: unknown };
        error.cause = { back: error };
        expect(() => FabricError.fromNativeError(error))
          .toThrow("circular reference");
      });
    });

    describe("[CODEC]", () => {
      const codec = FabricError[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Error;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Error` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricError`, rejecting other values", () => {
          expect(codec.canEncode(FabricError.fromNativeError(new Error("x"))))
            .toBe(true);
          expect(codec.canEncode("not an error")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes a basic `FabricError` to its `{ type, name, message }` state", () => {
          const se = FabricError.fromNativeError(new Error("test"));
          const state = codec.encode(se, env) as Record<string, unknown>;
          expect(state.type).toBe("Error");
          expect(state.name).toBe(null); // null = same as type (common case)
          expect(state.message).toBe("test");
        });

        it("encodes `name: null` when `name` matches `type` (`TypeError`)", () => {
          // TypeError: name === constructor.name === "TypeError".

          const se = FabricError.fromNativeError(new TypeError("type check"));
          const state = codec.encode(se, env) as Record<string, unknown>;
          expect(state.type).toBe("TypeError");
          expect(state.name).toBe(null); // null = same as type
          expect(state.message).toBe("type check");
        });

        it("encodes an explicit `name` when `name` differs from `type`", () => {
          const err = new Error("custom");
          err.name = "MyCustomError";
          const se = FabricError.fromNativeError(err);
          const state = codec.encode(se, env) as Record<string, unknown>;
          expect(state.type).toBe("Error");
          expect(state.name).toBe("MyCustomError");
          expect(state.message).toBe("custom");
        });
      });

      describe("canDecode()", () => {
        // Decoding hand-built state (not via `encode()`): exercises name/type
        // handling and back-compat that the round-trip tests don't.

        it("returns `true` for a record", () => {
          expect(codec.canDecode({ type: "Error", message: "boop" }))
            .toBe(true);
        });

        it("returns `true` for a record with every checked field absent", () => {
          expect(codec.canDecode({})).toBe(true);
          expect(codec.canDecode({ cause: 42, code: 7 })).toBe(true);
        });

        it("returns `true` for a `null` `name`, which means same as `type`", () => {
          expect(codec.canDecode({ type: "Error", name: null, message: "" }))
            .toBe(true);
        });

        it("returns `true` for a `name` with no `type` (back-compat)", () => {
          expect(codec.canDecode({ name: "TypeError", message: "old format" }))
            .toBe(true);
        });

        it("returns `false` for a checked field that is not a string", () => {
          // Each of these fields reaches a getter typed `string` unchecked by
          // the constructor, so the predicate is the one place a mistyped one
          // is refused.

          for (const key of ["type", "name", "message", "stack"]) {
            for (const value of [42, true, undefined, ["x"], { x: 1 }]) {
              const state = { type: "Error", message: "boop", [key]: value };
              expect(codec.canDecode(state as never)).toBe(false);
            }
          }
        });

        it("returns `false` for a `null` in a field other than `name`", () => {
          for (const key of ["type", "message", "stack"]) {
            const state = { type: "Error", message: "boop", [key]: null };
            expect(codec.canDecode(state as never)).toBe(false);
          }
        });

        it("returns `false` for state that is not a plain object", () => {
          // Wire state is untrusted input. Without this check these decode
          // into a `FabricError` bearing a default type and an empty message,
          // which is a malformation admitted silently rather than reported.

          for (const state of ["hello", 42, true, null, [1, 2]]) {
            expect(codec.canDecode(state as never)).toBe(false);
          }
        });
      });

      describe("decode()", () => {
        it("drops a `__proto__` key arriving from parsed wire state", () => {
          // `JSON.parse` creates an own `__proto__` property where an object
          // literal instead invokes the setter, so parsed wire state is the one
          // place a prototype-sensitive key genuinely arrives as decodable
          // input.

          const state = JSON.parse(
            '{"type":"Error","message":"x","__proto__":"bad","code":7}',
          );
          expect(Object.hasOwn(state, "__proto__")).toBe(true);

          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;

          expect([...result.extraKeys()]).toEqual(["code"]);
          expect(result.hasExtra("__proto__")).toBe(false);
          expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        });

        it("creates a `FabricError` from state, with `name === null` meaning same as `type`", () => {
          const state = { type: "Error", name: null, message: "hello" };
          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;
          expect(result).toBeInstanceOf(FabricError);
          expect(result.toNativeValue(true)).toBeInstanceOf(Error);
          expect(result.name).toBe("Error");
          expect(result.message).toBe("hello");
        });

        it("creates the correct `Error` subclass from `type` when `name === null`", () => {
          const cases: [string, ErrorConstructor][] = [
            ["TypeError", TypeError],
            ["RangeError", RangeError],
            ["SyntaxError", SyntaxError],
            ["ReferenceError", ReferenceError],
            ["URIError", URIError],
            ["EvalError", EvalError],
          ];
          for (const [type, cls] of cases) {
            const state = { type, name: null, message: "test" };
            const result = codec.decode(
              expectedTag,
              state,
              env,
            ) as unknown as FabricError;
            expect(result.toNativeValue(true)).toBeInstanceOf(cls);
            expect(result.name).toBe(type);
          }
        });

        it("keeps a custom `name` on the `Error` subclass named by `type`", () => {
          const state = {
            type: "TypeError",
            name: "CustomTypeName",
            message: "mismatch",
          };
          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;
          expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(result.name).toBe("CustomTypeName");
        });

        it("falls back to `name` when `type` is absent (back-compat)", () => {
          const state = { name: "TypeError", message: "old format" };
          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;
          expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
        });

        it("returns the custom `name` it decoded", () => {
          const state = { type: "Error", name: "MyCustomError", message: "x" };
          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;
          expect(result.name).toBe("MyCustomError");
        });

        it("restores cause and custom properties", () => {
          const state = {
            type: "Error",
            name: null,
            message: "with extras",
            cause: "something went wrong",
            code: 404,
          };
          const result = codec.decode(
            expectedTag,
            state,
            env,
          ) as unknown as FabricError;
          expect(result.cause).toBe("something went wrong");
          expect(result.getExtra("code")).toBe(404);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips a basic `Error`", () => {
          const se = FabricError.fromNativeError(new Error("hello"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(Error);
          expect(decoded.name).toBe("Error");
          expect(decoded.message).toBe("hello");
        });

        it("round-trips a `TypeError`", () => {
          const se = FabricError.fromNativeError(new TypeError("bad type"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(decoded.name).toBe("TypeError");
          expect(decoded.message).toBe("bad type");
        });

        it("round-trips a `RangeError`", () => {
          const se = FabricError.fromNativeError(
            new RangeError("out of range"),
          );
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded).toBeInstanceOf(FabricError);
          expect(decoded.toNativeValue(true)).toBeInstanceOf(RangeError);
          expect(decoded.name).toBe("RangeError");
        });

        it("round-trips an `Error` with a (pre-converted) cause", () => {
          const inner = FabricError.fromNativeError(new Error("inner"));
          const outer = FabricError.fromNativeError(
            new Error("outer", { cause: inner }),
          );
          const decoded = codec.decode(
            expectedTag,
            codec.encode(outer, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("outer");
          // The cause is a FabricError (the inner wrapper) after round-trip.
          expect(decoded.cause).toBeInstanceOf(FabricError);
          expect((decoded.cause as FabricError).message).toBe("inner");
        });

        it("round-trips an `Error` whose cause is itself a `FabricError`", () => {
          // Simulates what `fabricFromConvertibleJsValue` produces: a
          // FabricError wrapping an Error whose cause is itself a FabricError
          // (not a raw Error). Encoding's recurse on `[CODEC]` `encode()`
          // output must find a FabricValue, not a raw Error.

          const innerSe = FabricError.fromNativeError(new Error("inner"));
          const outerErr = new Error("outer");
          outerErr.cause = innerSe;
          const outerSe = FabricError.fromNativeError(outerErr);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(outerSe, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("outer");
          expect(decoded.cause).toBeInstanceOf(FabricError);
          expect((decoded.cause as FabricError).message).toBe("inner");
        });

        it("round-trips an `Error` with custom properties", () => {
          const err = new Error("oops");
          (err as unknown as Record<string, unknown>).code = 42;
          (err as unknown as Record<string, unknown>).detail = "more info";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.message).toBe("oops");
          const native = decoded.toNativeValue(true) as unknown as Record<
            string,
            unknown
          >;
          expect(native.code).toBe(42);
          expect(native.detail).toBe("more info");
        });

        it("round-trips an `Error` with a custom `name`", () => {
          const err = new Error("custom");
          err.name = "MyCustomError";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.name).toBe("MyCustomError");
          expect(decoded.message).toBe("custom");
        });

        it("round-trips a `TypeError` preserving `name === type` identity", () => {
          const se = FabricError.fromNativeError(new TypeError("rt"));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.toNativeValue(true)).toBeInstanceOf(TypeError);
          expect(decoded.name).toBe("TypeError");
          expect(decoded.toNativeValue(true).constructor.name).toBe(
            "TypeError",
          );
        });

        it("round-trips an `Error` with mismatched `name` and `type`", () => {
          // Error constructor is "Error" but name is overridden.

          const err = new Error("mismatch");
          err.name = "CustomName";
          const se = FabricError.fromNativeError(err);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(se, env),
            env,
          ) as unknown as FabricError;
          expect(decoded.toNativeValue(true)).toBeInstanceOf(Error);
          expect(decoded.name).toBe("CustomName");
          expect(decoded.toNativeValue(true).constructor.name).toBe("Error");
        });
      });
    });
  });
});
