/**
 * A hash as a `FabricPrimitive`: bytes, plus the tag naming the algorithm
 * that produced them.
 *
 * The tag is part of the value rather than decoration on it, which is why the
 * string form carries it, why parsing rejects a string with no tag or with
 * more than one separator, and why a tag other than the usual one has to
 * survive a round trip rather than being normalized away.
 *
 * It hands out copies rather than views, and takes ownership of its input only
 * when a caller explicitly transfers it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@/codec-common";
import { FabricHash } from "@/fabric-primitives";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);

for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

/** A fixed 17-byte hash for deterministic tests. */
const SAMPLE_HASH_17 = new Uint8Array(17);

for (let i = 0; i < 17; i++) SAMPLE_HASH_17[i] = ((i * 17) + 177) & 0xff;

describe("FabricHash", () => {
  describe("constructor()", () => {
    it("leaves the source array readable, by default", () => {
      const source = new Uint8Array([1, 2, 3]);
      const cid = new FabricHash(source, "fid1");

      expect(source.length).toBe(3);
      source[0] = 99;
      expect(cid.bytes[0]).toBe(1);
    });

    it("consumes the source array, given `transfer` as `true`", () => {
      const source = new Uint8Array([1, 2, 3]);
      const cid = new FabricHash(source, "fid1", true);

      expect(source.length).toBe(0); // Its buffer was detached.
      expect(cid.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(cid.length).toBe(3);
    });

    it("accepts a bare `ArrayBuffer` as the source", () => {
      const source = Uint8Array.from([1, 2, 3]).buffer;
      const cid = new FabricHash(source, "fid1");

      expect(cid.length).toBe(3);
      new Uint8Array(source)[0] = 99;
      expect(cid.bytes[0]).toBe(1);
    });

    it("consumes a bare `ArrayBuffer` source, given `transfer` as `true`", () => {
      const source = Uint8Array.from([1, 2, 3]).buffer;
      const cid = new FabricHash(source, "fid1", true);

      expect(source.detached).toBe(true);
      expect(cid.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("caches a string form agreeing with `.bytes`, given `transfer` as `true`", () => {
      const transferred = new FabricHash(
        new Uint8Array([1, 2, 3]),
        "fid1",
        true,
      );
      const copied = new FabricHash(new Uint8Array([1, 2, 3]), "fid1");

      expect(transferred.hashString).toBe(copied.hashString);
      expect(transferred.taggedHashString).toBe(copied.taggedHashString);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricHash`", () => {
        expect(new FabricHash(SAMPLE_HASH, "fid1").schemaType).toBe(
          "FabricHash",
        );
      });
    });

    describe("toString()", () => {
      it("produces `fid1:<base64>` format", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const str = cid.toString();
        expect(str.startsWith("fid1:")).toBe(true);
      });
    });

    describe(".taggedHashString", () => {
      it("produces `fid1:<base64>` format", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const str = cid.taggedHashString;
        expect(str.startsWith("fid1:")).toBe(true);
      });
    });

    describe(".bytes", () => {
      it("returns a defensive copy", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const bytes = cid.bytes;
        // Contents match.
        expect(bytes).toEqual(SAMPLE_HASH);
        // Each call returns a fresh copy.
        expect(bytes).not.toBe(cid.bytes);
        // Mutating the copy must not affect the original.
        bytes[0] = 0xff;
        expect(cid.bytes[0]).toBe(0);
      });
    });

    describe(".length", () => {
      it("returns the byte length of `.bytes`", () => {
        const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
        expect(cid1.length).toEqual(cid1.bytes.length);

        const cid2 = new FabricHash(SAMPLE_HASH_17, "fake17");
        expect(cid2.length).toEqual(17);
        expect(cid2.length).toEqual(cid2.bytes.length);
      });
    });

    describe("copyInto()", () => {
      it("copies hash bytes into the target buffer", () => {
        const cid = new FabricHash(SAMPLE_HASH, "sha3");
        const target = new Uint8Array(32);
        const returned = cid.copyInto(target);
        // Returns the same target buffer.
        expect(returned).toBe(target);
        expect(target).toEqual(cid.bytes);
        expect(cid.tag).toBe("sha3");
      });
    });

    describe(".hashString", () => {
      it("returns base64url without the algorithm tag", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const hs = cid.hashString;
        // Must be a string, not contain the algorithm tag prefix.
        expect(typeof hs).toBe("string");
        expect(hs.includes("fid1")).toBe(false);
        expect(hs.includes(":")).toBe(false);
        // toString() should be tag + ":" + hashString.
        expect(cid.toString()).toBe(`fid1:${hs}`);
      });

      it("is stable across calls", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        expect(cid.hashString).toBe(cid.hashString);
      });

      it("differs for different hashes", () => {
        const hash2 = new Uint8Array(32);
        hash2.fill(0xff);
        const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
        const cid2 = new FabricHash(hash2, "fid1");
        expect(cid1.hashString).not.toBe(cid2.hashString);
      });
    });
  });

  describe("static members", () => {
    describe("fromString()", () => {
      it("round-trips through the instance method `toString()`", () => {
        // Use a non-fid1 tag to verify the parser doesn't hardcode it.
        const original = new FabricHash(SAMPLE_HASH, "sha3");
        const str = original.toString();
        const reconstructed = FabricHash.fromString(str);

        expect(reconstructed).toBeInstanceOf(FabricHash);
        expect(reconstructed.toString()).toBe(original.toString());
        expect(reconstructed.bytes).toEqual(original.bytes);
        expect(reconstructed.tag).toBe("sha3");
      });

      it("throws on invalid format (no colon)", () => {
        expect(() => FabricHash.fromString("nocolonhere")).toThrow(
          "Invalid content hash string",
        );
      });

      it("throws on a source with more than one colon", () => {
        // A tagged hash has exactly one colon, so a second one lands in the
        // hash segment, where base64url rejects it. No message is asserted:
        // the contract is the rejection, not which layer voices it.
        //
        // Each tail below is itself valid base64url, so these fail only
        // because of WHERE the split happens. That is deliberate: a tail like
        // `c` throws under any split (as an invalid base64 length), and so
        // would pass whether or not the parser is correct.
        expect(() => FabricHash.fromString("a:b:AAAA")).toThrow();
        expect(() => FabricHash.fromString("x::AAAA")).toThrow();

        // A well-formed tagged hash with anything prefixed onto it is, of
        // course, not a tagged hash.
        const tagged = new FabricHash(SAMPLE_HASH, "fid1").toString();
        expect(() => FabricHash.fromString(`extra:${tagged}`)).toThrow();
      });
    });

    describe("[JSON_CODEC]", () => {
      const codec = FabricHash[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Hash;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Hash` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricHash`, rejecting other values", () => {
          expect(codec.canEncode(new FabricHash(SAMPLE_HASH, "fid1"))).toBe(
            true,
          );
          expect(codec.canEncode("not a hash")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a `{ tag, hash }` object", () => {
          const cid = new FabricHash(SAMPLE_HASH, "fid1");
          expect(codec.encode(cid, env)).toEqual({
            tag: "fid1",
            hash: cid.hashString,
          });
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record with string `tag` and `hash`", () => {
          expect(codec.canDecode({ tag: "fid1", hash: "AQID" })).toBe(true);
        });

        it("returns `false` for state that is not a record", () => {
          expect(codec.canDecode(123)).toBe(false);
        });

        it("returns `false` for a record missing a field", () => {
          expect(codec.canDecode({ tag: "fid1" })).toBe(false);
        });

        it("returns `false` for a record with a non-string field", () => {
          expect(codec.canDecode({ tag: "fid1", hash: 7 })).toBe(false);
        });
      });

      describe("decode()", () => {
        it("decodes a `{ tag, hash }` object back to a `FabricHash`", () => {
          const cid = new FabricHash(SAMPLE_HASH, "fid1");
          const decoded = codec.decode(
            expectedTag,
            { tag: "fid1", hash: cid.hashString },
            env,
          );
          expect(decoded).toBeInstanceOf(FabricHash);
          expect((decoded as FabricHash).taggedHashString).toBe(
            cid.taggedHashString,
          );
        });

        it("decodes a malformed base64 `hash` to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            { tag: "fid1", hash: "not valid base64!!" },
            env,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips via encode -> decode (non-`fid1` tag)", () => {
          const cid = new FabricHash(SAMPLE_HASH_17, "sha3");
          const decoded = codec.decode(
            expectedTag,
            codec.encode(cid, env),
            env,
          );
          expect(decoded).toBeInstanceOf(FabricHash);
          expect((decoded as FabricHash).tag).toBe("sha3");
          expect((decoded as FabricHash).bytes).toEqual(cid.bytes);
        });
      });
    });
  });
});
