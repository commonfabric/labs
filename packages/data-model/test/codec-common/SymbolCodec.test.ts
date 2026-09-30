/**
 * Symbols on the wire, which is possible only because the registry makes some
 * of them nameable.
 *
 * An interned symbol is fully described by its key, so encoding is writing
 * that key down and decoding is asking the registry for the same symbol back.
 * Encoding and decoding here happen in one realm, which is why the round trip
 * returns the identical instance: `Symbol.for()` reaches one registry per
 * agent, and what a codec promises across a boundary is internedness rather
 * than identity. A unique symbol has no key, and is refused because nothing
 * about it could be written down and recovered.
 *
 * The codec is generic over the encoded type, so this instantiates it at one
 * and the behavior is the same at any.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC_TYPE_TAGS,
  NULL_LIVE_ENVIRONMENT,
  SymbolCodec,
} from "@/codec-common";
import type { JsonCodecValue } from "@/codec-json/interface.ts";

// An `Encoded` that cannot hold a registry key cannot be constructed at, since
// the format has to hand in the embedding and no honest one exists. This covers
// `never` as well, which no `extends` clause can exclude. Each line is its own
// differential: `@ts-expect-error` fails when the line it marks stops erroring.
// @ts-expect-error -- no `(key: string) => number` exists.
const _refusesNumber = new SymbolCodec<number>((key) => key);
// @ts-expect-error -- nor a `(key: string) => never`.
const _refusesNever = new SymbolCodec<never>((key) => key);
// A format cannot wrap the key in something its own union admits either, since
// `decode()` accepts only a string and would refuse what that emitted.
// @ts-expect-error -- an object is not `JsonCodecValue & string`.
const _refusesAWrapper = new SymbolCodec<JsonCodecValue>((key) => ({ key }));

describe("SymbolCodec", () => {
  const codec = new SymbolCodec<JsonCodecValue>((key) => key);
  const expectedTag = CODEC_TYPE_TAGS.Symbol;
  const env = NULL_LIVE_ENVIRONMENT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `Symbol` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims interned symbols, rejects unique ones", () => {
        // Unique symbols have no registry key, so the codec declines them; this
        // is what lets a default-configured environment fail loudly rather than
        // silently flatten the symbol.
        expect(codec.canEncode(Symbol("nope"))).toBe(false);
        // Registry-interned symbols are claimed.
        expect(codec.canEncode(Symbol.for("yes"))).toBe(true);
      });
    });

    describe("encode()", () => {
      it('encodes `Symbol.for("foo")` to its registry key', () => {
        expect(codec.encode(Symbol.for("foo"), env)).toBe("foo");
      });

      it('encodes `Symbol.for("")` (empty key)', () => {
        expect(codec.encode(Symbol.for(""), env)).toBe("");
      });
    });

    describe("canDecode()", () => {
      it("returns `true` for string state", () => {
        expect(codec.canDecode("some-key")).toBe(true);
      });

      it("returns `false` for state that is not a string", () => {
        expect(codec.canDecode(42)).toBe(false);
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips an interned symbol to the same registry instance", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(Symbol.for("hello"), env),
          env,
        );
        expect(typeof result).toBe("symbol");
        expect(result).toBe(Symbol.for("hello"));
      });

      it("round-trips a key with non-ASCII characters", () => {
        const key = "café-☕-\u{1F600}";
        const result = codec.decode(
          expectedTag,
          codec.encode(Symbol.for(key), env),
          env,
        );
        expect(result).toBe(Symbol.for(key));
      });
    });
  });
});
