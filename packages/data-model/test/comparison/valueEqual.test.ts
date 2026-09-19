/**
 * Content equality across the value kinds, and the subtype question that comes
 * before it.
 *
 * Two values are comparable only once they are the same kind of thing, so a
 * plain object and an array are unequal without their contents being consulted
 * at all. Special values are measured by their canonical type and state,
 * including state held outside enumerable properties.
 *
 * Frozen state must not change a result, which is what the matrix over it is
 * for: equality is about what a value holds, not about whether it can still be
 * written to.
 *
 * Signed zeros and `NaN` get their own group, being where a comparison written
 * with `===` gives a different result: `-0` and `+0` are distinct here though
 * `===` merges them, and `NaN` equals itself though `===` denies it. The
 * infinities sit in that group as the counterweight -- `===` is already correct
 * for those, and so must this, so they pin the absence of an over-correction.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  codecOf,
  NULL_LIVE_ENVIRONMENT,
  UnknownValue,
} from "@/codec-common/index.ts";
import { FabricError } from "@/fabric-instances/index.ts";
import {
  FabricBytes,
  FabricEpochDay,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives/index.ts";
import {
  deepFreeze,
  type FabricValue,
  hashStringOf,
  valueEqual,
} from "@/index.ts";

describe("valueEqual()", () => {
  describe("shared and cyclic graphs", () => {
    it("compares shared descendants once per pair, regardless of freezing", () => {
      for (const frozen of [false, true]) {
        let reads = 0;
        const graph = () => {
          let node: FabricValue = { label: "leaf" };
          for (let depth = 0; depth < 14; depth++) {
            const target: Record<string, FabricValue> = {
              left: node,
              right: node,
            };
            node = new Proxy(frozen ? Object.freeze(target) : target, {
              get(target, key, receiver) {
                if (key === "left" || key === "right") {
                  if (++reads > 1_000) {
                    throw new Error(
                      "The comparison expanded the shared graph.",
                    );
                  }
                }
                return Reflect.get(target, key, receiver);
              },
            });
          }
          return node;
        };

        expect(valueEqual(graph(), graph())).toBe(true);
        expect(reads).toBeLessThanOrEqual(4 * 14);
      }
    });

    it("leaves an identical descendant unread", () => {
      const shared = new Proxy({}, {
        ownKeys() {
          throw new Error("An unchanged descendant was enumerated.");
        },
      });

      expect(valueEqual({ shared }, { shared })).toBe(true);
    });

    it("compares deep containers without consuming the JavaScript stack", () => {
      let left: FabricValue = "leaf";
      let right: FabricValue = "leaf";
      for (let depth = 0; depth < 20_000; depth++) {
        left = { next: left };
        right = { next: right };
      }

      expect(valueEqual(left, right)).toBe(true);
    });

    it("compares cyclic contents and still detects differences after a back edge", () => {
      const left: Record<string, FabricValue> = { label: "same" };
      const right: Record<string, FabricValue> = { label: "same" };
      left.self = left;
      right.self = right;

      expect(valueEqual(left, right)).toBe(true);
      right.label = "different";
      expect(valueEqual(left, right)).toBe(false);
    });

    it("compares a shared object against each distinct counterpart", () => {
      const shared = { value: 1 };
      expect(valueEqual(
        { left: shared, right: shared },
        { left: { value: 1 }, right: { value: 2 } },
      )).toBe(false);
      expect(valueEqual(
        { left: shared, right: shared },
        { left: { value: 1 }, right: { value: 1 } },
      )).toBe(true);
    });

    it("compares cyclic instance state through its codec", () => {
      const leftState: Record<string, FabricValue> = { label: "same" };
      const rightState: Record<string, FabricValue> = { label: "same" };
      const left = new UnknownValue("Node@1", leftState);
      const right = new UnknownValue("Node@1", rightState);
      leftState.self = left;
      rightState.self = right;

      expect(valueEqual(left, right)).toBe(true);
      rightState.label = "different";
      expect(valueEqual(left, right)).toBe(false);
      expect(valueEqual(left, new UnknownValue("Node@2", leftState))).toBe(
        false,
      );
    });

    it("observes mutation between comparisons", () => {
      const left = { child: { value: 1 } };
      const right = { child: { value: 1 } };
      expect(valueEqual(left, right)).toBe(true);
      right.child.value = 2;
      expect(valueEqual(left, right)).toBe(false);
    });

    it("reuses available immutable hashes without reading their contents", () => {
      let reads = 0;
      const graph = () =>
        new Proxy(Object.freeze({ value: "same" }), {
          get(target, key, receiver) {
            if (key === "value") reads++;
            return Reflect.get(target, key, receiver);
          },
        });
      const left = graph();
      const right = graph();
      expect(hashStringOf(left)).toBe(hashStringOf(right));
      reads = 0;

      expect(valueEqual(left, right)).toBe(true);
      expect(reads).toBe(0);
    });
  });

  describe("canonical hash agreement", () => {
    it("preserves UTF-8 replacement and key order before and after caching", () => {
      const pairs: [FabricValue, FabricValue, boolean][] = [
        [{ s: "\ud800" }, { s: "\ufffd" }, true],
        [{ s: Symbol.for("\ud800") }, { s: Symbol.for("\ufffd") }, true],
        [{ "\ud800": 1 }, { "\ufffd": 1 }, true],
        [{ "\ud800": 1, "\ue000": 2 }, { "\ufffd": 1, "\ue000": 2 }, false],
        [
          Object.fromEntries([["\ud800", 1], ["\ud801", 2]]),
          Object.fromEntries([["\ud802", 1], ["\ud803", 2]]),
          true,
        ],
        [
          Object.fromEntries([["\ud800", 1], ["\ud801", 2]]),
          Object.fromEntries([["\ud802", 2], ["\ud803", 1]]),
          false,
        ],
      ];
      for (const [left, right, equal] of pairs) {
        expect(valueEqual(left, right)).toBe(equal);
        expect(hashStringOf(left) === hashStringOf(right)).toBe(equal);
        hashStringOf(deepFreeze(left));
        hashStringOf(deepFreeze(right));
        expect(valueEqual(left, right)).toBe(equal);
      }
      expect(valueEqual("\ud800", "\ufffd")).toBe(false);
      expect(valueEqual(Symbol.for("\ud800"), Symbol.for("\ufffd"))).toBe(
        false,
      );
    });

    it("agrees on primitive, container, and codec content in every cache state", () => {
      const values = (): FabricValue[] => [
        undefined,
        null,
        false,
        true,
        -0,
        0,
        1,
        NaN,
        Infinity,
        -Infinity,
        1n,
        "1",
        Symbol.for("valueEqual"),
        {},
        { value: undefined },
        { a: 1, b: 2 },
        { b: 2, a: 1 },
        [],
        [undefined],
        [,],
        [1, , 3],
        [1, undefined, 3],
        { nested: [{ value: -0 }] },
        { nested: [{ value: 0 }] },
        new FabricBytes(new Uint8Array([1])),
        new FabricBytes(new Uint8Array([2])),
        new FabricRegExp(/a/g),
        new FabricRegExp(/a/i),
        new FabricEpochDay(1n),
        new FabricEpochDay(2n),
        new FabricUnavailable("pending"),
        new FabricUnavailable("syncing"),
        new FabricUnavailable("error", "general", "boom"),
        new FabricUnavailable("error", "network", "boom"),
        new FabricUnavailable("error", "network"),
        new UnknownValue("Node@1", { value: 1 }),
        new UnknownValue("Node@2", { value: 1 }),
        new UnknownValue("Node@1", { value: 2 }),
      ];
      for (const cached of [false, true]) {
        const leftValues = values();
        const rightValues = values();
        if (cached) {
          for (const value of [...leftValues, ...rightValues]) {
            hashStringOf(deepFreeze(value));
          }
        }
        for (const left of leftValues) {
          for (const right of rightValues) {
            const equal = valueEqual(left, right);
            expect(equal).toBe(hashStringOf(left) === hashStringOf(right));
            expect(valueEqual({ nested: left }, { nested: right })).toBe(equal);
          }
        }
      }
    });

    it("compares an instance with its preserved wire form consistently", () => {
      const error = FabricError.fromNativeError(new Error("same"));
      const codec = codecOf(error);
      const preserved = new UnknownValue(
        codec.tagForValue(error),
        codec.encode(error, NULL_LIVE_ENVIRONMENT),
      );

      expect(valueEqual(error, preserved)).toBe(true);
      expect(valueEqual({ error }, { error: preserved })).toBe(true);
      expect(hashStringOf(error)).toBe(hashStringOf(preserved));
      hashStringOf(deepFreeze(error));
      hashStringOf(deepFreeze(preserved));
      expect(valueEqual(error, preserved)).toBe(true);
    });
  });

  it("returns `true` for equal primitives", () => {
    expect(valueEqual(1, 1)).toBe(true);
    expect(valueEqual("a", "a")).toBe(true);
    expect(valueEqual(true, true)).toBe(true);
    expect(valueEqual(null, null)).toBe(true);
    expect(valueEqual(undefined, undefined)).toBe(true);
  });

  it("returns `false` for differing primitives", () => {
    expect(valueEqual(1, 2)).toBe(false);
    expect(valueEqual("a", "b")).toBe(false);
    expect(valueEqual(true, false)).toBe(false);
    expect(valueEqual(null, undefined)).toBe(false);
  });

  it("compares `bigint` values", () => {
    expect(valueEqual(42n, 42n)).toBe(true);
    expect(valueEqual(1n, 2n)).toBe(false);
  });

  it("throws when given a function (not a `FabricValue`)", () => {
    // A function is reachable only via an unsound cast; the comparison
    // rejects it rather than quietly returning a wrong result, and does so
    // regardless of which argument is the function. (Distinct values are used
    // so the `Object.is()` fast path doesn't short-circuit before the check.)
    const fn = (() => {}) as unknown as FabricValue;
    const fn2 = (() => {}) as unknown as FabricValue;
    expect(() => valueEqual(fn, fn2)).toThrow();
    expect(() => valueEqual(fn, 1)).toThrow();
    expect(() => valueEqual(fn, { a: 1 })).toThrow();
    // The function on the right (`b`) is rejected symmetrically.
    expect(() => valueEqual({ a: 1 }, fn)).toThrow();
  });

  it("rejects distinct functions reached through containers", () => {
    const fn = (() => 1) as unknown as FabricValue;
    const other = (() => 1) as unknown as FabricValue;
    for (const [left, right] of [[fn, other], [fn, 1], [1, fn]]) {
      expect(() => valueEqual({ nested: [left] }, { nested: [right] }))
        .toThrow("Cannot compare a function value.");
    }
  });

  it("throws when given a non-record object (not a `FabricValue`)", () => {
    // A non-array, non-plain object (a `Date`, `Map`, or other class
    // instance) is reachable only via an unsound cast; reject it rather than
    // treat it as an empty record.
    const date = new Date() as unknown as FabricValue;
    const map = new Map() as unknown as FabricValue;
    expect(() => valueEqual(date, { a: 1 })).toThrow();
    expect(() => valueEqual({ a: 1 }, date)).toThrow();
    expect(() => valueEqual(map, {})).toThrow();
  });

  it("returns `true` for structurally-equal objects", () => {
    expect(valueEqual({ a: 1, b: "two" }, { a: 1, b: "two" })).toBe(true);
  });

  it("returns `false` for objects that differ in a value or key", () => {
    expect(valueEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(valueEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("returns `true` for structurally-equal arrays", () => {
    expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns `false` for arrays that differ in length or element", () => {
    expect(valueEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(valueEqual([1, 2, 3], [1, 9, 3])).toBe(false);
  });

  it("compares nested structures deeply", () => {
    expect(valueEqual({ x: { y: [1, 2] } }, { x: { y: [1, 2] } })).toBe(true);
    expect(valueEqual({ x: { y: [1, 2] } }, { x: { y: [1, 3] } })).toBe(
      false,
    );
  });

  it("returns `false` across mismatched shapes", () => {
    expect(valueEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(valueEqual([1, 2], 5)).toBe(false); // array vs primitive
    expect(valueEqual({ a: 1 }, 5)).toBe(false); // object vs primitive
    expect(valueEqual({ a: 1 }, null)).toBe(false); // object vs null
    expect(valueEqual([1, 2], null)).toBe(false); // array vs null
  });

  it("distinguishes object key count and present-undefined vs absent", () => {
    expect(valueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valueEqual({ a: undefined }, {})).toBe(false);
    expect(valueEqual({ a: undefined }, { a: undefined })).toBe(true);
  });

  it("distinguishes an array hole from a stored `undefined`", () => {
    expect(valueEqual([1, , 3], [1, undefined, 3])).toBe(false);
    expect(valueEqual([1, , 3], [1, , 3])).toBe(true);
  });

  describe("non-finite and signed-zero values", () => {
    // Value equality follows `Object.is()`: `-0` and `+0` are distinct, all
    // `NaN`s are equal, and the two infinities are distinct (spec §6.7).
    //
    // Primitive distinctions must survive nesting, including when immutable
    // containers already have hashes available for comparison.
    //
    // Each assertion below is on a boolean, so the matcher never has to tell
    // `-0` from `+0` itself -- the weird number is always an input, and it is
    // the implementation's comparison that decides the result.

    it("holds `-0` distinct from `+0` at the top level", () => {
      expect(valueEqual(-0, 0)).toBe(false);
      expect(valueEqual(0, -0)).toBe(false);
      expect(valueEqual(-0, -0)).toBe(true);
      expect(valueEqual(0, 0)).toBe(true);
    });

    it("holds `NaN` equal to itself at the top level", () => {
      expect(valueEqual(NaN, NaN)).toBe(true);
      expect(valueEqual(NaN, 0)).toBe(false);
      expect(valueEqual(NaN, Infinity)).toBe(false);
    });

    it("holds the infinities distinct at the top level", () => {
      expect(valueEqual(Infinity, Infinity)).toBe(true);
      expect(valueEqual(-Infinity, -Infinity)).toBe(true);
      expect(valueEqual(Infinity, -Infinity)).toBe(false);
    });

    it("holds `-0` distinct from `+0` inside an object", () => {
      expect(valueEqual({ a: -0 }, { a: 0 })).toBe(false);
      expect(valueEqual({ a: -0 }, { a: -0 })).toBe(true);
      expect(valueEqual({ a: 0 }, { a: 0 })).toBe(true);
    });

    it("holds `-0` distinct from `+0` inside an array", () => {
      expect(valueEqual([-0], [0])).toBe(false);
      expect(valueEqual([-0], [-0])).toBe(true);
    });

    it("holds `-0` distinct from `+0` when deeply nested", () => {
      expect(valueEqual({ a: { b: [-0] } }, { a: { b: [0] } })).toBe(false);
      expect(valueEqual({ a: { b: [-0] } }, { a: { b: [-0] } })).toBe(true);
    });

    it("holds `NaN` equal to itself inside a container", () => {
      expect(valueEqual({ a: NaN }, { a: NaN })).toBe(true);
      expect(valueEqual([NaN], [NaN])).toBe(true);
      expect(valueEqual({ a: { b: [NaN] } }, { a: { b: [NaN] } })).toBe(true);
    });

    it("holds distinct `NaN` payloads equal inside a container", () => {
      // Distinct NaN payloads represent the same logical value. A typed-array
      // view supplies a payload that ordinary arithmetic does not produce.

      const buffer = new ArrayBuffer(8);
      const bytes = new Uint8Array(buffer);
      const doubles = new Float64Array(buffer);
      bytes.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x7f]);
      const payloadNan = doubles[0];

      // Guard the premise: if this stops holding, the cases below compare a
      // value against itself and should fail rather than pass for free.
      doubles[0] = NaN;
      expect(Number.isNaN(payloadNan)).toBe(true);
      expect(bytes[0]).not.toBe(0x01);

      expect(valueEqual({ a: payloadNan }, { a: NaN })).toBe(true);
      expect(valueEqual([payloadNan], [NaN])).toBe(true);
      expect(valueEqual({ a: { b: [payloadNan] } }, { a: { b: [NaN] } }))
        .toBe(true);
    });

    it("holds the infinities distinct inside a container", () => {
      expect(valueEqual({ a: Infinity }, { a: -Infinity })).toBe(false);
      expect(valueEqual([Infinity], [Infinity])).toBe(true);
      expect(valueEqual({ a: Infinity }, { a: NaN })).toBe(false);
    });
  });

  describe("FabricSpecialObject values (CT-1770)", () => {
    // CT-1770: FabricPrimitives keep their state in private fields, so a
    // generic enumerable-own-prop comparison (`deepEqual`) conflates every
    // distinct same-class instance. `valueEqual` compares them by content.

    it("distinguishes FabricBytes by content", () => {
      const a = new FabricBytes(new Uint8Array([1, 2, 3, 4]));
      const b = new FabricBytes(new Uint8Array([9, 8, 7, 6]));
      expect(valueEqual(a, b)).toBe(false);
      expect(valueEqual(a, new FabricBytes(new Uint8Array([1, 2, 3, 4]))))
        .toBe(true);
    });

    it("distinguishes FabricRegExp and FabricEpochDay by content", () => {
      expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/b/g)))
        .toBe(false);
      expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/a/g)))
        .toBe(true);
      expect(valueEqual(new FabricEpochDay(1n), new FabricEpochDay(2n)))
        .toBe(false);
    });

    it("distinguishes a FabricPrimitive nested inside a plain container", () => {
      const wrap = (bytes: number[]) => ({
        v: [new FabricBytes(new Uint8Array(bytes))],
      });
      expect(valueEqual(wrap([1, 2]), wrap([3, 4]))).toBe(false);
      expect(valueEqual(wrap([1, 2]), wrap([1, 2]))).toBe(true);
    });

    describe("given a special object and a plain value", () => {
      it("returns `false`", () => {
        expect(valueEqual(new FabricBytes(new Uint8Array([1])), { 0: 1 }))
          .toBe(false);
        expect(valueEqual(new FabricBytes(new Uint8Array([])), {}))
          .toBe(false);
      });
    });

    describe("given two non-deep-frozen special objects of different classes", () => {
      it("short-circuits to unequal without hashing", () => {
        // An instance and a primitive have distinct canonical representations.
        const u = new UnknownValue("Tag@1", 1);
        const fb = new FabricBytes(new Uint8Array([1]));
        expect(valueEqual(u, fb)).toBe(false);
        expect(valueEqual(fb, u)).toBe(false);
      });
    });
  });

  describe("frozen-state matrix", () => {
    // Every pairing must agree regardless of whether either container is
    // deep-frozen (DF), shallow-frozen (F), or unfrozen (U).

    // The nested array keeps the shallow-frozen `F` build genuinely
    // not-deep-frozen (an all-primitive shallow freeze reads as deep-frozen).
    const equalShape = () => ({ a: 1, b: [2, 3] });
    const unequalShape = () => ({ a: 1, b: [2, 4] });

    const states: Record<"DF" | "F" | "U", (v: FabricValue) => FabricValue> = {
      DF: (v) => deepFreeze(v),
      F: (v) => Object.freeze(v),
      U: (v) => v,
    };
    const pairings: ["DF" | "F" | "U", "DF" | "F" | "U"][] = [
      ["DF", "DF"],
      ["DF", "F"],
      ["DF", "U"],
      ["F", "F"],
      ["F", "U"],
      ["U", "U"],
    ];

    for (const [sa, sb] of pairings) {
      it(`compares ${sa}/${sb} by content (equal -> true)`, () => {
        const a = states[sa](equalShape());
        const b = states[sb](equalShape());
        expect(valueEqual(a, b)).toBe(true);
      });

      it(`compares ${sa}/${sb} by content (unequal -> false)`, () => {
        const a = states[sa](equalShape());
        const b = states[sb](unequalShape());
        expect(valueEqual(a, b)).toBe(false);
      });
    }
  });

  describe("object-subtype-check branch", () => {
    // Different container kinds are unequal without reading their contents.

    describe("given a plain object and an array", () => {
      it("returns `false`", () => {
        expect(valueEqual({ 0: 1, 1: 2 }, [1, 2])).toBe(false);
        expect(valueEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
      });
    });

    describe("given a Fabric* value and a plain object or array", () => {
      it("returns `false`", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2]));
        expect(valueEqual(fb, { 0: 1, 1: 2 })).toBe(false);
        expect(valueEqual({ 0: 1, 1: 2 }, fb)).toBe(false);
        expect(valueEqual(fb, [1, 2])).toBe(false);
        expect(valueEqual([1, 2], fb)).toBe(false);
      });
    });

    describe("given two same-subtype Fabric* values", () => {
      it("compares them by content", () => {
        // Same subtype falls through to the hash compare.
        expect(
          valueEqual(
            new FabricBytes(new Uint8Array([1, 2])),
            new FabricBytes(new Uint8Array([1, 2])),
          ),
        ).toBe(true);
        expect(
          valueEqual(
            new FabricBytes(new Uint8Array([1, 2])),
            new FabricBytes(new Uint8Array([3, 4])),
          ),
        ).toBe(false);
        expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/a/g)))
          .toBe(true);
        expect(valueEqual(new FabricEpochDay(7n), new FabricEpochDay(7n)))
          .toBe(true);
        expect(
          valueEqual(
            new FabricUnavailable("error", "general", "boom"),
            new FabricUnavailable("error", "general", "boom"),
          ),
        ).toBe(true);
        expect(
          valueEqual(
            new FabricUnavailable("pending"),
            new FabricUnavailable("syncing"),
          ),
        ).toBe(false);
      });
    });

    describe("given two distinct `FabricPrimitive` subtypes", () => {
      it("returns `false`", () => {
        expect(
          valueEqual(
            new FabricBytes(new Uint8Array([1])),
            new FabricRegExp(/a/),
          ),
        )
          .toBe(false);
        expect(valueEqual(new FabricEpochDay(1n), new FabricRegExp(/a/)))
          .toBe(false);
      });
    });

    describe("given two distinct mutable `FabricInstance`s of different concrete classes", () => {
      it("returns `false`", () => {
        expect(
          valueEqual(
            FabricError.fromNativeError(new Error("eek")),
            new UnknownValue("Unknownie@123", null),
          ),
        )
          .toBe(false);
      });
    });

    describe("given non-equal mutable `FabricInstance`s of the same concrete class", () => {
      it("returns `false`", () => {
        expect(
          valueEqual(
            new UnknownValue("Unknownie@123", "yes"),
            new UnknownValue("Unknownie@123", ["no"]),
          ),
        )
          .toBe(false);
      });
    });

    describe("given equal mutable `FabricInstance`s of the same concrete class", () => {
      it("returns `true`", () => {
        expect(
          valueEqual(
            new UnknownValue("Unknownie@123", "yeppers"),
            new UnknownValue("Unknownie@123", "yeppers"),
          ),
        )
          .toBe(true);
      });
    });

    describe("given two same-subtype plain containers", () => {
      it("compares them by content", () => {
        expect(valueEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
        expect(valueEqual({ a: 1, b: 2 }, { a: 1, b: 9 })).toBe(false);
        expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        expect(valueEqual([1, 2, 3], [1, 2, 9])).toBe(false);
      });
    });
  });
});
