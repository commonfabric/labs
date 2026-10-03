/**
 * Holds `test/fixtures/fvj1-conformance.json` to this package's JSON codec in
 * both directions: the file must be what the conformance cases generate, and
 * every encode and decode it records must be what the codec does, read from
 * the file alone.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricInstance, FabricValue } from "@";
import { UnknownValue } from "@/codec-common";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { fabricInstanceClassesByName } from "@/fabric-instances";
import {
  FabricKeyPair,
  fabricPrimitiveClassesByName,
} from "@/fabric-primitives";
import {
  fabricValueOfFvj1DescriptorForTestingOnly,
  FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  type Fvj1ConformanceCase,
  fvj1ConformanceFixtureTextForTestingOnly,
  fvj1DecodeOutcomeOfForTestingOnly,
  type Fvj1Descriptor,
  fvj1DescriptorOfForTestingOnly,
  fvj1EncodeOutcomeOfForTestingOnly,
} from "@/for-testing-only.ts";

const FIXTURE_URL = new URL(
  "./fixtures/fvj1-conformance.json",
  import.meta.url,
);

/**
 * The classes whose codecs are stubs, which the conformance cases leave out
 * until the format writes them.
 */
const STUB_CODEC_CLASSES: ReadonlySet<string> = new Set([
  "FabricMap",
  "FabricSet",
]);

/** One entry of the fixture, as `fvj1-conformance.md` defines it. */
interface FixtureEntry {
  readonly name: string;
  readonly encode?: {
    readonly value: Fvj1Descriptor;
    readonly text?: string;
    readonly refused?: string;
  };
  readonly decode?: {
    readonly text: string;
    readonly value?: Fvj1Descriptor;
    readonly refused?: string;
  };
  readonly divergence?: {
    readonly encode?: Fvj1Descriptor;
    readonly decode?: Fvj1Descriptor;
  };
}

/** A `FabricInstance` of a class neither class table names. */
class OtherInstance extends BaseFabricInstance {
  //
  // Unreached stubs
  //
  // Describing an instance reads none of these.
  //

  [DEEP_FREEZE](_subFreeze: (value: FabricValue) => FabricValue): FabricValue {
    throw new Error("not implemented");
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("not implemented");
  }

  protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
    throw new Error("not implemented");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
    return new OtherInstance();
  }
}

/** Returns the outcome part of a fixture block: what follows from its input. */
function outcomeOf(
  block: {
    readonly value?: Fvj1Descriptor;
    readonly text?: string;
    readonly refused?: string;
  },
  outcomeKey: "text" | "value",
): Fvj1Descriptor {
  return (block.refused === undefined)
    ? { [outcomeKey]: block[outcomeKey] ?? null }
    : { refused: block.refused };
}

