/**
 * Rendering a value for a human to read, including the values that resist
 * being rendered.
 *
 * A debug renderer is called on whatever is at hand, usually while something
 * is already wrong, so it has to survive input that would defeat an ordinary
 * serializer: a cycle, a value that refuses to be rendered, a structure too
 * large to print whole. Producing something useful and bounded matters more
 * than producing something complete, which is what the length limit is for.
 *
 * The compact and indented forms differ only in spacing. The custom inspector
 * is how all of this reaches a `console.log()`. The renderings themselves are
 * recorded as case files under `value-debug-cases/`, which
 * `value-debug-cases.test.ts` checks, a file's `/options` binding covering the
 * renderings under other than the default options; what is tested here is
 * what a case file cannot express.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { REALM_CODEC } from "@/codec-common/index.ts";
import { FabricLink } from "@/fabric-instances/index.ts";
import { FabricBytes, FabricEpochNsec } from "@/fabric-primitives/index.ts";
import {
  type CompactDebugStringOptions,
  type DebugValueOptions,
  FabricPrimitive,
  toCompactDebugString,
  toIndentedDebugString,
  toLongQuotedDebugString,
  toShortQuotedDebugString,
} from "@/index.ts";

describe("impl", () => {
  describe("toCompactDebugString", () => {
    // The renderings themselves are recorded as case files in
    // `value-debug-cases/`. What is here is what a case file cannot express:
    // a value at the top level against the same value nested, the `maxLength`
    // behavior at more than one length, and the options that are refused.

    it("renders a top-level value the same as it renders that value in an array", () => {
      function foo() {}
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        foo,
        new Set(),
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        const nested = toCompactDebugString([value]);
        expect(toCompactDebugString(value)).toBe(nested.slice(1, -1));
      }
    });

    describe("with `maxLength`", () => {
      it("renders the full text given a `maxLength` of `Infinity`", () => {
        const item = { text: "x".repeat(200) };
        expect(toCompactDebugString(item, { maxLength: Infinity }))
          .toBe(toCompactDebugString(item));
      });

      for (const len of [10, 25, 100]) {
        it(`renders the full text when a \`maxLength\` of ${len} fits the whole thing`, () => {
          const item = ["xy", NaN];
          const expected = '["xy",NaN]'; // Note: Length 10.
          expect(toCompactDebugString(item, { maxLength: len })).toBe(expected);
        });

        it(`truncates to a \`maxLength\` of ${len} when it is smaller than the whole rendered length`, () => {
          const largeString = "This is a very large string! ".repeat(40);
          const item = { a: 123, b: 456, c: 789, d: largeString };
          const whole = toCompactDebugString(item);
          const expected = whole.slice(0, len - 3) + "...";
          expect(whole.length).toBeGreaterThan(len);
          expect(toCompactDebugString(item, { maxLength: len })).toBe(expected);
          expect(toCompactDebugString(item, { maxLength: len }).length).toBe(
            len,
          );
        });
      }
    });

    it("renders a `FabricPrimitive` whose state holds itself down to the depth limit", () => {
      class Circular extends FabricPrimitive {
        get schemaType(): never {
          throw new Error("Unimplemented.");
        }

        static get [REALM_CODEC]() {
          return {
            tagForValue: () => "Circular@1",
            encode: () => {
              const state: Record<string, unknown> = { n: 1 };
              state.self = state;
              return state;
            },
          };
        }
      }

      expect(toCompactDebugString(new Circular(), { maxDepth: 2 }))
        .toBe("/Circular(n:1,self:{n:1,self:...})");
    });

    describe("with `maxBufferLength`", () => {
      it("renders no more than 100000 bytes given a larger limit", () => {
        const value = new FabricBytes(new Uint8Array(100001));
        for (const limit of [500000, Infinity]) {
          const result = toCompactDebugString(value, {
            maxBufferLength: limit,
          });
          const [hex, elision] = result.split(" ...");
          expect(hex?.match(/[0-9a-f]{2}/g)?.length).toBe(100000);
          expect(elision).toBe("length:100001])");
        }
      });
    });

    describe("with `backtickQuote`", () => {
      it("renders the truncated result as the code span, when both are asked for", () => {
        const options = { maxLength: 8, backtickQuote: true };
        expect(toCompactDebugString({ abc: "defghij" }, options))
          .toBe("`{abc:...`");
      });

      it("renders the result bare when the option is `false` or absent", () => {
        expect(toCompactDebugString({ a: 1 }, { backtickQuote: false }))
          .toBe("{a:1}");
        expect(toCompactDebugString({ a: 1 })).toBe("{a:1}");
      });
    });

    it("throws given a limit that is not a positive integer", () => {
      const names = [
        "maxDepth",
        "maxArrayLength",
        "maxBufferLength",
        "maxProperties",
        "maxStringLength",
        "maxStringLines",
      ];
      for (const name of names) {
        expect(() => toCompactDebugString({}, { [name]: 0 })).toThrow(
          `\`${name}\` must be a positive integer, \`Infinity\`, or`,
        );
      }
    });

    it("throws given `options` that are not a plain object", () => {
      expect(() =>
        toCompactDebugString({}, 20 as unknown as CompactDebugStringOptions)
      ).toThrow("`options` must be a plain object or `undefined`; got `20`");
    });
  });

  describe("toIndentedDebugString", () => {
    it("renders a top-level scalar the same as the compact form does", () => {
      const values = [
        undefined,
        null,
        true,
        42,
        -0,
        NaN,
        42n,
        "str",
        Symbol.for("k"),
        Symbol("d"),
        new FabricEpochNsec(123n),
      ];
      for (const value of values) {
        expect(toIndentedDebugString(value)).toBe(toCompactDebugString(value));
      }
    });

    describe("with a string holding a line break", () => {
      it("renders each line quoted on a line of its own, joined by ` +`", () => {
        expect(toIndentedDebugString("a\nb\nc"))
          .toBe('"a\\n" +\n  "b\\n" +\n  "c"');
      });

      it("renders the lines after the first one level further in than the value", () => {
        expect(toIndentedDebugString({ s: "a\nb" }))
          .toBe('{\n  s: "a\\n" +\n    "b"\n}');
        expect(toIndentedDebugString({ o: { s: "a\nb" } }))
          .toBe('{\n  o: {\n    s: "a\\n" +\n      "b"\n  }\n}');
        expect(toIndentedDebugString(["a\nb"]))
          .toBe('[\n  "a\\n" +\n    "b"\n]');
      });

      it("renders a carriage return, with or without a newline, as a line break", () => {
        expect(toIndentedDebugString("a\r\nb\rc"))
          .toBe('"a\\r\\n" +\n  "b\\r" +\n  "c"');
      });

      it("renders a string ending in a line break with no empty line after it", () => {
        expect(toIndentedDebugString("a\nb\n")).toBe('"a\\n" +\n  "b\\n"');
        expect(toIndentedDebugString("a\n")).toBe('"a\\n"');
      });

      it("renders a class instance's `toString()` form the same way", () => {
        class Foo {
          toString() {
            return "a\nb";
          }
        }
        expect(toIndentedDebugString({ foo: new Foo() }))
          .toBe('{\n  foo: /Foo("a\\n" +\n    "b")\n}');
      });
    });

    it("throws given `options` that are not a plain object", () => {
      expect(() =>
        toIndentedDebugString({}, null as unknown as DebugValueOptions)
      ).toThrow("`options` must be a plain object or `undefined`; got `null`");
    });
  });

  describe("toShortQuotedDebugString", () => {
    it("returns the compact rendering as a backtick-quoted code span", () => {
      expect(toShortQuotedDebugString({ a: [1, "x"] })).toBe('`{a:[1,"x"]}`');
    });

    it("returns a rendering cut to fifty characters, ellipsis included", () => {
      const value = { text: "x".repeat(100) };
      const whole = toCompactDebugString(value);
      expect(whole.length).toBeGreaterThan(50);
      expect(toShortQuotedDebugString(value)).toBe(
        `\`${whole.slice(0, 47)}...\``,
      );
    });

    it("returns a quoted rendering for a value the renderer cannot read", () => {
      const value = {
        get boom(): number {
          throw new Error("nope");
        },
      };
      expect(toShortQuotedDebugString(value)).toBe(
        '`{boom:/unconvertible("nope")}`',
      );
    });
  });

  describe("toLongQuotedDebugString", () => {
    it("returns the compact rendering as a backtick-quoted code span", () => {
      expect(toLongQuotedDebugString({ a: [1, "x"] })).toBe('`{a:[1,"x"]}`');
    });

    it("returns a rendering the short form would cut, whole", () => {
      const value = { text: "x".repeat(100) };
      const whole = toCompactDebugString(value);
      expect(whole.length).toBeGreaterThan(50);
      expect(toLongQuotedDebugString(value)).toBe(`\`${whole}\``);
    });

    it("returns a rendering cut to five hundred characters, ellipsis included", () => {
      const value = Array.from({ length: 100 }, () => "abcdef");
      const whole = toCompactDebugString(value);
      expect(whole.length).toBeGreaterThan(500);
      expect(toLongQuotedDebugString(value)).toBe(
        `\`${whole.slice(0, 497)}...\``,
      );
    });
  });

  describe("custom inspector", () => {
    // Without the inspector these all render as `{}`: state lives in private
    // fields, which have no enumerable own properties for an inspector to find.

    it("renders a FabricPrimitive as its debug string, not `{}`", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Deno.inspect(bytes)).toBe("/Bytes(buf[010203])");
    });

    it("renders a FabricInstance as its debug string, not `{}`", () => {
      const link = new FabricLink({
        id: "of:fid1:abc",
        path: ["x"],
        space: "did:key:z",
      });
      expect(Deno.inspect(link))
        .toBe('/Link(id:"of:fid1:abc",path:["x"],space:"did:key:z")');
    });

    it("renders when nested in containers", () => {
      const bytes = new FabricBytes(new Uint8Array([9]));
      expect(Deno.inspect({ blob: bytes })).toBe("{ blob: /Bytes(buf[09]) }");
      expect(Deno.inspect([bytes, bytes]))
        .toBe("[ /Bytes(buf[09]), /Bytes(buf[09]) ]");
    });
  });
});
