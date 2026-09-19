/**
 * A key pair as a `FabricPrimitive`, in either of the two states it can hold:
 * handles, whose material this realm may have no way to reach, and material,
 * the two keys as bytes.
 *
 * Which state an instance is in decides what it can do, and so most of what is
 * checked here. The accessor belonging to the other arm throws, the JSON codec
 * refuses handles outright, and the realm codec names each arm by the shape it
 * encodes to.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
  REALM_CODEC,
} from "@/codec-common/index.ts";
import type { RealmCodecValue } from "@/codec-realm/index.ts";
import { FabricBytes, FabricKeyPair } from "@/fabric-primitives/index.ts";
import { hashStringOf, isValidFabricValue } from "@/index.ts";

/** Fixed public-key bytes for deterministic tests. */
const PUBLIC_BYTES = new Uint8Array([1, 2, 3]);

/** Fixed private-key bytes for deterministic tests. */
const PRIVATE_BYTES = new Uint8Array([250, 251, 252, 253]);

/** Returns a fresh instance holding material. */
function materialPair(): FabricKeyPair {
  return new FabricKeyPair("ExampleAlgorithm", PUBLIC_BYTES, PRIVATE_BYTES);
}

/** A fixed non-extractable pair, so identity checks have a stable subject. */
const { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY } = await crypto.subtle
  .generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;

/** Returns a fresh non-extractable `CryptoKeyPair`. */
async function generatePair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

