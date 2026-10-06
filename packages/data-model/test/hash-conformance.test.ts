/**
 * Holds `test/fixtures/hash-conformance.json` to this package's hasher: the
 * file must be what the conformance cases generate, and every hash it records
 * must be what the hasher does with the value described, read from the file
 * alone.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import { UnknownValue } from "@/codec-common";
import { valueEqual } from "@/comparison";
import { fabricInstanceClassesByName, FabricLink } from "@/fabric-instances";
import { fabricPrimitiveClassesByName } from "@/fabric-primitives";
import {
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  fabricValueOfDescriptorForTestingOnly,
  HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  type HashConformanceCase,
  hashConformanceFixtureTextForTestingOnly,
  type HashOutcome,
  hashOutcomeOfForTestingOnly,
  type ValueDescriptor,
} from "@/for-testing-only.ts";

import { hex } from "./value-hash/hex.ts";

const FIXTURE_URL = new URL(
  "./fixtures/hash-conformance.json",
  import.meta.url,
);

/**
 * The classes whose codecs are stubs, which the conformance cases leave out
 * until hashing one stops being refused.
 */
const STUB_CODEC_CLASSES = ["FabricMap", "FabricSet"] as const;

/** One entry of the fixture, as `hash-conformance.md` defines it. */
interface FixtureEntry {
  readonly name: string;
  readonly value: ValueDescriptor;
  readonly hash: HashOutcome;
  readonly equals?: string;
  readonly divergence?: { readonly hash: HashOutcome };
}

