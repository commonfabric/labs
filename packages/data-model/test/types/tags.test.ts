/**
 * The tag vocabulary and each dispatch that answers with it.
 *
 * The fabric-side dispatches take a value already typed as a `FabricValue` or
 * a `FabricPrimitive`, and their cases are about what each declines: a type
 * lie, a class outside the vocabulary, and a primitive whose reported tag is
 * not one the vocabulary holds. One group cross-checks them against the
 * JS-side dispatch over the whole corpus, on the values membership
 * accepts, which is where the two are required to agree.
 *
 * The JS-side cases classify a value by what it actually is, across the
 * cases where the obvious check fails. A prototype can be severed, an `Error`
 * can arrive from another realm or from a subclass nobody here knows, an
 * array can be an `Array` subclass, and an object can have no prototype at
 * all. Each still has a right answer, so these cases are mostly the awkward
 * shapes rather than the ordinary ones.
 *
 * One group pins where the class is read FROM: a value's own `constructor`
 * property is data, and must not be able to present a plain record as an
 * `Error`. Another pins something the classifier deliberately does not do:
 * `toJSON()` has no bearing on what a value is. An object carrying one is
 * still an object and a class instance carrying one is still unrecognized,
 * whether the member is own or inherited.
 *
 * The plus cases hold an `isPlusType` predicate to its place in the order:
 * consulted only for a value no earlier question decides, never for one the
 * vocabulary already names, and fixing the `PlusType` in the type system.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JsTypeTagIncludingNull, Same } from "@commonfabric/utils/types";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  type ConvertibleJsValueTag,
  FABRIC_CONTAINER_VALUE_TAGS,
  FABRIC_VALUE_PLUS_TAGS,
  FABRIC_VALUE_TAGS,
  type FabricContainerValueTag,
  FabricPrimitive,
  type FabricValue,
  type FabricValuePlus,
  type FabricValuePlusLayer,
  type FabricValuePlusTag,
  type FabricValueTag,
  isFabricContainerValueTag,
  isValidFabricConvertibleJsObject,
  isValidFabricValueLayer,
  JS_PRIMITIVE_TYPE_VALUE_TAGS,
  JS_TYPE_VALUE_TAGS,
  type JsPrimitiveTypeValueTag,
  type JsTypeValueTag,
  type PlusTypePredicate,
  type PrimitiveValueTag,
  tagOfConvertibleJsValueElseNull,
  tagOfFabricPrimitive,
  tagOfFabricPrimitiveElseNull,
  tagOfFabricValue,
  tagOfFabricValueElseNull,
  VALUE_TAGS,
  type ValueTag,
} from "@";
import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { FabricError, FabricMap } from "@/fabric-instances";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  type FabricPrimitiveValueTag,
  FabricRegExp,
  FabricUnavailable,
} from "@/fabric-primitives";
import { FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY } from "@/for-testing-only.ts";
import { LAYER_CORPUS } from "../fabric-value-corpus.ts";

/**
 * A `BaseFabricPrimitive` subclass whose reported tag is one the vocabulary
 * holds, though it is not the class the tag names: the dispatch reads the tag
 * and does not check it against the class.
 */
class TaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricHash;
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/** A `BaseFabricPrimitive` subclass reporting a tag the vocabulary lacks. */
class MistaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return "Bogus" as FabricPrimitiveValueTag;
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/**
 * A `BaseFabricPrimitive` subclass reporting a tag the vocabulary holds but
 * no primitive may report, which the getter's type refuses and a cast lets
 * through.
 */
class NonPrimitiveTagProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return VALUE_TAGS.JsError as FabricPrimitiveValueTag;
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/** A subclass of a production primitive that supplies no tag of its own. */
class SubBytes extends FabricBytes {}

/**
 * A `BaseFabricPrimitive` subclass reporting a name the vocabulary inherits
 * rather than declares, which a `tag in VALUE_TAGS` test would accept.
 */
class InheritedNameProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return "toString" as FabricPrimitiveValueTag;
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/** A `BaseFabricPrimitive` subclass reporting something that is no string. */
class UntaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return undefined as unknown as FabricPrimitiveValueTag;
  }

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/**
 * A direct `FabricPrimitive` subclass, bypassing `BaseFabricPrimitive`, which
 * no production class does.
 */