describe("FabricKeyPair", () => {
  describe("constructor()", () => {
    it("copies a `Uint8Array` argument", () => {
      const source = new Uint8Array([1, 2, 3]);
      const pair = new FabricKeyPair("ExampleAlgorithm", source, PRIVATE_BYTES);

      source[0] = 99;

      expect(pair.publicKeyBytes.slice()).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("retains a `FabricBytes` argument as it stands", () => {
      const bytes = new FabricBytes(PUBLIC_BYTES);
      const pair = new FabricKeyPair("ExampleAlgorithm", bytes, PRIVATE_BYTES);

      expect(pair.publicKeyBytes).toBe(bytes);
    });

    it("throws given an empty algorithm name", () => {
      expect(() => new FabricKeyPair("", PUBLIC_BYTES, PRIVATE_BYTES))
        .toThrow(/no algorithm name/);
    });

    it("throws given key material that is neither form of bytes", () => {
      expect(() =>
        new FabricKeyPair(
          "ExampleAlgorithm",
          "nope" as unknown as Uint8Array,
          PRIVATE_BYTES,
        )
      ).toThrow(/`publicKey`/);
    });

    it("takes its algorithm from a `CryptoKeyPair`", async () => {
      const pair = new FabricKeyPair(await generatePair());

      expect(pair.algorithm).toBe("Ed25519");
    });

    it("throws given a record whose values are not `CryptoKey`s", () => {
      expect(() =>
        new FabricKeyPair(
          { publicKey: 1, privateKey: 2 } as unknown as CryptoKeyPair,
        )
      ).toThrow(/Not a `CryptoKeyPair`/);
    });

    it("throws given two keys of the same kind", async () => {
      const { publicKey } = await generatePair();

      expect(() => new FabricKeyPair({ publicKey, privateKey: publicKey }))
        .toThrow(/keys are of type/);
    });

    it("throws given two keys whose algorithm parameters disagree", async () => {
      // The names agree and the key types are right, so this is refused by the
      // parameter check alone. A P-256 public key and a P-384 private key
      // cannot operate together.

      const { publicKey } = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      ) as CryptoKeyPair;
      const { privateKey } = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-384" },
        false,
        ["sign", "verify"],
      ) as CryptoKeyPair;

      expect(() => new FabricKeyPair({ publicKey, privateKey }))
        .toThrow(/Mismatched `ECDSA` algorithm parameters/);
    });

    it("accepts a pair whose algorithm carries nested parameters", async () => {
      // RSA's `algorithm` record carries a nested `hash` object and a
      // `publicExponent` byte array, both of which the parameter check
      // compares. A genuine pair reports them identically on both keys, so
      // deepening the check must not have made this one refusable.

      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        false,
        ["sign", "verify"],
      ) as CryptoKeyPair;

      expect(new FabricKeyPair(pair).algorithm).toBe("RSASSA-PKCS1-v1_5");
    });

    it("throws given two keys whose algorithm names disagree", async () => {
      const { publicKey } = await generatePair();
      const { privateKey } = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      ) as CryptoKeyPair;

      expect(() => new FabricKeyPair({ publicKey, privateKey }))
        .toThrow(/Mismatched algorithms/);
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricKeyPair`", () => {
        expect(materialPair().schemaType).toBe("FabricKeyPair");
      });
    });

    describe(".hasMaterial", () => {
      it("returns `true` for an instance built from bytes", () => {
        expect(materialPair().hasMaterial).toBe(true);
      });

      it("returns `false` for an instance built from a `CryptoKeyPair`", async () => {
        expect(new FabricKeyPair(await generatePair()).hasMaterial).toBe(false);
      });
    });

    describe(".cryptoKeyPair", () => {
      it("returns the two keys it was built from", async () => {
        const source = await generatePair();
        const pair = new FabricKeyPair(source);

        expect(pair.cryptoKeyPair.publicKey).toBe(source.publicKey);
        expect(pair.cryptoKeyPair.privateKey).toBe(source.privateKey);
      });

      it("returns a new record on each call", async () => {
        const pair = new FabricKeyPair(await generatePair());

        expect(pair.cryptoKeyPair).not.toBe(pair.cryptoKeyPair);
      });

      it("returns the same two `CryptoKey`s on each call", () => {
        // The other half of what the record's newness means: the wrapper is
        // fresh, its contents are not. A `CryptoKey` is an opaque handle, and
        // two calls handing back different handles would be a different
        // contract entirely.

        const source = { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY };
        const pair = new FabricKeyPair(source);

        expect(pair.cryptoKeyPair.publicKey).toBe(pair.cryptoKeyPair.publicKey);
        expect(pair.cryptoKeyPair.privateKey).toBe(
          pair.cryptoKeyPair.privateKey,
        );
      });

      it("throws for an instance holding material", () => {
        expect(() => materialPair().cryptoKeyPair).toThrow(/holds material/);
      });
    });

    describe(".publicCryptoKey", () => {
      it("returns the key it was built from", () => {
        const pair = new FabricKeyPair({
          publicKey: PUBLIC_KEY,
          privateKey: PRIVATE_KEY,
        });

        expect(pair.publicCryptoKey).toBe(PUBLIC_KEY);
      });

      it("throws for an instance holding material", () => {
        expect(() => materialPair().publicCryptoKey).toThrow(/holds material/);
      });
    });

    describe(".privateCryptoKey", () => {
      it("returns the key it was built from", () => {
        const pair = new FabricKeyPair({
          publicKey: PUBLIC_KEY,
          privateKey: PRIVATE_KEY,
        });

        expect(pair.privateCryptoKey).toBe(PRIVATE_KEY);
      });

      it("throws for an instance holding material", () => {
        expect(() => materialPair().privateCryptoKey).toThrow(/holds material/);
      });
    });

    describe(".publicKeyBytes", () => {
      it("returns the bytes it was built from", () => {
        expect(materialPair().publicKeyBytes.slice()).toEqual(PUBLIC_BYTES);
      });

      it("throws for an instance holding handles", async () => {
        const pair = new FabricKeyPair(await generatePair());

        expect(() => pair.publicKeyBytes).toThrow(/holds handles/);
      });
    });

    describe(".privateKeyBytes", () => {
      it("returns the bytes it was built from", () => {
        expect(materialPair().privateKeyBytes.slice()).toEqual(PRIVATE_BYTES);
      });

      it("throws for an instance holding handles", async () => {
        const pair = new FabricKeyPair(await generatePair());

        expect(() => pair.privateKeyBytes).toThrow(/holds handles/);
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricKeyPair[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.KeyPair;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `KeyPair` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricKeyPair`, rejecting other values", () => {
          expect(codec.canEncode(materialPair())).toBe(true);
          expect(codec.canEncode("not a key pair")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes material to an `{ algorithm, publicKey, privateKey }` object", () => {
          expect(codec.encode(materialPair(), env)).toEqual({
            algorithm: "ExampleAlgorithm",
            publicKey: "AQID",
            privateKey: "-vv8_Q",
          });
        });

        it("throws for an instance holding handles", async () => {
          const pair = new FabricKeyPair(await generatePair());

          expect(() => codec.encode(pair, env)).toThrow(
            /no JSON representation/,
          );
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record of three strings", () => {
          expect(
            codec.canDecode({
              algorithm: "ExampleAlgorithm",
              publicKey: "AQID",
              privateKey: "AQID",
            }),
          ).toBe(true);
        });

        it("returns `false` for state that is not a record", () => {
          expect(codec.canDecode(123)).toBe(false);
        });

        it("returns `false` for a record missing a field", () => {
          expect(
            codec.canDecode({
              algorithm: "ExampleAlgorithm",
              publicKey: "AQID",
            }),
          )
            .toBe(false);
        });

        it("returns `false` for a record with a non-string field", () => {
          expect(
            codec.canDecode({
              algorithm: "ExampleAlgorithm",
              publicKey: "AQID",
              privateKey: 7,
            }),
          ).toBe(false);
        });
      });

      describe("decode()", () => {
        it("decodes malformed base64url to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            {
              algorithm: "ExampleAlgorithm",
              publicKey: "not valid base64!!",
              privateKey: "AQID",
            },
            env,
          );

          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips an instance holding material", () => {
          const decoded = codec.decode(
            expectedTag,
            codec.encode(materialPair(), env),
            env,
          ) as FabricKeyPair;

          expect(decoded).toBeInstanceOf(FabricKeyPair);
          expect(decoded.algorithm).toBe("ExampleAlgorithm");
          expect(decoded.publicKeyBytes.slice()).toEqual(PUBLIC_BYTES);
          expect(decoded.privateKeyBytes.slice()).toEqual(PRIVATE_BYTES);
        });
      });
    });

    describe("[REALM_CODEC]", () => {
      const codec = FabricKeyPair[REALM_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.KeyPair;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("encode()", () => {
        it("encodes material to transferable `ArrayBuffer`s", () => {
          const state = codec.encode(materialPair(), env) as {
            algorithm: string;
            publicKey: ArrayBuffer;
            privateKey: ArrayBuffer;
          };

          expect(state.algorithm).toBe("ExampleAlgorithm");
          expect(state.publicKey).toBeInstanceOf(ArrayBuffer);
          expect(state.privateKey).toBeInstanceOf(ArrayBuffer);
          expect([...new Uint8Array(state.publicKey)]).toEqual([1, 2, 3]);
          expect([...new Uint8Array(state.privateKey)]).toEqual([
            250,
            251,
            252,
            253,
          ]);
        });

        it("encodes handles to the `CryptoKey`s themselves", async () => {
          const source = await generatePair();
          const state = codec.encode(new FabricKeyPair(source), env) as {
            algorithm?: string;
            publicKey: CryptoKey;
            privateKey: CryptoKey;
          };

          expect(state.publicKey).toBe(source.publicKey);
          expect(state.privateKey).toBe(source.privateKey);
          // No algorithm field: each `CryptoKey` carries its own, which is
          // what the reconstructed pair reads it from.
          expect(state.algorithm).toBe(undefined);
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a material state", () => {
          expect(codec.canDecode(codec.encode(materialPair(), env))).toBe(true);
        });

        it("returns `true` for a handle state", async () => {
          const state = codec.encode(
            new FabricKeyPair(await generatePair()),
            env,
          );

          expect(codec.canDecode(state)).toBe(true);
        });

        it("returns `false` for a handle state carrying an algorithm", async () => {
          const { publicKey, privateKey } = await generatePair();

          expect(
            codec.canDecode({
              algorithm: "ExampleAlgorithm",
              publicKey,
              privateKey,
            }),
          ).toBe(false);
        });

        it("returns `false` for a material state whose keys are not buffers", () => {
          expect(
            codec.canDecode({
              algorithm: "ExampleAlgorithm",
              // A bare view rather than a buffer, which is not a form this
              // format emits.
              publicKey: new Uint8Array([1]),
              privateKey: new Uint8Array([2]),
            } as unknown as RealmCodecValue),
          ).toBe(false);
        });

        it("returns `false` for a material state with an empty algorithm", () => {
          // The one thing the constructor refuses about an algorithm name.
          // Left to `decode()`, it would arrive as a constructor throw, which
          // that method reports as a detached buffer.

          expect(
            codec.canDecode({
              algorithm: "",
              publicKey: new ArrayBuffer(1),
              privateKey: new ArrayBuffer(1),
            }),
          ).toBe(false);
        });

        it("returns `false` for state that is not a record", () => {
          expect(codec.canDecode(123)).toBe(false);
        });
      });

      describe("decode()", () => {
        it("throws given a state whose buffers are already spent", () => {
          const state = codec.encode(materialPair(), env);

          codec.decode(expectedTag, state as never, env);

          expect(() => codec.decode(expectedTag, state as never, env))
            .toThrow(/detached/);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips an instance holding material", () => {
          const decoded = codec.decode(
            expectedTag,
            codec.encode(materialPair(), env) as never,
            env,
          ) as FabricKeyPair;

          expect(decoded).toBeInstanceOf(FabricKeyPair);
          expect(decoded.hasMaterial).toBe(true);
          expect(decoded.algorithm).toBe("ExampleAlgorithm");
          expect(decoded.publicKeyBytes.slice()).toEqual(PUBLIC_BYTES);
          expect(decoded.privateKeyBytes.slice()).toEqual(PRIVATE_BYTES);
        });

        it("round-trips an instance holding handles", async () => {
          const source = await generatePair();
          const decoded = codec.decode(
            expectedTag,
            codec.encode(new FabricKeyPair(source), env) as never,
            env,
          ) as FabricKeyPair;

          expect(decoded).toBeInstanceOf(FabricKeyPair);
          expect(decoded.hasMaterial).toBe(false);
          expect(decoded.algorithm).toBe("Ed25519");
          expect(decoded.cryptoKeyPair.privateKey).toBe(source.privateKey);
        });
      });
    });
  });

  describe("as a `FabricValue`", () => {
    it("returns `true` from `isValidFabricValue()` in either state", async () => {
      // An instance in either state has to pass the vetting boundary. The
      // realm encoding does not vet what it passes through, so a value that
      // fails here can still cross and still work, right up until something
      // checks it.

      expect(isValidFabricValue(materialPair())).toBe(true);
      expect(isValidFabricValue(new FabricKeyPair(await generatePair())))
        .toBe(true);
    });

    it("has no own properties at all", async () => {
      // State lives in private fields and reaches a caller through prototype
      // accessors, so a structural view of an instance sees nothing -- which
      // is what keeps an own accessor property off it.

      expect(Object.getOwnPropertyNames(materialPair())).toEqual([]);
      expect(
        Object.getOwnPropertyNames(new FabricKeyPair(await generatePair())),
      ).toEqual([]);
    });

    it("refuses every accessor belonging to the other arm", async () => {
      // Both directions, and every accessor, so that adding one to a class
      // whose whole contract is "the other arm's accessors throw" cannot
      // quietly leave the new one answering for both states.

      const handles = new FabricKeyPair(await generatePair());
      const material = materialPair();

      for (
        const name of [
          "cryptoKeyPair",
          "publicCryptoKey",
          "privateCryptoKey",
        ] as const
      ) {
        expect(() => material[name]).toThrow(/holds material/);
        expect(handles[name]).toBeDefined();
      }

      for (const name of ["publicKeyBytes", "privateKeyBytes"] as const) {
        expect(() => handles[name]).toThrow(/holds handles/);
        expect(material[name]).toBeDefined();
      }
    });

    it("is frozen on construction", () => {
      expect(Object.isFrozen(materialPair())).toBe(true);
    });
  });

  describe("hashing", () => {
    it("hashes two instances holding equal material alike", () => {
      expect(hashStringOf(materialPair())).toBe(hashStringOf(materialPair()));
    });

    it("hashes instances differing only in algorithm differently", () => {
      const other = new FabricKeyPair(
        "OtherAlgorithm",
        PUBLIC_BYTES,
        PRIVATE_BYTES,
      );

      expect(hashStringOf(materialPair())).not.toBe(hashStringOf(other));
    });

    it("hashes instances differing only in a key differently", () => {
      const other = new FabricKeyPair(
        "ExampleAlgorithm",
        PUBLIC_BYTES,
        new Uint8Array([250, 251, 252, 254]),
      );

      expect(hashStringOf(materialPair())).not.toBe(hashStringOf(other));
    });

    it("hashes a swapped pair differently from the original", () => {
      // The two keys are fed in a fixed order, so a pair holding them the
      // other way round is a different value rather than the same one.

      const swapped = new FabricKeyPair(
        "ExampleAlgorithm",
        PRIVATE_BYTES,
        PUBLIC_BYTES,
      );

      expect(hashStringOf(materialPair())).not.toBe(hashStringOf(swapped));
    });

    it("throws for an instance holding handles", async () => {
      const pair = new FabricKeyPair(await generatePair());

      expect(() => hashStringOf(pair)).toThrow(/cannot hash a key pair/);
    });
  });
});