describe("fvj1-conformance", () => {
  const fixtureText = Deno.readTextFileSync(FIXTURE_URL);
  const entries: readonly FixtureEntry[] = JSON.parse(fixtureText).cases;

  it("is the fixture the conformance cases generate", () => {
    // On a failure here, `deno task regenerate-fvj1-conformance` rewrites the
    // file, and its diff is the change in the codec's behavior to review.

    expect(fixtureText).toBe(
      fvj1ConformanceFixtureTextForTestingOnly(
        FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
      ),
    );
  });

  it("records for each encode what the codec does with the value described", () => {
    for (const { name, encode, divergence } of entries) {
      if (encode === undefined) continue;
      const value = fabricValueOfFvj1DescriptorForTestingOnly(encode.value);
      expect({ name, outcome: fvj1EncodeOutcomeOfForTestingOnly(value) })
        .toEqual({
          name,
          outcome: divergence?.encode ?? outcomeOf(encode, "text"),
        });
    }
  });

  it("records for each decode what the codec does with the text", () => {
    for (const { name, decode, divergence } of entries) {
      if (decode === undefined) continue;
      expect({ name, outcome: fvj1DecodeOutcomeOfForTestingOnly(decode.text) })
        .toEqual({
          name,
          outcome: divergence?.decode ?? outcomeOf(decode, "value"),
        });
    }
  });

  it("holds descriptors that each describe the value they make", () => {
    for (const { name, encode } of entries) {
      if (encode === undefined) continue;
      const value = fabricValueOfFvj1DescriptorForTestingOnly(encode.value);
      expect({ name, descriptor: fvj1DescriptorOfForTestingOnly(value) })
        .toEqual({ name, descriptor: encode.value });
    }
  });

  it("throws given an array descriptor holding a hole run below one", () => {
    for (const count of [0, -1]) {
      expect(() =>
        fabricValueOfFvj1DescriptorForTestingOnly({
          array: [1, { hole: count }],
        })
      ).toThrow("Not a hole count");
    }
  });

  it("has a case whose value is an instance of each concrete class but those with stub codecs", () => {
    const values = FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY.flatMap((c) =>
      "make" in c ? [c.make()] : []
    );
    const classes = {
      ...fabricPrimitiveClassesByName(),
      ...fabricInstanceClassesByName(),
    };
    for (const [name, cls] of Object.entries(classes)) {
      expect({ name, covered: values.some((v) => v instanceof cls) })
        .toEqual({ name, covered: !STUB_CODEC_CLASSES.has(name) });
    }
  });

  describe("fvj1ConformanceFixtureTextForTestingOnly()", () => {
    it("throws given two cases of one name", () => {
      const cases: Fvj1ConformanceCase[] = [
        { name: "twice", section: "s", make: () => 1 },
        { name: "twice", section: "s", make: () => 2 },
      ];
      expect(() => fvj1ConformanceFixtureTextForTestingOnly(cases)).toThrow(
        "Two cases are named twice.",
      );
    });

    it("throws given a divergence on a value whose spec text is not computed", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          { name: "bigint", section: "s", make: () => 1n, divergence: "note" },
        ])
      ).toThrow("does not compute");
    });

    it("throws given a divergence on a value encoded as the spec says", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          { name: "one", section: "s", make: () => 1, divergence: "note" },
        ])
      ).toThrow("declares a divergence, but this implementation does what");
    });

    it("throws given a case both divergent and unspecified", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "both",
            section: "s",
            text: 'fvj1:{"/BigInt@1":"AAA"}',
            divergence: "note",
            unspecified: "note",
          },
        ])
      ).toThrow("declares a divergence from what it says the spec leaves open");
    });

    it("records an unspecified case's note beside this package's outcome", () => {
      const text = fvj1ConformanceFixtureTextForTestingOnly([
        { name: "open", section: "s", text: "fvj1:1", unspecified: "note" },
      ]);
      expect(JSON.parse(text).cases).toEqual([{
        name: "open",
        section: "s",
        decode: { text: "fvj1:1", value: 1 },
        encode: { value: 1, text: "fvj1:1" },
        unspecified: "note",
      }]);
    });

    it("throws given a value encoded unlike its computed spec text, with no divergence", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          { name: "keys", section: "s", make: () => ({ "2": 0, "10": 0 }) },
        ])
      ).toThrow('keys: encodes to {"text":"fvj1:{\\"2\\":0,\\"10\\":0}"}');
    });

    it("throws given a value whose text decodes to another value, with no divergence", () => {
      // An unknown value under a registered tag encodes to that tag's form,
      // which decodes to the registered class instead.

      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "masquerade",
            section: "s",
            make: () => new UnknownValue("Bytes@1", "AQ"),
          },
        ])
      ).toThrow("does not decode to the value it was encoded from");
    });
  });

  describe("fvj1EncodeOutcomeOfForTestingOnly()", () => {
    it("returns a refusal for a value the codec refuses", () => {
      expect(fvj1EncodeOutcomeOfForTestingOnly(Symbol("local"))).toEqual({
        refused: "unencodable",
      });
    });

    it("throws a fault in the codec rather than returning a refusal", () => {
      const faulty = {
        get a(): never {
          throw new TypeError("a fault");
        },
      };
      expect(() => fvj1EncodeOutcomeOfForTestingOnly(faulty)).toThrow(
        TypeError,
      );
    });
  });

  describe("fabricValueOfFvj1DescriptorForTestingOnly()", () => {
    it("throws given a descriptor the notation does not define", () => {
      const cases: ReadonlyArray<readonly [Fvj1Descriptor, string]> = [
        [{ number: "Infinity" }, "Not a special number"],
        [{ nonesuch: 1 }, "Not a descriptor kind"],
        [{ a: 1, b: 2 }, "Not a single-key object"],
        [{}, "Not a single-key object"],
        [[1], "Not an object"],
        [{ bigint: { text: "1" } }, "Not a string descriptor"],
        [{ utf16: ["a"] }, "Not a code unit"],
        [{ Bytes: "ZZ" }, "Not lowercase hexadecimal bytes"],
        [{ array: 1 }, "Not a list"],
        [{ record: [["a"]] }, "Not a pair"],
        [{ record: [["a", 1, 2]] }, "Not a pair"],
        [{ Hash: 1 }, "Not an object"],
        [{ Hash: { tag: "fid1" } }, "No field `hash`"],
        [{ Unavailable: { reason: "gone" } }, "Not an unavailable reason"],
        [
          { Unavailable: { reason: "error", errorKind: "nonesuch" } },
          "Not an error kind",
        ],
        [{ Link: 1 }, "A link's payload must be a record."],
        [{ array: [{ hole: "1" }] }, "Not a hole count"],
      ];
      for (const [descriptor, message] of cases) {
        expect(() => fabricValueOfFvj1DescriptorForTestingOnly(descriptor))
          .toThrow(message);
      }
    });

    it("returns a value of each descriptor kind that describes back to it", () => {
      const descriptors: readonly Fvj1Descriptor[] = [
        { unregisteredSymbol: null },
        { KeyPair: { algorithm: "A", publicKey: "01", privateKey: "02" } },
        { Unavailable: { reason: "error", errorKind: "network" } },
        {
          Unavailable: {
            reason: "error",
            errorKind: "general",
            errorMessage: "boom",
          },
        },
        { Map: [["a", 1]] },
        { Set: [1, { bigint: "2" }] },
      ];
      for (const descriptor of descriptors) {
        const value = fabricValueOfFvj1DescriptorForTestingOnly(descriptor);
        expect(fvj1DescriptorOfForTestingOnly(value)).toEqual(descriptor);
      }
    });
  });

  describe("fvj1DescriptorOfForTestingOnly()", () => {
    it("throws given a key pair holding `CryptoKey` handles", async () => {
      const pair = await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ]);
      expect(() => fvj1DescriptorOfForTestingOnly(new FabricKeyPair(pair)))
        .toThrow("No descriptor for a key pair holding `CryptoKey` handles.");
    });

    it("throws given an instance of a class no table names", () => {
      expect(() => fvj1DescriptorOfForTestingOnly(new OtherInstance()))
        .toThrow("No descriptor for a value of an unknown class.");
    });
  });
});
