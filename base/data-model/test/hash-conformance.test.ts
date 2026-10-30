/**
 * Holds `test/fixtures/hash-conformance.json` to this package's hasher: the
 * file must be what the conformance cases generate, and every hash it records
 * must be what the hasher does with the value its text and mods write, read
 * from the file alone but where this package's decoder refuses the text.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";

import type { FabricValue } from "@/interface.ts";
import { UnknownValue } from "@/codec-common";
import { valueEqual } from "@/comparison";
import { fabricInstanceClassesByName, FabricLink } from "@/fabric-instances";
import {
  FabricKeyPair,
  fabricPrimitiveClassesByName,
  FabricRegExp,
} from "@/fabric-primitives";
import {
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  fabricValueOfTextWithModsForTestingOnly,
  type FixtureRequirements,
  HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  type HashConformanceCase,
  hashConformanceFixtureTextForTestingOnly,
  type HashOutcome,
  hashOutcomeOfForTestingOnly,
  meetsRequirementsForTestingOnly,
  SIZE_FLOORS_FOR_TESTING_ONLY,
  type TextWithMods,
} from "@/for-testing-only.ts";
import { hashOf, hashStringOf, taggedHashStringOf } from "@/value-hash";

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
type FixtureEntry = TextWithMods & {
  readonly name: string;
  readonly requires?: FixtureRequirements;
  readonly hash: HashOutcome;
  readonly equals?: string;
  readonly divergence?: {
    readonly hash?: HashOutcome;
    readonly text?: "refused";
  };
};

/**
 * Returns the value `entry` writes, read from its text and mods, or made by
 * its case where this package's decoder refuses the text.
 */
