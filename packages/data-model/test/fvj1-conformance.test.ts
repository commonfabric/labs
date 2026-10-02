/**
 * Holds `test/fixtures/fvj1-conformance.json` to this package's JSON codec in
 * both directions: the file must be what the conformance cases generate, and
 * every encode and decode it records must be what the codec does, read from
 * the file alone.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricInstanceClassesByName } from "@/fabric-instances";
import { fabricPrimitiveClassesByName } from "@/fabric-primitives";
import {
  fabricValueOfFvj1DescriptorForTestingOnly,
  FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
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

  it("has a case whose value is an instance of each concrete class", () => {
    const values = FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY.flatMap((c) =>
      "make" in c ? [c.make()] : []
    );
    const classes = {
      ...fabricPrimitiveClassesByName(),
      ...fabricInstanceClassesByName(),
    };
    for (const [name, cls] of Object.entries(classes)) {
      expect({ name, covered: values.some((v) => v instanceof cls) })
        .toEqual({ name, covered: true });
    }
  });
});
