/**
 * An immutable byte sequence, and the copying that immutability costs.
 *
 * The constructor cannot simply hold the array it was handed, since the caller
 * still has a reference and could write through it, so the bytes are copied in
 * -- with an opt-in transfer for a caller willing to give up its own access.
 * Reads pay the same way round: a slice hands back a copy rather than a view.
 *
 * The cases that need stating are where a byte count meets an empty or
 * exhausted range. Empty bytes encode to the empty string, and a copy whose
 * offset is at or past the end copies nothing rather than failing.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common/index.ts";
import { FabricBytes } from "@/fabric-primitives/index.ts";
import { FabricInstance, FabricPrimitive } from "@/index.ts";

describe("FabricBytes", () => {
  it("extends `FabricPrimitive` (not `FabricInstance`)", () => {
    // Pure type-identity / supertype check: cross-cutting carve-out per the
    // rule (doesn't fit a single member, isn't construction mechanics).

    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(fb instanceof FabricPrimitive).toBe(true);
    expect(fb instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Object.isFrozen(fb)).toBe(true);
    });

    it("copies the input bytes", () => {
      const original = new Uint8Array([1, 2, 3]);
      const fb = new FabricBytes(original);
      original[0] = 99; // mutate original
      expect(fb.slice()[0]).toBe(1); // unaffected
    });

    it("leaves the source array readable, by default", () => {
      const original = new Uint8Array([1, 2, 3]);
      new FabricBytes(original);
      expect(original.length).toBe(3);
    });

    it("consumes the source array, given `transfer` as `true`", () => {
      const original = new Uint8Array([1, 2, 3]);
      const fb = new FabricBytes(original, true);

      expect(original.length).toBe(0); // Its buffer was detached.
      expect(fb.slice()).toEqual(new Uint8Array([1, 2, 3]));
      expect(fb.length).toBe(3);
    });

    it("accepts a bare `ArrayBuffer` as the source", () => {
      const original = Uint8Array.from([1, 2, 3]).buffer;
      const fb = new FabricBytes(original);

      expect(fb.length).toBe(3);
      expect(fb.slice()).toEqual(new Uint8Array([1, 2, 3]));
      new Uint8Array(original)[0] = 99; // Mutate original.
      expect(fb.slice()[0]).toBe(1); // Unaffected.
    });

    it("consumes a bare `ArrayBuffer` source, given `transfer` as `true`", () => {
      const original = Uint8Array.from([1, 2, 3]).buffer;
      const fb = new FabricBytes(original, true);

      expect(original.detached).toBe(true);
      expect(fb.slice()).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("round-trips the buffer that `sliceBuffer()` produces", () => {
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      const again = new FabricBytes(fb.sliceBuffer(), true);

      expect(again.slice()).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricBytes`", () => {
        expect(new FabricBytes(new Uint8Array()).schemaType).toBe(
          "FabricBytes",
        );
      });
    });

    describe(".length", () => {
      it("returns the byte count", () => {
        expect(new FabricBytes(new Uint8Array([1, 2, 3])).length).toBe(3);
        expect(new FabricBytes(new Uint8Array()).length).toBe(0);
      });
    });

    describe("slice()", () => {
      it("returns a copy of the bytes", () => {
        const original = new Uint8Array([10, 20, 30]);
        const fb = new FabricBytes(original);
        const sliced = fb.slice();
        expect(sliced).toEqual(new Uint8Array([10, 20, 30]));
        // Must be a copy, not the same reference.
        sliced[0] = 99;
        expect(fb.slice()[0]).toBe(10);
      });

      it("returns a sub-range given start and end", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));
        expect(fb.slice(1, 3)).toEqual(new Uint8Array([2, 3]));
        expect(fb.slice(3)).toEqual(new Uint8Array([4, 5]));
      });
    });

    describe("sliceBuffer()", () => {
      it("returns the bytes as a bare `ArrayBuffer`", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30]));
        const buffer = fb.sliceBuffer();

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect([...new Uint8Array(buffer)]).toEqual([10, 20, 30]);
      });

      it("returns a buffer covering exactly the requested range", () => {
        // What makes the result transferable outright: a transfer hands over
        // a whole buffer, so any excess would cede bytes not asked for.
        const fb = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));

        expect(fb.sliceBuffer().byteLength).toBe(5);
        expect(fb.sliceBuffer(1, 3).byteLength).toBe(2);
      });

      it("returns a copy, leaving the instance intact", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30]));
        const view = new Uint8Array(fb.sliceBuffer());

        view[0] = 99;

        expect(fb.slice()[0]).toBe(10);
      });

      it("resolves `start` and `end` as `slice()` does", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));

        for (const range of [[], [1, 3], [3], [-2], [1, -1], [0, 0]]) {
          const viaBuffer = new Uint8Array(
            fb.sliceBuffer(...range as [number?, number?]),
          );

          expect([...viaBuffer]).toEqual([
            ...fb.slice(...range as [number?, number?]),
          ]);
        }
      });

      it("returns an empty buffer for empty bytes", () => {
        expect(new FabricBytes(new Uint8Array()).sliceBuffer().byteLength)
          .toBe(0);
      });
    });

    describe("copyInto()", () => {
      it("copies bytes into the target", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40]));
        const target = new Uint8Array(4);
        const copied = fb.copyInto(target);
        expect(copied).toBe(4);
        expect(target).toEqual(new Uint8Array([10, 20, 30, 40]));
      });

      it("respects offset and length", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40, 50]));
        const target = new Uint8Array(2);
        const copied = fb.copyInto(target, 1, 2);
        expect(copied).toBe(2);
        expect(target).toEqual(new Uint8Array([20, 30]));
      });

      it("throws on negative offset", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array(3);
        expect(() => fb.copyInto(target, -1)).toThrow(RangeError);
      });

      it("throws on negative length", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array(3);
        expect(() => fb.copyInto(target, 0, -1)).toThrow(RangeError);
      });

      it("copies nothing when the offset is at or past the end", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array([9, 9, 9]);

        expect(fb.copyInto(target, 3)).toBe(0);
        expect(fb.copyInto(target, 4)).toBe(0);
        expect(target).toEqual(new Uint8Array([9, 9, 9]));
      });

      it("copies nothing from an empty source", () => {
        const fb = new FabricBytes(new Uint8Array());
        const target = new Uint8Array([9]);

        expect(fb.copyInto(target)).toBe(0);
        expect(target).toEqual(new Uint8Array([9]));
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricBytes[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Bytes;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Bytes` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricBytes`, rejecting other values", () => {
          expect(codec.canEncode(new FabricBytes(new Uint8Array([1, 2, 3]))))
            .toBe(true);
          expect(codec.canEncode("not bytes")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to an unpadded base64url string", () => {
          // [1, 2, 3] -> base64url "AQID".
          const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
          expect(codec.encode(fb, env)).toBe("AQID");
        });

        it("encodes empty bytes to the empty string", () => {
          const fb = new FabricBytes(new Uint8Array());
          expect(codec.encode(fb, env)).toBe("");
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for string state", () => {
          expect(codec.canDecode("AQID")).toBe(true);
        });

        it("returns `false` for state that is not a string", () => {
          expect(codec.canDecode(42)).toBe(false);
        });
      });

      describe("decode()", () => {
        it("decodes malformed base64 to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            "not valid base64!!",
            env,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips via encode -> decode", () => {
          const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40]));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(fb, env),
            env,
          ) as unknown as FabricBytes;
          expect(decoded).toBeInstanceOf(FabricBytes);
          expect(decoded.slice()).toEqual(new Uint8Array([10, 20, 30, 40]));
        });

        it("round-trips empty bytes", () => {
          const fb = new FabricBytes(new Uint8Array());
          const decoded = codec.decode(
            expectedTag,
            codec.encode(fb, env),
            env,
          ) as unknown as FabricBytes;
          expect(decoded).toBeInstanceOf(FabricBytes);
          expect(decoded.length).toBe(0);
        });
      });
    });
  });
});