function valueOfEntry(entry: FixtureEntry): FabricValue {
  if (entry.divergence?.text === undefined) {
    return fabricValueOfTextWithModsForTestingOnly(entry);
  }
  return HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY
    .find(({ name }) => name === entry.name)!
    .make();
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
  const allEntries: readonly FixtureEntry[] = JSON.parse(fixtureText).cases;

  // A reader skips an entry whose requirements it does not meet.
  const entries = allEntries.filter(({ requires }) =>
    meetsRequirementsForTestingOnly(requires)
  );

  it("is the fixture the conformance cases generate", () => {
    // On a failure here, `deno task regenerate-hash-conformance` rewrites the
    // file, and its diff is the change in the hasher's behavior to review.

    expect(fixtureText).toBe(
      hashConformanceFixtureTextForTestingOnly(
        HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY,
      ),
    );
  });

  it("requires of a reader nothing this package does not meet", () => {
    const unmet = allEntries.filter(({ requires }) =>
      !meetsRequirementsForTestingOnly(requires)
    );

    expect(unmet.map(({ name }) => name)).toEqual([]);
  });

  it("records for each case what the hasher does with the value its text and mods write", () => {
    for (const entry of entries) {
      const { name, hash, divergence } = entry;
      const outcome = hashOutcomeOfForTestingOnly(valueOfEntry(entry));
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
    const hashed = entries.flatMap((entry) =>
      ("digest" in entry.hash)
        ? [{
          name: entry.name,
          value: valueOfEntry(entry),
          digest: entry.hash.digest,
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

  it("records for each case the hash `hashOf()` and the string functions return for its value", () => {
    // Hashed afresh, or served from a cache where a case's value was hashed
    // before, as the deep-frozen record's is.

    const byName = new Map(entries.map((e) => [e.name, e]));
    for (const { name, make } of HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY) {
      const { hash, divergence } = byName.get(name)!;
      const recorded = divergence?.hash ?? hash;
      if ("refused" in recorded) continue;
      const value = make();
      expect({
        name,
        digest: hex(hashOf(value).bytes),
        tagged: taggedHashStringOf(value),
        string: `fid1:${hashStringOf(value)}`,
      }).toEqual({
        name,
        digest: recorded.digest,
        tagged: recorded.string,
        string: recorded.string,
      });
    }
  });

  it("holds the cases' values to equal hashes exactly when `valueEqual()` returns `true` for them", () => {
    // Made by each case rather than read back from the file, so that the
    // values differing only in what no text records, such as sharing and
    // freezing, are compared as made.

    const hashed = HASH_CONFORMANCE_CASES_FOR_TESTING_ONLY.flatMap(
      ({ name, make }) => {
        const value = make();
        const outcome = hashOutcomeOfForTestingOnly(value);
        return ("digest" in outcome)
          ? [{ name, value, digest: outcome.digest }]
          : [];
      },
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

    // The loop above would pass over cases of distinct values alone.
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

  it("throws given an example of each class with a stub codec", () => {
    // The spec gives these classes a byte form this package does not yet
    // produce. Once hashing one succeeds, its examples belong among the cases.

    for (const name of STUB_CODEC_CLASSES) {
      for (
        const make of FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY[name]
      ) {
        expect(() => hashOutcomeOfForTestingOnly(make())).toThrow(
          "not yet implemented",
        );
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

    it("returns an entry writing the value as a text, with the mods to decoding it", () => {
      const entry = soleEntryOf([
        {
          name: "a",
          section: "s",
          make: () => {
            const record: { self?: FabricValue; u?: FabricValue } = {
              u: new UnknownValue("Link@1", { id: "x" }),
            };
            record.self = record;
            return record;
          },
        },
      ]);
      expect(entry).toMatchObject({
        text: 'fvj1:{"self":null,"u":{"/Link@1":{"id":"x"}}}',
        unclaimed: ["Link@1"],
        patches: [{ at: ["self"], put: { cycle: [] } }],
      });
    });

    it("returns an entry writing a cycle through an instance as a patch whose path steps through its fields", () => {
      const entry = soleEntryOf([
        {
          name: "a",
          section: "s",
          make: () => {
            const record: { link?: FabricValue } = {};
            record.link = new FabricLink({
              u: new UnknownValue("Bytes@1", "AQ"),
              record,
            });
            return record;
          },
        },
      ]);
      expect(entry).toMatchObject({
        text: 'fvj1:{"link":{"/Link@1":{"record":null,"u":{"/Bytes@1":"AQ"}}}}',
        unclaimed: ["Bytes@1"],
        patches: [{ at: ["link", "payload", "record"], put: { cycle: [] } }],
      });
    });

    it("throws given a case whose text and mods decode to another value", () => {
      // The getter returns a new number at each read, so the value the case
      // makes is unlike any one value, its text's included.

      let reads = 0;
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          {
            name: "a",
            section: "s",
            make: () => ({
              get n() {
                reads++;
                return reads;
              },
            }),
          },
        ])
      ).toThrow("does not decode to the value the case made.");
    });

    it("throws given a divergence on a case with no spec bytes whose text this package decodes", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "one", section: "s", make: () => 1, divergence: "note" },
        ])
      ).toThrow("declares a divergence, but this implementation does what");
    });

    it("throws given a case whose text this package's decoder refuses, with no divergence", () => {
      expect(() =>
        hashConformanceFixtureTextForTestingOnly([
          { name: "a", section: "s", make: () => ({ constructor: 1 }) },
        ])
      ).toThrow(
        'a: this implementation\'s decoder refuses `fvj1:{"constructor":1}`',
      );
    });

    it("returns an entry marking under the divergence a text this package's decoder refuses", () => {
      const entry = soleEntryOf([
        {
          name: "a",
          section: "s",
          make: () => ({ constructor: 1 }),
          divergence: "note",
        },
      ]);
      expect(entry).toMatchObject({
        text: 'fvj1:{"constructor":1}',
        divergence: { note: "note", text: "refused" },
      });
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

    it("throws given two cases of one hash and different texts or mods, neither naming the other", () => {
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

    it("returns an entry requiring the flavors a case marks", () => {
      const entry = soleEntryOf([
        {
          name: "flavored",
          section: "s",
          make: () => new FabricRegExp("es2025", "a", ""),
          requires: { flavors: ["es2025"] },
        },
      ]);

      expect(entry.requires).toEqual({ flavors: ["es2025"] });
    });

    it("returns an entry requiring the member count of a record past the floor", () => {
      const count = SIZE_FLOORS_FOR_TESTING_ONLY.propertyCount + 1;
      const entry = soleEntryOf([
        {
          name: "wide",
          section: "s",
          make: () =>
            Object.fromEntries(
              Array.from({ length: count }, (_, i) => [`k${i}`, i]),
            ),
        },
      ]);

      expect(entry.requires).toEqual({ propertyCount: count });
    });

    it("returns entries requiring the length of a symbol's key and a depth past their floors", () => {
      const floors = SIZE_FLOORS_FOR_TESTING_ONLY;
      const key = "x".repeat(floors.symbolKeyLength + 1);
      const deep = () => {
        let value: FabricValue = [];
        for (let i = 1; i <= floors.depth; i++) {
          value = [value];
        }
        return value;
      };
      const entries = JSON.parse(
        hashConformanceFixtureTextForTestingOnly([
          { name: "key", section: "s", make: () => Symbol.for(key) },
          { name: "deep", section: "s", make: deep },
        ]),
      ).cases;

      expect(entries.map((entry: FixtureEntry) => entry.requires)).toEqual([
        { symbolKeyLength: floors.symbolKeyLength + 1 },
        { depth: floors.depth + 1 },
      ]);
    });

    it("returns entries for two cases of one hash and one text with mods, neither naming the other", () => {
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

    it("throws a failure to hash other than the refusal section 8 requires", async () => {
      const pair = await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ]);
      expect(() => hashOutcomeOfForTestingOnly(new FabricKeyPair(pair)))
        .toThrow("Cannot hash a `FabricKeyPair` that holds opaque handles.");
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
