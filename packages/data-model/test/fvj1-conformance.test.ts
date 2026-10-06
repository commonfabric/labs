/**
 * Holds `test/fixtures/fvj1-conformance.json` to this package's JSON codec in
 * both directions: the file must be what the conformance cases generate, and
 * every encode and decode it records must be what the codec does, read from
 * the file alone.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { UnknownValue } from "@/codec-common";
import { fabricInstanceClassesByName } from "@/fabric-instances";
import { fabricPrimitiveClassesByName } from "@/fabric-primitives";
import {
  descriptorOfForTestingOnly,
  fabricValueOfDescriptorForTestingOnly,
  FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  type Fvj1ConformanceCase,
  fvj1ConformanceFixtureTextForTestingOnly,
  fvj1DecodeOutcomeOfForTestingOnly,
  fvj1EncodeOutcomeOfForTestingOnly,
  type ValueDescriptor,
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
    readonly value: ValueDescriptor;
    readonly text?: string;
    readonly refused?: string;
  };
  readonly decode?: {
    readonly text: string;
    readonly value?: ValueDescriptor;
    readonly refused?: string;
  };
  readonly divergence?: {
    readonly encode?: ValueDescriptor;
    readonly decode?: ValueDescriptor;
  };
}

/** Returns the outcome part of a fixture block: what follows from its input. */
function outcomeOf(
  block: {
    readonly value?: ValueDescriptor;
    readonly text?: string;
    readonly refused?: string;
  },
  outcomeKey: "text" | "value",
): ValueDescriptor {
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
      const value = fabricValueOfDescriptorForTestingOnly(encode.value);
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
      const value = fabricValueOfDescriptorForTestingOnly(encode.value);
      expect({ name, descriptor: descriptorOfForTestingOnly(value) })
        .toEqual({ name, descriptor: encode.value });
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
});
