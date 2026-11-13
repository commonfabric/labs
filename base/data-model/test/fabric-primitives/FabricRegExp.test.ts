/**
 * A regular expression stored as data -- source, flags, and the flavor saying
 * whose dialect they are written in -- rather than as a live `RegExp`.
 *
 * The flavor is what makes this more than a wrapper. A pattern in the dialect
 * this runtime understands is validated and can be handed back as a JS
 * `RegExp`; one in any other flavor is stored faithfully and not parsed at all,
 * so a pattern JS would reject still makes a value. What fails is asking such a
 * value for a convertible JS form, and it fails at that point rather than when
 * the value was stored.
 *
 * Nothing is aliased in either direction: the constructor does not keep the
 * `RegExp` it was given, and each read builds a fresh one, so mutating what
 * comes back cannot reach the stored value. The flavor counts toward identity
 * as well -- two values differing only in it hash differently.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  FabricInstance,
  FabricPrimitive,
  hashOf,
  isValidFabricConvertibleJsObject,
  isValidFabricConvertibleJsValue,
  shallowFabricFromConvertibleJsValue,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@";
import { UnknownValue } from "@/codec-common";
import {
  fabricFromJsonValue,
  fabricFromRealmValue,
  jsonFromFabricValue,
  realmFromFabricValue,
} from "@/codecs.ts";
import { FabricRegExp } from "@/fabric-primitives";

/** The state a `RegExp@1` would carry for `/abc/gi`. */
const REGEXP_STATE = { flags: "gi", flavor: "es2025", source: "abc" };

/** What encoding a value of a class no codec claims throws. */
const UNCLAIMED = "No codec registered for `FabricSpecialObject` subclass " +
  "`FabricRegExp`.";

