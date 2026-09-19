/**
 * A regular expression stored as data -- source, flags, and the flavor saying
 * whose dialect they are written in -- rather than as a live `RegExp`.
 *
 * The flavor is what makes this more than a wrapper. A pattern in the dialect
 * this runtime understands is validated and can be handed back as a JS
 * `RegExp`; one in any other flavor is stored faithfully and not parsed at all,
 * so a pattern JS would reject survives a round trip instead of becoming a
 * `ProblematicValue`. What fails is asking such a value for a convertible JS
 * form, and it fails at that point rather than when the value was stored.
 *
 * Nothing is aliased in either direction: the constructor does not keep the
 * `RegExp` it was given, and each read builds a fresh one, so mutating what
 * comes back cannot reach the stored value. The flavor counts toward identity
 * as well -- two values differing only in it hash differently.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common/index.ts";
import { fabricFromJsonValue, jsonFromFabricValue } from "@/codecs.ts";
import { FabricRegExp } from "@/fabric-primitives/index.ts";
import {
  FabricInstance,
  FabricPrimitive,
  hashOf,
  isValidFabricConvertibleJsObject,
  isValidFabricConvertibleJsValue,
  shallowFabricFromConvertibleJsValue,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@/index.ts";

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

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricRegExp[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.RegExp;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `RegExp` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricRegExp`, rejecting other values", () => {
          expect(codec.canEncode(new FabricRegExp(/ab+c/gi))).toBe(true);
          expect(codec.canEncode("not a regexp")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a `{ source, flags, flavor }` object", () => {
          const re = new FabricRegExp(/ab+c/gi);
          expect(codec.encode(re, env)).toEqual({
            flags: "gi",
            flavor: "es2025",
            source: "ab+c",
          });
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record of the three strings", () => {
          expect(codec.canDecode({
            flavor: "es2025",
            source: "a",
            flags: "g",
          })).toBe(true);
        });

        it("returns `true` for a record with a field absent", () => {
          expect(codec.canDecode({ source: "a" })).toBe(true);
        });

        it("returns `false` for state that is not a record", () => {
          expect(codec.canDecode("nope")).toBe(false);
        });

        it("returns `false` for a non-string field", () => {
          // Only the `es2025` flavor is validated for syntax, so under any
          // other one these values reach the constructor untouched -- and
          // `source` and `flags` are exposed by getters typed `string`. An
          // unchecked object here would put one behind such a getter, and take
          // an unfrozen reference into a frozen instance with it.
          for (
            const state of [
              { flavor: "future", source: { mutable: true }, flags: "g" },
              { flavor: "future", source: "a", flags: ["g"] },
              { flavor: ["future"], source: "a", flags: "g" },
              // Present as `undefined` is present, not absent. A peer can
              // reach this through the nonterminal walk by encoding the field
              // as `{"/Undefined@1": null}`, and defaulting it would answer a
              // question the wire did ask -- with `flavor`, by naming a
              // dialect the sender did not.
              { flavor: undefined, source: "a", flags: "g" },
            ]
          ) {
            expect(codec.canDecode(state as never)).toBe(false);
          }
        });
      });

      describe("decode()", () => {
        it("decodes a state omitting a field, taking that field's default", () => {
          // Absent is not the same as present-and-wrong: a narrower encoder
          // may leave a field out, and the default stands in for it.
          const decoded = codec.decode(
            expectedTag,
            {},
            env,
          ) as FabricRegExp;

          expect(decoded).toBeInstanceOf(FabricRegExp);
          expect(decoded.source).toBe("");
          expect(decoded.flags).toBe("");
        });

        it("decodes an unparseable `es2025` pattern to `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            { source: "(", flags: "" },
            env,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });

        it("decodes bad `es2025` flags to `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            { source: "a", flags: "zz" },
            env,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });

        it("returns a `FabricRegExp` rather than a `ProblematicValue` for a malformed pattern under a non-`es2025` flavor", () => {
          // Only the `es2025` flavor is validated; other flavors are stored
          // faithfully, so an unparseable source is not a decode failure.
          const decoded = codec.decode(
            expectedTag,
            { flavor: "other", source: "(", flags: "" },
            env,
          );
          expect(decoded).not.toBeInstanceOf(ProblematicValue);
          expect(decoded).toBeInstanceOf(FabricRegExp);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips a regex (source, flags, flavor)", () => {
          const re = new FabricRegExp(/ab+c/gi);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(re, env),
            env,
          ) as unknown as FabricRegExp;
          expect(decoded).toBeInstanceOf(FabricRegExp);
          expect(decoded.source).toBe("ab+c");
          expect(decoded.flags).toBe("gi");
          expect(decoded.flavor).toBe("es2025");
        });

        it("round-trips a flagless regex", () => {
          const re = new FabricRegExp("es2025", "^x*$", "");
          const decoded = codec.decode(
            expectedTag,
            codec.encode(re, env),
            env,
          ) as unknown as FabricRegExp;
          expect(decoded).toBeInstanceOf(FabricRegExp);
          expect(decoded.source).toBe("^x*$");
          expect(decoded.flags).toBe("");
        });
      });
    });
  });

  describe("round-trip via `jsonFromFabricValue()` / `fabricFromJsonValue()`", () => {
    // The following exercise free functions' handling of `FabricRegExp` /
    // `RegExp` rather than members of the class itself, so they live directly
    // under the class `describe()` (the cross-cutting carve-out).

    it("round-trips a `FabricRegExp`", () => {
      const original = new FabricRegExp(/hello\s+world/gim);
      const restored = fabricFromJsonValue(
        jsonFromFabricValue(original),
      ) as FabricRegExp;
      expect(restored).toBeInstanceOf(FabricRegExp);
      expect(restored.source).toBe(original.source);
      expect(restored.flags).toBe(original.flags);
      expect(restored.flavor).toBe("es2025");
    });

    it("round-trips with various flag combinations", () => {
      const flagSets = ["", "g", "i", "m", "s", "u", "y", "d", "gi", "gims"];
      for (const flags of flagSets) {
        const original = new FabricRegExp(new RegExp("test", flags));
        const restored = fabricFromJsonValue(
          jsonFromFabricValue(original),
        ) as FabricRegExp;
        expect(restored.flags).toBe(original.flags);
        expect(restored.flavor).toBe("es2025");
      }
    });

    it("round-trips a non-`es2025` flavor faithfully (source/flags/flavor)", () => {
      const original = new FabricRegExp("pcre2", "ab+c", "g");
      const restored = fabricFromJsonValue(
        jsonFromFabricValue(original),
      ) as FabricRegExp;
      expect(restored.source).toBe("ab+c");
      expect(restored.flags).toBe("g");
      expect(restored.flavor).toBe("pcre2");
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