/** Returns the bytes `text` writes in hexadecimal. */
function bytesOfHex(text: string): Uint8Array {
  return Uint8Array.from(
    { length: text.length / 2 },
    (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );
}

describe("hash-conformance", () => {
  const fixtureText = Deno.readTextFileSync(FIXTURE_URL);
  const entries: readonly FixtureEntry[] = JSON.parse(fixtureText).cases;

  it("is the fixture the conformance cases generate", () => {
    // On a failure here, `deno task regenerate-hash-conformance` rewrites the
    // file, and its diff is the change in the hasher's behavior to review.

    expect(fixtureText).toBe(
      hashConformanceFixtureTextForTestingOnly(
        HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
      ),
    );
  });

  it("records for each case what the hasher does with the value described", () => {
    for (const { name, value, hash, divergence } of entries) {
      const outcome = hashOutcomeOfForTestingOnly(
        fabricValueOfDescriptorForTestingOnly(value),
      );
      expect({ name, outcome }).toEqual({
        name,
        outcome: divergence?.hash ?? hash,
      });
    }
  });

  it("records for each hash the digest of its stream, and that digest's string form", () => {
    for (const { name, hash, divergence } of entries) {
      for (const outcome of [hash, divergence?.hash]) {
        if (outcome === undefined || "refused" in outcome) continue;
        const digest = sha256(bytesOfHex(outcome.stream));
        expect({ name, digest: outcome.digest, string: outcome.string })
          .toEqual({
            name,
            digest: hex(digest),
            string: `fid1:${toUnpaddedBase64url(digest)}`,
          });
      }
    }
  });

  it("records equal hashes for two values exactly when `valueEqual()` returns `true` for them", () => {
    const hashed = entries.flatMap(({ name, value, hash }) =>
      ("digest" in hash)
        ? [{
          name,
          value: fabricValueOfDescriptorForTestingOnly(value),
          digest: hash.digest,
        }]
        : []
    );
    let equalPairs = 0;
    for (let j = 0; j < hashed.length; j++) {
      for (let i = 0; i < j; i++) {
        const [a, b] = [hashed[i]!, hashed[j]!];
        const equal = valueEqual(a.value, b.value);
        expect({ a: a.name, b: b.name, equal })
          .toEqual({ a: a.name, b: b.name, equal: a.digest === b.digest });
        if (equal) equalPairs++;
      }
    }

    // The loop above would pass over a fixture of distinct values alone.
    expect(equalPairs).toBeGreaterThan(0);
  });

  it("names under `equals` only an earlier case of the same hash", () => {
    const earlier = new Map<string, HashOutcome>();
    for (const { name, hash, equals } of entries) {
      if (equals !== undefined) {
        expect({ name, hash: earlier.get(equals) }).toEqual({ name, hash });
      }
      earlier.set(name, hash);
    }
  });

  it("has a case whose value is an instance of each concrete class but those with stub codecs", () => {
    const values = HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY.map((c) => c.make());
    const classes = {
      ...fabricPrimitiveClassesByName(),
      ...fabricInstanceClassesByName(),
    };
    const stubs: readonly string[] = STUB_CODEC_CLASSES;
    for (const [name, cls] of Object.entries(classes)) {
      expect({ name, covered: values.some((v) => v instanceof cls) })
        .toEqual({ name, covered: !stubs.includes(name) });
    }
  });

  it("returns a refusal for an example of each class with a stub codec", () => {
    // The spec gives these classes a byte form this package does not yet
    // produce. Once hashing one succeeds, its examples belong among the cases.

    for (const name of STUB_CODEC_CLASSES) {
      for (
        const make of FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY[name]
      ) {
        expect({ name, outcome: hashOutcomeOfForTestingOnly(make()) })
          .toEqual({ name, outcome: { refused: "unhashable" } });
      }
    }
  });

  describe("hashConformanceFixtureTextForTestingOnly()", () => {
    /** Returns the one entry of the fixture text for `cases`. */
    function soleEntryOf(
      cases: readonly HashConformanceCase[],
    ): Record<string, unknown> {
      return JSON.parse(hashConformanceFixtureTextForTestingOnly(cases))
        .cases[0];
    }

    it("throws given two cases of one name", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "twice", section: "s", make: () => 1 },
          { name: "twice", section: "s", make: () => 2 },
        ])
      ).toThrow("Two cases are named twice.");
    });

    it("throws given a divergence on a case with no spec bytes", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "one", section: "s", make: () => 1, divergence: "note" },
        ])
      ).toThrow("declares a divergence for a value the spec gives no bytes");
    });

    it("throws given a divergence on a case hashed as the spec says", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          {
            name: "null",
            section: "s",
            make: () => null,
            spec: "20",
            divergence: "note",
          },
        ])
      ).toThrow("declares a divergence, but this implementation does what");
    });

    it("throws given a case hashed unlike its spec bytes, with no divergence", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "true", section: "s", make: () => true, spec: "22 00" },
        ])
      ).toThrow('true: hashes to {"stream":"2201"');
    });

    it("returns an entry holding the spec's hash, and this package's under the divergence", () => {
      const entry = soleEntryOf([
        {
          name: "true",
          section: "s",
          make: () => true,
          spec: "22 00",
          divergence: "note",
        },
      ]);
      expect(entry).toMatchObject({
        hash: { stream: "2200" },
        divergence: { note: "note", hash: { stream: "2201" } },
      });
    });

    it("throws given `equals` naming no earlier case", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "a", section: "s", make: () => 1, equals: "b" },
          { name: "b", section: "s", make: () => 1 },
        ])
      ).toThrow("a: `equals` names no earlier case.");
    });

    it("throws given `equals` naming a case of another hash", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "a", section: "s", make: () => 1 },
          { name: "b", section: "s", make: () => 2, equals: "a" },
        ])
      ).toThrow("a and b: their hashes are unequal, but one names the other");
    });

    it("throws given `equals` naming a refused case", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "a", section: "s", make: () => Symbol("a") },
          { name: "b", section: "s", make: () => Symbol("a"), equals: "a" },
        ])
      ).toThrow("b: names a as its equal, but one is refused.");
    });

    it("throws given two cases of one hash and different descriptors, neither naming the other", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "a", section: "s", make: () => new FabricLink({ id: "x" }) },
          {
            name: "b",
            section: "s",
            make: () => new UnknownValue("Link@1", { id: "x" }),
          },
        ])
      ).toThrow("a and b: their hashes are equal, but neither names the other");
    });

    it("returns entries for two cases of one hash and one descriptor, neither naming the other", () => {
      const text = hashConformanceFixtureTextForTestingOnly([
        { name: "a", section: "s", make: () => ({ x: 1, y: 2 }) },
        { name: "b", section: "s", make: () => ({ y: 2, x: 1 }) },
      ]);
      expect(JSON.parse(text).cases.length).toBe(2);
    });
  });

  describe("hashOutcomeOfForTestingOnly()", () => {
    it("returns the bytes fed, their digest, and the digest's string form", () => {
      const digest = sha256(new Uint8Array([0x20]));
      expect(hashOutcomeOfForTestingOnly(null)).toEqual({
        stream: "20",
        digest: hex(digest),
        string: `fid1:${toUnpaddedBase64url(digest)}`,
      });
    });

    it("returns a refusal for a value the hasher refuses", () => {
      expect(hashOutcomeOfForTestingOnly(Symbol("local"))).toEqual({
        refused: "unhashable",
      });
    });

    it("throws a fault in the hasher rather than returning a refusal", () => {
      const faulty = {
        get a(): never {
          throw new TypeError("a fault");
        },
      };
      expect(() => hashOutcomeOfForTestingOnly(faulty)).toThrow(TypeError);
    });
  });
});