describe("FabricRegExp", () => {
  it("extends `FabricPrimitive` (not `FabricInstance`)", () => {
    // Pure type-identity / supertype check: cross-cutting carve-out per the
    // rule (doesn't fit a single member, isn't construction mechanics).

    const re = new FabricRegExp(/abc/gi);
    expect(re instanceof FabricPrimitive).toBe(true);
    expect(re instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricRegExp(/abc/))).toBe(true);
    });

    describe("given a `RegExp`", () => {
      it("retains the `source` and `flags` and implies the `es2025` flavor", () => {
        const re = new FabricRegExp(/test/i);
        expect(re.source).toBe("test");
        expect(re.flags).toBe("i");
        expect(re.flavor).toBe("es2025");
      });

      it("does not alias the input `RegExp`", () => {
        const original = /abc/gi;
        const re = new FabricRegExp(original);
        original.lastIndex = 5;
        expect(re.value.lastIndex).toBe(0);
      });

      it("throws given one with extra enumerable properties", () => {
        const original = /abc/g;
        (original as unknown as Record<string, unknown>).custom = 1;
        expect(() => new FabricRegExp(original)).toThrow(
          "Not representable as a `FabricValue`: `RegExp` with extra enumerable properties",
        );
      });
    });

    describe("given explicit `flavor`/`source`/`flags`", () => {
      it("retains all three", () => {
        const re = new FabricRegExp("pcre2", "ab+c", "g");
        expect(re.flavor).toBe("pcre2");
        expect(re.source).toBe("ab+c");
        expect(re.flags).toBe("g");
      });
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricRegExp`", () => {
        expect(new FabricRegExp(/a/).schemaType).toBe("FabricRegExp");
      });
    });

    describe(".source", () => {
      it("returns the pattern source text", () => {
        expect(new FabricRegExp(/^foo\d+\.bar$/).source).toBe(
          "^foo\\d+\\.bar$",
        );
      });
    });

    describe(".flags", () => {
      it("returns the flags string", () => {
        expect(new FabricRegExp(/abc/gim).flags).toBe("gim");
      });

      it("returns empty `flags` for a no-flag regexp", () => {
        expect(new FabricRegExp(/abc/).flags).toBe("");
      });
    });

    describe(".flavor", () => {
      it("defaults to `es2025` for a `RegExp` argument", () => {
        expect(new FabricRegExp(/abc/).flavor).toBe("es2025");
      });

      it("returns an explicit flavor", () => {
        expect(new FabricRegExp("pcre2", "abc", "g").flavor).toBe("pcre2");
      });
    });

    describe(".value", () => {
      it("returns an equivalent JS `RegExp` for the `es2025` flavor", () => {
        const value = new FabricRegExp(/abc/gi).value;
        expect(value).toBeInstanceOf(RegExp);
        expect(value.source).toBe("abc");
        expect(value.flags).toBe("gi");
      });

      it("returns a fresh clone on each call (not the stored object)", () => {
        const re = new FabricRegExp(/abc/g);
        expect(re.value).not.toBe(re.value);
      });

      it("returns a `RegExp` whose mutation does not affect the value", () => {
        const re = new FabricRegExp(/abc/g);
        re.value.lastIndex = 5;
        expect(re.value.lastIndex).toBe(0);
      });

      it("throws for a non-`es2025` flavor (no JS representation yet)", () => {
        const re = new FabricRegExp("pcre2", "abc", "g");
        expect(() => re.value).toThrow("pcre2");
      });
    });
  });

  describe("`jsonFromFabricValue()` / `fabricFromJsonValue()`", () => {
    // The following exercise free functions' handling of `FabricRegExp` /
    // `RegExp@1` rather than members of the class itself, so they live
    // directly under the class `describe()` (the cross-cutting carve-out).

    it("throws given a `FabricRegExp`, which no codec claims", () => {
      expect(() => jsonFromFabricValue(new FabricRegExp(/abc/gi))).toThrow(
        UNCLAIMED,
      );
    });

    it("decodes a `RegExp@1` text to an `UnknownValue` holding its tag and state", () => {
      const decoded = fabricFromJsonValue(
        'fvj1:{"/RegExp@1":{"flags":"gi","flavor":"es2025","source":"abc"}}',
      );
      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe("RegExp@1");
      expect((decoded as UnknownValue).state).toEqual(REGEXP_STATE);
    });
  });

  describe("`realmFromFabricValue()` / `fabricFromRealmValue()`", () => {
    // As above, free functions rather than members of the class.

    it("throws given a `FabricRegExp`, which no codec claims", () => {
      expect(() => realmFromFabricValue(new FabricRegExp(/abc/gi))).toThrow(
        UNCLAIMED,
      );
    });

    it("decodes a `RegExp@1` to an `UnknownValue` holding its tag and state", () => {
      // An `UnknownValue` encodes to exactly the tagged form a `RegExp@1`
      // would have, which saves building the wire form by hand.
      const decoded = fabricFromRealmValue(
        realmFromFabricValue(new UnknownValue("RegExp@1", REGEXP_STATE)),
      );
      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe("RegExp@1");
      expect((decoded as UnknownValue).state).toEqual(REGEXP_STATE);
    });
  });

  describe("shallowFabricFromConvertibleJsValue()", () => {
    it("converts a `RegExp` to a `FabricRegExp`", () => {
      const result = shallowFabricFromConvertibleJsValue(/abc/gi);
      expect(result).toBeInstanceOf(FabricRegExp);
      expect((result as FabricRegExp).source).toBe("abc");
      expect((result as FabricRegExp).flags).toBe("gi");
    });

    it("throws given a `RegExp` with extra enumerable properties", () => {
      const re = /abc/;
      (re as unknown as Record<string, unknown>).custom = 1;
      expect(() => shallowFabricFromConvertibleJsValue(re)).toThrow(
        "Not representable as a `FabricValue`: `RegExp` with extra enumerable properties",
      );
    });
  });

  describe("tag functions", () => {
    describe("tagOfConvertibleJsValueElseNull()", () => {
      it("returns the `JsRegExp` tag for `RegExp` instances", () => {
        expect(tagOfConvertibleJsValueElseNull(/abc/)).toBe(
          VALUE_TAGS.JsRegExp,
        );
      });
    });

    describe("isValidFabricConvertibleJsObject()", () => {
      it("returns `true` for `RegExp`", () => {
        expect(isValidFabricConvertibleJsObject(/abc/)).toBe(true);
        expect(isValidFabricConvertibleJsObject(new RegExp("test", "gi"))).toBe(
          true,
        );
      });
    });
  });

  describe("isValidFabricConvertibleJsValue()", () => {
    it("returns `true` for a plain `RegExp`", () => {
      expect(isValidFabricConvertibleJsValue(/abc/gi)).toBe(true);
    });

    it("returns `true` for a `RegExp` nested in objects", () => {
      expect(isValidFabricConvertibleJsValue({ pattern: /abc/gi })).toBe(true);
    });
  });

  describe("hashOf()", () => {
    it("produces a hash for a `FabricRegExp`", () => {
      const hash = hashOf(new FabricRegExp(/abc/gi));
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256
    });

    it("produces the same hash for the same regex", () => {
      const h1 = hashOf(new FabricRegExp(/abc/gi)).bytes;
      const h2 = hashOf(new FabricRegExp(/abc/gi)).bytes;
      expect(h1).toEqual(h2);
    });

    it("produces a different hash for a different `source`", () => {
      const h1 = hashOf(new FabricRegExp(/abc/)).bytes;
      const h2 = hashOf(new FabricRegExp(/def/)).bytes;
      expect(h1).not.toEqual(h2);
    });

    it("produces a different hash for different `flags`", () => {
      const h1 = hashOf(new FabricRegExp(/abc/g)).bytes;
      const h2 = hashOf(new FabricRegExp(/abc/i)).bytes;
      expect(h1).not.toEqual(h2);
    });

    it("produces a different hash for a different `flavor`", () => {
      const h1 = hashOf(new FabricRegExp("es2025", "abc", "g")).bytes;
      const h2 = hashOf(new FabricRegExp("pcre2", "abc", "g")).bytes;
      expect(h1).not.toEqual(h2);
    });
  });
});