class RoguePrimitive extends FabricPrimitive {
  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

/** The `PlusType` of the plus cases: a class the vocabulary does not name. */
class PlusProbe {}

/** Predicate for `PlusProbe`. */
const isPlusProbe: PlusTypePredicate<PlusProbe> = (value): value is PlusProbe =>
  value instanceof PlusProbe;

/** A `PlusType` that is a function, which the JS-type branch has to admit. */
type PlusFn = () => void;

/** Predicate for `PlusFn`. */
const isPlusFn: PlusTypePredicate<PlusFn> = (value): value is PlusFn =>
  typeof value === "function";

/**
 * Builds a predicate that records each value it is asked about and accepts
 * it, so a case can assert whether the dispatch consulted it at all.
 */
function recordingPredicate(): {
  readonly asked: unknown[];
  readonly isPlusType: PlusTypePredicate<PlusProbe>;
} {
  const asked: unknown[] = [];

  return {
    asked,
    isPlusType: (value): value is PlusProbe => {
      asked.push(value);
      return true;
    },
  };
}

/** One value of each JS primitive type, labeled, with the tag it takes. */
const JS_PRIMITIVE_TAGS: ReadonlyArray<
  [string, FabricValue, Exclude<JsTypeValueTag, "function">]
> = [
  ["a bigint", 42n, VALUE_TAGS.bigint],
  ["a boolean", true, VALUE_TAGS.boolean],
  ["`null`", null, VALUE_TAGS.null],
  ["a number", 42, VALUE_TAGS.number],
  ["a string", "x", VALUE_TAGS.string],
  ["a symbol", Symbol.for("s"), VALUE_TAGS.symbol],
  ["`undefined`", undefined, VALUE_TAGS.undefined],
];

/**
 * One value of each JS type `typeof` decides, labeled, with the tag it takes:
 * the primitives above, and a function, which is no `FabricValue`.
 */
const JS_TYPE_TAGS: ReadonlyArray<[string, unknown, JsTypeValueTag]> = [
  ...JS_PRIMITIVE_TAGS,
  ["a function", () => {}, VALUE_TAGS.function],
];

/**
 * One instance of each production primitive class, with the tag it carries:
 * the entry `FABRIC_PRIMITIVE_VALUE_TAGS` holds under the class's name.
 */
const FABRIC_PRIMITIVE_TAGS: ReadonlyArray<
  [FabricPrimitive, FabricPrimitiveValueTag]
> = Object.entries(FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY).map((
  [name, [example]],
) => [
  example,
  FABRIC_PRIMITIVE_VALUE_TAGS[name as keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS],
]);

/**
 * One value under each tag the `FabricValue` vocabulary holds, labeled: the
 * values a dispatch names without consulting a predicate.
 */
const RECOGNIZED: ReadonlyArray<[string, FabricValue, FabricValueTag]> = [
  ...JS_PRIMITIVE_TAGS,
  ...FABRIC_PRIMITIVE_TAGS.map((
    [value, tag],
  ): [string, FabricValue, FabricValueTag] => [
    `a \`${value.constructor.name}\``,
    value,
    tag,
  ]),
  ["an array", [1], VALUE_TAGS.Array],
  ["a plain object", { a: 1 }, VALUE_TAGS.Object],
  [
    "a `FabricInstance`",
    new FabricMap(new Map([["a", 1]])),
    VALUE_TAGS.FabricInstance,
  ],
];

describe("tags", () => {
  describe("VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(VALUE_TAGS)).toBe(true);
    });

    it("holds every `FabricPrimitive` tag", () => {
      for (const [key, tag] of Object.entries(FABRIC_PRIMITIVE_VALUE_TAGS)) {
        expect(VALUE_TAGS[key as keyof typeof VALUE_TAGS]).toBe(tag);
      }
    });

    it("holds every JS type tag", () => {
      for (const [key, tag] of Object.entries(JS_TYPE_VALUE_TAGS)) {
        expect(VALUE_TAGS[key as keyof typeof VALUE_TAGS]).toBe(tag);
      }
    });

    it("holds every `FabricValuePlus` tag", () => {
      for (const [key, tag] of Object.entries(FABRIC_VALUE_PLUS_TAGS)) {
        expect(VALUE_TAGS[key as keyof typeof VALUE_TAGS]).toBe(tag);
      }
    });

    it("names each tag by its own string", () => {
      // A reported tag is accepted by asking whether the table has it as a
      // key, which holds only while every tag is also a key.

      for (const [key, tag] of Object.entries(VALUE_TAGS)) {
        expect(tag).toBe(key);
      }
    });
  });

  describe("JS_TYPE_VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(JS_TYPE_VALUE_TAGS)).toBe(true);
    });

    for (const [label, value, tag] of JS_TYPE_TAGS) {
      it(`names the tag of ${label} by its \`typeof\` name, or \`null\``, () => {
        expect(tag).toBe((value === null) ? "null" : typeof value);
      });
    }

    it("holds the tag of each JS type and nothing else", () => {
      // The sample table is the domain only while it covers every type, so
      // the two are held equal rather than the table being trusted.

      expect(new Set(JS_TYPE_TAGS.map(([, , tag]) => tag))).toEqual(
        new Set(Object.values(JS_TYPE_VALUE_TAGS)),
      );
    });

    it("is the `typeOfIncludingNull()` vocabulary, less `object`", () => {
      const _same: Same<JsTypeValueTag | "object", JsTypeTagIncludingNull> =
        true;
    });
  });

  describe("JS_PRIMITIVE_TYPE_VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(JS_PRIMITIVE_TYPE_VALUE_TAGS)).toBe(true);
    });

    it("holds the tag of each JS primitive type and nothing else", () => {
      // The sample table is the domain only while it covers every type, so
      // the two are held equal rather than the table being trusted.

      expect(new Set(JS_PRIMITIVE_TAGS.map(([, , tag]) => tag))).toEqual(
        new Set(Object.values(JS_PRIMITIVE_TYPE_VALUE_TAGS)),
      );
    });

    it("is the JS type vocabulary less `function`, and with the `FabricPrimitive` tags is the primitive vocabulary, in the type system", () => {
      const _js: Same<JsPrimitiveTypeValueTag | "function", JsTypeValueTag> =
        true;
      const _primitive: Same<
        JsPrimitiveTypeValueTag | FabricPrimitiveValueTag,
        PrimitiveValueTag
      > = true;
    });
  });

  describe("FABRIC_CONTAINER_VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(FABRIC_CONTAINER_VALUE_TAGS)).toBe(true);
    });

    it("maps each key to itself", () => {
      for (const [key, tag] of Object.entries(FABRIC_CONTAINER_VALUE_TAGS)) {
        expect(tag).toBe(key);
      }
    });

    it("holds `Array`, `FabricInstance`, `Object`, and nothing else", () => {
      expect(new Set(Object.values(FABRIC_CONTAINER_VALUE_TAGS))).toEqual(
        new Set(["Array", "FabricInstance", "Object"]),
      );
    });

    it("is, with the primitive tags, the whole `FabricValue` vocabulary, in the type system", () => {
      const _same: Same<
        FabricValueTag,
        PrimitiveValueTag | FabricContainerValueTag
      > = true;
      const _disjoint: Same<
        Extract<PrimitiveValueTag, FabricContainerValueTag>,
        never
      > = true;
    });
  });

  describe("isFabricContainerValueTag()", () => {
    const containerTags = new Set<ValueTag>(
      Object.values(FABRIC_CONTAINER_VALUE_TAGS),
    );

    for (const tag of Object.values(VALUE_TAGS)) {
      const expected = containerTags.has(tag);

      it(`returns \`${expected}\` for the tag \`${tag}\``, () => {
        expect(isFabricContainerValueTag(tag)).toBe(expected);
      });
    }

    it("returns `false` for `null`", () => {
      expect(isFabricContainerValueTag(null)).toBe(false);
    });
  });

  describe("FABRIC_VALUE_PLUS_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(FABRIC_VALUE_PLUS_TAGS)).toBe(true);
    });

    it("holds every `FabricValue` tag, `PlusType`, and nothing else", () => {
      expect(new Set(Object.values(FABRIC_VALUE_PLUS_TAGS))).toEqual(
        new Set([...Object.values(FABRIC_VALUE_TAGS), VALUE_TAGS.PlusType]),
      );
    });

    it("is the `FabricValue` vocabulary plus `PlusType`, in the type system, and `PlusType` is no convertible-JS tag", () => {
      const _plus: Same<FabricValuePlusTag, FabricValueTag | "PlusType"> = true;
      const _convertible: Same<
        Extract<ConvertibleJsValueTag, "PlusType">,
        never
      > = true;
    });
  });

  describe("tagOfFabricPrimitive()", () => {
    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagOfFabricPrimitive(value)).toBe(tag);
      });
    }

    it("returns a distinct tag for each registered primitive class", () => {
      const tags = FABRIC_PRIMITIVE_TAGS.map(([value]) =>
        tagOfFabricPrimitive(value)
      );
      expect(new Set(tags).size).toBe(FABRIC_PRIMITIVE_TAGS.length);
    });

    it("returns every primitive tag across the registered classes", () => {
      // The subset is the roster's tags and nothing else, held from both
      // sides: a tag no class reports, or a class reporting a tag outside
      // the subset, fails here.

      const tags = FABRIC_PRIMITIVE_TAGS.map(([value]) =>
        tagOfFabricPrimitive(value)
      );
      expect(new Set(tags)).toEqual(
        new Set(Object.values(FABRIC_PRIMITIVE_VALUE_TAGS)),
      );
    });

    it("returns the parent's tag for a subclass that supplies none", () => {
      // The getter is inherited like any other member. Whether that is what
      // such a subclass means is the subclass's concern; the dispatch reads
      // what it reports.

      expect(tagOfFabricPrimitive(new SubBytes(new Uint8Array([1]))))
        .toBe(FABRIC_PRIMITIVE_VALUE_TAGS.FabricBytes);
    });

    it("returns the tag a subclass reports, whatever its class", () => {
      expect(tagOfFabricPrimitive(new TaggedProbe())).toBe(
        VALUE_TAGS.FabricHash,
      );
    });

    it("throws for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
      expect(() => tagOfFabricPrimitive(new RoguePrimitive())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a reported tag the vocabulary lacks", () => {
      expect(() => tagOfFabricPrimitive(new MistaggedProbe())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a reported tag outside the primitive subset", () => {
      expect(() => tagOfFabricPrimitive(new NonPrimitiveTagProbe())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a type lie", () => {
      expect(() => tagOfFabricPrimitive({} as FabricPrimitive)).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });
  });

  describe("tagOfFabricPrimitiveElseNull()", () => {
    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagOfFabricPrimitiveElseNull(value)).toBe(tag);
      });
    }

    it("returns `null` for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
      expect(tagOfFabricPrimitiveElseNull(new RoguePrimitive())).toBe(null);
    });

    it("returns `null` for a reported tag the vocabulary lacks", () => {
      expect(tagOfFabricPrimitiveElseNull(new MistaggedProbe())).toBe(null);
    });

    it("returns `null` for a reported tag outside the primitive subset", () => {
      // `JsError` is a tag, but not one a primitive may report; a primitive
      // reporting it would otherwise be rebuilt as an error by conversion.

      expect(tagOfFabricPrimitiveElseNull(new NonPrimitiveTagProbe()))
        .toBe(null);
    });

    it("returns `null` for a reported tag that is only an inherited name", () => {
      expect(tagOfFabricPrimitiveElseNull(new InheritedNameProbe())).toBe(
        null,
      );
    });

    it("returns `null` for a reported tag that is no string", () => {
      expect(tagOfFabricPrimitiveElseNull(new UntaggedProbe())).toBe(null);
    });

    it("returns `null` for a type lie", () => {
      expect(tagOfFabricPrimitiveElseNull({} as FabricPrimitive)).toBe(null);
      expect(tagOfFabricPrimitiveElseNull(null as unknown as FabricPrimitive))
        .toBe(null);
    });
  });

  describe("tagOfFabricValue()", () => {
    for (const [label, value, tag] of JS_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagOfFabricValue(value)).toBe(tag);
      });
    }

    it("returns `Array` for an array", () => {
      expect(tagOfFabricValue([])).toBe(VALUE_TAGS.Array);
      expect(tagOfFabricValue([1, [2]])).toBe(VALUE_TAGS.Array);
    });

    it("returns `Object` for a plain object", () => {
      expect(tagOfFabricValue({})).toBe(VALUE_TAGS.Object);
      expect(tagOfFabricValue({ a: 1 })).toBe(VALUE_TAGS.Object);
    });

    it("returns `Object` for a null-prototype object", () => {
      // The narrowing this rests on asks a shape question rather than the
      // membership one, so a record membership refuses is still an `Object`
      // here. That is the looseness the function's doc comment reserves.

      const obj = Object.create(null) as FabricValue;
      expect(tagOfFabricValue(obj)).toBe(VALUE_TAGS.Object);
    });

    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagOfFabricValue(value)).toBe(tag);
      });
    }

    it("returns `FabricInstance` for each `FabricInstance` kind", () => {
      expect(tagOfFabricValue(FabricError.fromNativeError(new Error("x"))))
        .toBe(VALUE_TAGS.FabricInstance);
      expect(tagOfFabricValue(new FabricMap(new Map([["a", 1]]))))
        .toBe(VALUE_TAGS.FabricInstance);
    });

    it("throws for a function", () => {
      expect(() => tagOfFabricValue((() => {}) as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
    });

    it("throws for a class instance outside the vocabulary", () => {
      expect(() => tagOfFabricValue(new Date() as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
      expect(() => tagOfFabricValue(new Map() as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
    });

    it("throws for a primitive whose reported tag the vocabulary lacks", () => {
      expect(() => tagOfFabricValue(new MistaggedProbe())).toThrow(
        "Not possibly a valid `FabricValue`",
      );
    });

    describe("given an `isPlusType` predicate", () => {
      it("is asked about a value under every `FabricValue` tag", () => {
        // The table is the domain only while it covers every tag, so the two
        // are held equal rather than the table being trusted.

        expect(new Set(RECOGNIZED.map(([, , tag]) => tag))).toEqual(
          new Set(Object.values(FABRIC_VALUE_TAGS)),
        );
      });

      for (const [label, value, tag] of RECOGNIZED) {
        it(`returns \`${tag}\` for ${label} without consulting the predicate`, () => {
          const { asked, isPlusType } = recordingPredicate();

          expect(tagOfFabricValue(value, isPlusType)).toBe(tag);
          expect(asked).toEqual([]);
        });
      }

      it("returns `Object` for a proxy over a plain object without consulting the predicate", () => {
        // A proxy reports its target's prototype, so the plain-object question
        // is decided before the predicate could be asked, whatever the proxy
        // is standing in for.

        const { asked, isPlusType } = recordingPredicate();
        const value = new Proxy({ a: 1 }, {}) as FabricValuePlusLayer<
          PlusProbe
        >;

        expect(tagOfFabricValue(value, isPlusType)).toBe(VALUE_TAGS.Object);
        expect(asked).toEqual([]);
      });

      it("returns `PlusType` for a class instance the predicate accepts", () => {
        expect(tagOfFabricValue(new PlusProbe(), isPlusProbe)).toBe(
          VALUE_TAGS.PlusType,
        );
      });

      it("returns `PlusType` for a function the predicate accepts", () => {
        expect(tagOfFabricValue(() => {}, isPlusFn)).toBe(VALUE_TAGS.PlusType);
      });

      it("consults the predicate once, with the value itself, for a value the vocabulary does not name", () => {
        const { asked, isPlusType } = recordingPredicate();
        const value = new Date() as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(tagOfFabricValue(value, isPlusType)).toBe(VALUE_TAGS.PlusType);
        expect(asked).toEqual([value]);
      });

      it("throws for a class instance the predicate refuses", () => {
        const value = new Date() as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(() => tagOfFabricValue(value, isPlusProbe)).toThrow(
          "Not possibly a valid `FabricValue`",
        );
      });

      it("throws for a function the predicate refuses", () => {
        const value = (() => {}) as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(() => tagOfFabricValue(value, isPlusProbe)).toThrow(
          "Not possibly a valid `FabricValue`",
        );
      });

      it("takes its `PlusType` and its return type from the predicate, in the type system", () => {
        // Type-level only: nothing calls this function, so the refused calls
        // never run.

        function _typeOnly(
          value: FabricValuePlus<PlusProbe>,
          plain: FabricValue,
        ): void {
          // @ts-expect-error a plus value matches no overload without its predicate
          tagOfFabricValue(value);
          // @ts-expect-error the predicate must be for the value's own `PlusType`
          tagOfFabricValue(value, isPlusFn);

          const withPredicate = tagOfFabricValue(value, isPlusProbe);
          const withoutPredicate = tagOfFabricValue(plain);
          const _wide: Same<typeof withPredicate, FabricValuePlusTag> = true;
          const _narrow: Same<typeof withoutPredicate, FabricValueTag> = true;
        }
      });
    });
  });

  describe("tagOfFabricValueElseNull()", () => {
    for (const [label, value, tag] of JS_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagOfFabricValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `Array` for an array and `Object` for a plain object", () => {
      expect(tagOfFabricValueElseNull([1])).toBe(VALUE_TAGS.Array);
      expect(tagOfFabricValueElseNull({ a: 1 })).toBe(VALUE_TAGS.Object);
    });

    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagOfFabricValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `FabricInstance` for a `FabricInstance`", () => {
      expect(
        tagOfFabricValueElseNull(FabricError.fromNativeError(new Error("x"))),
      ).toBe(VALUE_TAGS.FabricInstance);
    });

    it("returns `null` for a function", () => {
      expect(tagOfFabricValueElseNull((() => {}) as unknown as FabricValue))
        .toBe(null);
    });

    it("returns `null` for a class instance outside the vocabulary", () => {
      expect(tagOfFabricValueElseNull(new Date() as unknown as FabricValue))
        .toBe(null);
      expect(tagOfFabricValueElseNull(/x/ as unknown as FabricValue))
        .toBe(null);
    });

    it("returns `null` for a primitive whose reported tag the vocabulary lacks", () => {
      expect(tagOfFabricValueElseNull(new MistaggedProbe())).toBe(null);
      expect(tagOfFabricValueElseNull(new NonPrimitiveTagProbe())).toBe(null);
      expect(tagOfFabricValueElseNull(new RoguePrimitive())).toBe(null);
    });

    describe("given an `isPlusType` predicate", () => {
      for (const [label, value, tag] of RECOGNIZED) {
        it(`returns \`${tag}\` for ${label} without consulting the predicate`, () => {
          const { asked, isPlusType } = recordingPredicate();

          expect(tagOfFabricValueElseNull(value, isPlusType)).toBe(tag);
          expect(asked).toEqual([]);
        });
      }

      it("returns `Object` for a proxy over a plain object without consulting the predicate", () => {
        const { asked, isPlusType } = recordingPredicate();
        const value = new Proxy({ a: 1 }, {}) as FabricValuePlusLayer<
          PlusProbe
        >;

        expect(tagOfFabricValueElseNull(value, isPlusType)).toBe(
          VALUE_TAGS.Object,
        );
        expect(asked).toEqual([]);
      });

      it("returns `PlusType` for a class instance the predicate accepts", () => {
        expect(tagOfFabricValueElseNull(new PlusProbe(), isPlusProbe)).toBe(
          VALUE_TAGS.PlusType,
        );
      });

      it("returns `PlusType` for a function the predicate accepts", () => {
        expect(tagOfFabricValueElseNull(() => {}, isPlusFn)).toBe(
          VALUE_TAGS.PlusType,
        );
      });

      it("consults the predicate once, with the value itself, for a value the vocabulary does not name", () => {
        const { asked, isPlusType } = recordingPredicate();
        const value = new Date() as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(tagOfFabricValueElseNull(value, isPlusType)).toBe(
          VALUE_TAGS.PlusType,
        );
        expect(asked).toEqual([value]);
      });

      it("returns `null` for a class instance the predicate refuses", () => {
        const value = new Date() as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(tagOfFabricValueElseNull(value, isPlusProbe)).toBe(null);
      });

      it("returns `null` for a function the predicate refuses", () => {
        const value = (() => {}) as unknown as FabricValuePlusLayer<PlusProbe>;

        expect(tagOfFabricValueElseNull(value, isPlusProbe)).toBe(null);
      });

      it("takes its `PlusType` and its return type from the predicate, in the type system", () => {
        // Type-level only: nothing calls this function, so the refused calls
        // never run.

        function _typeOnly(
          value: FabricValuePlus<PlusProbe>,
          plain: FabricValue,
        ): void {
          // @ts-expect-error a plus value matches no overload without its predicate
          tagOfFabricValueElseNull(value);
          // @ts-expect-error the predicate must be for the value's own `PlusType`
          tagOfFabricValueElseNull(value, isPlusFn);

          const withPredicate = tagOfFabricValueElseNull(value, isPlusProbe);
          const withoutPredicate = tagOfFabricValueElseNull(plain);
          const _wide: Same<typeof withPredicate, FabricValuePlusTag | null> =
            true;
          const _narrow: Same<typeof withoutPredicate, FabricValueTag | null> =
            true;
        }
      });
    });
  });

  describe("the fabric dispatch and the convertible-JS dispatch", () => {
    // On a value membership accepts, the two dispatches are asked the same
    // question from different sides -- one of a value typed as a `FabricValue`,
    // one of an `unknown` -- and must give the same answer. Where membership
    // refuses a value the fabric dispatch owes nothing, so those are held out
    // rather than asserted either way. The partition is made here so that
    // each assertion below is unconditional.

    const accepted = LAYER_CORPUS
      .filter(([, value]) => isValidFabricValueLayer(value));
    const refused = LAYER_CORPUS
      .filter(([, value]) => !isValidFabricValueLayer(value));

    for (const [label, value] of accepted) {
      it(`tags ${label} the same from either side`, () => {
        const fabric = tagOfFabricValue(value as FabricValue);
        expect(fabric).toBe(tagOfConvertibleJsValueElseNull(value));
        expect(fabric).toBe(tagOfFabricValueElseNull(value as FabricValue));
      });
    }

    for (const [label, value] of accepted) {
      it(`tags ${label} without consulting an \`isPlusType\` predicate`, () => {
        const { asked, isPlusType } = recordingPredicate();

        expect(tagOfFabricValueElseNull(value as FabricValue, isPlusType))
          .toBe(tagOfFabricValueElseNull(value as FabricValue));
        expect(asked).toEqual([]);
      });
    }

    it("reaches values on both sides of membership", () => {
      expect(accepted.length).toBeGreaterThan(0);
      expect(refused.length).toBeGreaterThan(0);
    });
  });

  describe("tagOfConvertibleJsValueElseNull()", () => {
    for (const [label, value, tag] of JS_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagOfConvertibleJsValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `null` for a function", () => {
      expect(tagOfConvertibleJsValueElseNull(() => {})).toBe(null);
    });

    it("returns `null` for a function whatever its prototype names", () => {
      // The class switch is never reached by a function, so a prototype
      // re-pointed at a recognized builtin's does not make one a builtin.

      expect(
        tagOfConvertibleJsValueElseNull(
          Object.setPrototypeOf(() => {}, Map.prototype),
        ),
      ).toBe(null);
      expect(
        tagOfConvertibleJsValueElseNull(
          Object.setPrototypeOf(() => {}, Date.prototype),
        ),
      ).toBe(null);
    });

    it("returns `JsError` tag for standard `Error` subclasses", () => {
      const cases: [string, Error][] = [
        ["Error", new Error("test")],
        ["TypeError", new TypeError("test")],
        ["RangeError", new RangeError("test")],
        ["SyntaxError", new SyntaxError("test")],
        ["ReferenceError", new ReferenceError("test")],
        ["URIError", new URIError("test")],
        ["EvalError", new EvalError("test")],
      ];
      for (const [_name, value] of cases) {
        expect(tagOfConvertibleJsValueElseNull(value)).toBe(VALUE_TAGS.JsError);
      }
    });

    it("returns `JsError` tag for exotic `Error` subclass (custom class)", () => {
      class MyFancyError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "MyFancyError";
        }
      }
      const exotic = new MyFancyError("exotic");
      // Recognized at the value level: `Error.isError()` reads the internal
      // slot, so an `Error` subclass is tagged before any class is read.
      expect(tagOfConvertibleJsValueElseNull(exotic)).toBe(VALUE_TAGS.JsError);
    });

    it("returns `JsError` tag for an `Error` whatever its prototype names", () => {
      // `Error.isError()` reads the internal slot and is asked before the
      // prototype is, so neither a plain object's prototype nor a recognized
      // builtin's changes the answer.

      expect(
        tagOfConvertibleJsValueElseNull(
          Object.setPrototypeOf(new Error("x"), Object.prototype),
        ),
      ).toBe(VALUE_TAGS.JsError);
      expect(
        tagOfConvertibleJsValueElseNull(
          Object.setPrototypeOf(new Error("x"), Map.prototype),
        ),
      ).toBe(VALUE_TAGS.JsError);
    });

    it("returns `JsError` tag for an `Error` whose prototype was severed", () => {
      const severed = new Error("severed");
      Object.setPrototypeOf(severed, null);

      // No reachable constructor, so the class-level lookup yields nothing and
      // the `Error.isError()` fallback is what recognizes it.
      expect((severed as { constructor?: unknown }).constructor).toBe(
        undefined,
      );
      expect(tagOfConvertibleJsValueElseNull(severed)).toBe(VALUE_TAGS.JsError);
    });

    it("returns `Array` tag for an `Array` subclass", () => {
      class MyArray extends Array {}

      expect(tagOfConvertibleJsValueElseNull(new MyArray())).toBe(
        VALUE_TAGS.Array,
      );
    });

    it("returns `Array` tag for an array whose prototype was severed", () => {
      const severed = [1, 2];
      Object.setPrototypeOf(severed, null);

      expect(tagOfConvertibleJsValueElseNull(severed)).toBe(VALUE_TAGS.Array);
    });

    it("returns `JsMap` tag for `Map` instances", () => {
      expect(tagOfConvertibleJsValueElseNull(new Map())).toBe(VALUE_TAGS.JsMap);
    });

    it("returns `JsSet` tag for `Set` instances", () => {
      expect(tagOfConvertibleJsValueElseNull(new Set())).toBe(VALUE_TAGS.JsSet);
    });

    it("returns `JsDate` tag for `Date` instances", () => {
      expect(tagOfConvertibleJsValueElseNull(new Date())).toBe(
        VALUE_TAGS.JsDate,
      );
    });

    it("returns `JsUint8Array` tag for `Uint8Array` instances", () => {
      expect(tagOfConvertibleJsValueElseNull(new Uint8Array())).toBe(
        VALUE_TAGS.JsUint8Array,
      );
    });

    it("returns `Object` tag for plain objects", () => {
      expect(tagOfConvertibleJsValueElseNull({})).toBe(VALUE_TAGS.Object);
    });

    it("returns `Array` tag for arrays", () => {
      expect(tagOfConvertibleJsValueElseNull([])).toBe(VALUE_TAGS.Array);
    });

    it("returns `JsRegExp` tag for `RegExp` instances", () => {
      expect(tagOfConvertibleJsValueElseNull(/abc/)).toBe(VALUE_TAGS.JsRegExp);
    });

    it("returns `Object` tag for null-prototype objects (no constructor)", () => {
      const obj = Object.create(null);
      expect(tagOfConvertibleJsValueElseNull(obj)).toBe(VALUE_TAGS.Object);
    });

    it("returns `null` for class instances", () => {
      class Custom {}
      expect(tagOfConvertibleJsValueElseNull(new Custom())).toBe(null);
    });

    describe("an own `constructor` property does not decide the class", () => {
      // An own `constructor` property is ordinary data that happens to share a
      // name with the thing that decides a value's class. Reading the class off
      // the value rather than off its prototype would let a plain record present
      // itself as an `Error` -- and be rebuilt as one, by a conversion doing
      // exactly what it was told.
      for (
        const [label, forged] of [
          ["`Error`", Error],
          ["`Map`", Map],
          ["`Date`", Date],
          ["`Uint8Array`", Uint8Array],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`returns \`Object\` for a record claiming ${label}`, () => {
          expect(tagOfConvertibleJsValueElseNull({ constructor: forged, a: 1 }))
            .toBe(VALUE_TAGS.Object);
        });

        it(`returns \`false\` from the membership check for one claiming ${label}`, () => {
          expect(
            isValidFabricConvertibleJsObject({ constructor: forged, a: 1 }),
          )
            .toBe(false);
        });
      }

      it("reads an inherited `constructor`, which is the real one", () => {
        // The counterpart: what the prototype says IS the answer, so a value
        // whose class is reachable only through its prototype is tagged by it.
        expect(tagOfConvertibleJsValueElseNull(new Map())).toBe(
          VALUE_TAGS.JsMap,
        );
        expect(isValidFabricConvertibleJsObject(new Map())).toBe(true);
      });
    });

    describe("an array is decided by the array rule, whatever its prototype", () => {
      // A prototype can be re-pointed, so "an array's class is `Array`" is only
      // usually true. `Array.isArray()` is what is actually true of every array,
      // and it is why the array rule runs before any class is consulted -- in
      // both dispatches, since either one reporting an array as a convertible
      // `Date` would be a walk rebuilding it as one.
      for (
        const [label, value] of [
          ["an ordinary array", [1, 2]],
          [
            "an array whose `prototype` is `Date.prototype`",
            Object.setPrototypeOf([1, 2], Date.prototype),
          ],
          [
            "an array whose `prototype` is `Map.prototype`",
            Object.setPrototypeOf([1, 2], Map.prototype),
          ],
          [
            "an array whose prototype was severed",
            Object.setPrototypeOf([1, 2], null),
          ],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`tags ${label} \`Array\``, () => {
          expect(tagOfConvertibleJsValueElseNull(value)).toBe(VALUE_TAGS.Array);
        });

        it(`reports ${label} as no \`FabricConvertibleJsObject\``, () => {
          expect(isValidFabricConvertibleJsObject(value)).toBe(false);
        });
      }
    });

    describe("`toJSON()` is intentionally not supported", () => {
      // `toJSON` is an ordinary property name here, with no say in what a value
      // is. These pin that at each of the shapes it can be carried on, because a
      // classifier that consulted it would let one assignment --
      // `Array.prototype.toJSON`, an own key on a record -- redirect values
      // wholesale.

      it("returns `Object` tag for a plain object carrying `toJSON()`", () => {
        expect(tagOfConvertibleJsValueElseNull({ toJSON: () => "converted" }))
          .toBe(
            VALUE_TAGS.Object,
          );
      });

      it("returns `Array` tag for an array carrying an own `toJSON()`", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(tagOfConvertibleJsValueElseNull(arr)).toBe(VALUE_TAGS.Array);
      });

      it("returns `Array` tag despite an inherited `toJSON()`", () => {
        const proto = Array.prototype as unknown as Record<string, unknown>;
        try {
          proto.toJSON = () => "hijacked";
          const arr = [1, 2];
          expect(Object.hasOwn(arr, "toJSON")).toBe(false);
          expect(tagOfConvertibleJsValueElseNull(arr)).toBe(VALUE_TAGS.Array);
        } finally {
          delete proto.toJSON;
        }
      });

      it("returns `Array` tag for an `Array` subclass carrying `toJSON()`", () => {
        class ProtoJson extends Array {
          toJSON(): unknown[] {
            return [7, 8];
          }
        }
        expect(tagOfConvertibleJsValueElseNull(new ProtoJson())).toBe(
          VALUE_TAGS.Array,
        );
      });

      it("returns `null` for a class instance carrying `toJSON()`", () => {
        class Custom {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagOfConvertibleJsValueElseNull(new Custom())).toBe(null);
      });

      it("returns `null` for a function carrying `toJSON()`", () => {
        const fn = Object.assign(() => {}, { toJSON: () => "converted" });
        expect(tagOfConvertibleJsValueElseNull(fn)).toBe(null);
      });
    });
  });

  describe("recognition is by the class the prototype names", () => {
    // The class is read from the prototype and compared by identity, so an
    // object created from a recognized builtin's prototype is tagged as that
    // builtin whether or not it carries the builtin's internal slots. A plain
    // object, an array, and an error are decided by tests that read the value
    // itself, so an object merely built on one of those prototypes is none of
    // them and is unrecognized.

    for (
      const [label, ctor, tag] of [
        ["`Map`", Map, VALUE_TAGS.JsMap],
        ["`Set`", Set, VALUE_TAGS.JsSet],
        ["`Date`", Date, VALUE_TAGS.JsDate],
        ["`Uint8Array`", Uint8Array, VALUE_TAGS.JsUint8Array],
        ["`RegExp`", RegExp, VALUE_TAGS.JsRegExp],
      ] as ReadonlyArray<[string, { prototype: object }, ValueTag]>
    ) {
      it(`returns \`${tag}\` for an object whose prototype is that of ${label}`, () => {
        expect(tagOfConvertibleJsValueElseNull(Object.create(ctor.prototype)))
          .toBe(tag);
      });
    }

    for (
      const [label, ctor] of [
        ["`Array`", Array],
        ["`Error`", Error],
        ["`TypeError`", TypeError],
        ["`RangeError`", RangeError],
        ["`SyntaxError`", SyntaxError],
        ["`ReferenceError`", ReferenceError],
        ["`URIError`", URIError],
        ["`EvalError`", EvalError],
      ] as ReadonlyArray<[string, { prototype: object }]>
    ) {
      it(`returns \`null\` for a non-instance whose prototype is that of ${label}`, () => {
        expect(tagOfConvertibleJsValueElseNull(Object.create(ctor.prototype)))
          .toBe(null);
      });
    }

    it("returns `null` for a non-error whose prototype is that of an exotic `Error` subclass", () => {
      class ExoticError extends Error {}

      expect(
        tagOfConvertibleJsValueElseNull(Object.create(ExoticError.prototype)),
      ).toBe(null);
    });

    it("returns `null` for an object whose prototype is a plain object", () => {
      expect(tagOfConvertibleJsValueElseNull(Object.create({}))).toBe(null);
    });

    it("returns `null` for an instance of an unrecognized builtin class", () => {
      expect(tagOfConvertibleJsValueElseNull(new WeakMap())).toBe(null);
      expect(tagOfConvertibleJsValueElseNull(Promise.resolve())).toBe(null);
    });
  });

  describe("the value dispatch and the fabric primitives", () => {
    // A fabric primitive is tagged by the tag its instance carries, its class
    // being one the value dispatch does not name. Asserted against the fabric
    // classes by name rather than against whatever the corpus happens to hold,
    // so a class the corpus stopped carrying is a failure here rather than a
    // silence.

    const fabricClasses = [
      FabricBytes,
      FabricEpochDay,
      FabricEpochNsec,
      FabricHash,
      FabricKeyPair,
      FabricRegExp,
      FabricUnavailable,
    ];

    const objects = LAYER_CORPUS
      .filter(([, value]) => isObjectOrArray(value));

    for (const cls of fabricClasses) {
      it(`tags a \`${cls.name}\` by its instance`, () => {
        const carried = objects.filter(([, value]) => value instanceof cls);
        expect(carried.length).toBeGreaterThan(0);
        for (const [, value] of carried) {
          expect(tagOfConvertibleJsValueElseNull(value))
            .toBe(tagOfFabricPrimitive(value as FabricPrimitive));
        }
      });
    }
  });
});
