/**
 * Holds `test/fixtures/fvj1-conformance.json` to this package's JSON codec:
 * the file must be what the conformance cases generate, and every decode,
 * re-encode and lenient decode it records must be what the codec does, read
 * from the file alone. The one exception is a text the spec decodes and this
 * package's decoder refuses or decodes otherwise, which a divergence marks:
 * what is re-encoded there is the value the case makes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricInstanceClassesByName } from "@/fabric-instances";
import { fabricPrimitiveClassesByName } from "@/fabric-primitives";
import {
  fabricValueOfTextWithModsForTestingOnly,
  type FixtureRequirements,
  FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
  type Fvj1ConformanceCase,
  fvj1ConformanceFixtureTextForTestingOnly,
  fvj1DecodeOutcomeOfForTestingOnly,
  fvj1EncodeOutcomeOfForTestingOnly,
  type Fvj1Outcome,
  fvj1ProblematicPathsOfForTestingOnly,
  type Fvj1Refusal,
  meetsRequirementsForTestingOnly,
  SIZE_FLOORS_FOR_TESTING_ONLY,
  type TextWithMods,
  type ValuePatch,
  type ValuePath,
  type ValueProbe,
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
  readonly requires?: FixtureRequirements;
  readonly text: string;
  readonly unclaimed?: readonly string[];
  readonly patches?: readonly ValuePatch[];
  readonly probes?: readonly ValueProbe[];
  readonly refused?: Fvj1Refusal;
  readonly canonical?: string;
  readonly reencode?: Fvj1Outcome;
  readonly problematicAt?: ValuePath;
  readonly divergence?: {
    readonly decode?: Fvj1Outcome;
    readonly encode?: Fvj1Outcome;
  };
}

/** Returns the text and mods an entry states. */
function statedOf({ text, unclaimed, patches }: FixtureEntry): TextWithMods {
  return {
    text,
    ...(unclaimed === undefined ? {} : { unclaimed }),
    ...(patches === undefined ? {} : { patches }),
  };
}

/** Returns what an entry says this package's decoder does with its text. */
function decodedOf(
  entry: FixtureEntry,
): Fvj1Outcome | { readonly probes: readonly ValueProbe[] | undefined } {
  return entry.divergence?.decode ??
    ((entry.refused === undefined)
      ? { probes: entry.probes }
      : { refused: entry.refused });
}

/**
 * Returns a line for each child of a probed array or record that `probes`
 * leave unaccounted for: an array index with neither a probe nor a hole run
 * over it, or a record whose count of keys differs from its count of probed
 * keys. A path a patch in `patches` names stands for the child there.
 */
function unprobedChildrenOf(
  probes: readonly ValueProbe[],
  patches: readonly ValuePatch[] = [],
): string[] {
  const keyOf = (path: ValuePath) => JSON.stringify(path);
  const expectedAt = new Map(probes.map(([path, expected]) => [
    keyOf(path),
    expected,
  ]));
  const patched = new Set(patches.map(({ at }) => keyOf(at)));
  const keyCounts = new Map<string, number>();
  for (
    const path of [
      ...probes.map(([path]) => path),
      ...patches.map((p) => p.at),
    ]
  ) {
    if (path.length > 0 && typeof path[path.length - 1] !== "number") {
      const parent = keyOf(path.slice(0, -1));
      keyCounts.set(parent, (keyCounts.get(parent) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  for (const [path, expected] of probes) {
    if (typeof expected === "string") {
      continue;
    } else if ("array" in expected) {
      let index = 0;
      while (index < expected.array) {
        const at = keyOf([...path, index]);
        const found = expectedAt.get(at);
        if (typeof found === "object" && "holes" in found) {
          index += found.holes;
          continue;
        } else if (found === undefined && !patched.has(at)) {
          lines.push(`no probe at ${at}`);
        }
        index++;
      }
    } else if ("record" in expected) {
      const count = keyCounts.get(keyOf(path)) ?? 0;
      if (count !== expected.record) {
        lines.push(
          `${count} keys probed under ${keyOf(path)}, not ${expected.record}`,
        );
      }
    }
  }
  return lines;
}

/**
 * Returns what an entry says this package's encoder does with the value its
 * text decodes to.
 */
function reencodedOf(entry: FixtureEntry): Fvj1Outcome {
  return entry.divergence?.encode ?? entry.reencode ??
    { text: entry.canonical ?? entry.text };
}

describe("fvj1-conformance", () => {
  const fixtureText = Deno.readTextFileSync(FIXTURE_URL);
  const allEntries: readonly FixtureEntry[] = JSON.parse(fixtureText).cases;

  // A reader skips an entry whose requirements it does not meet.
  const entries = allEntries.filter(({ requires }) =>
    meetsRequirementsForTestingOnly(requires)
  );

  it("is the fixture the conformance cases generate", () => {
    // On a failure here, `deno task regenerate-fvj1-conformance` rewrites the
    // file, and its diff is the change in the codec's behavior to review.

    expect(fixtureText).toBe(
      fvj1ConformanceFixtureTextForTestingOnly(
        FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY,
      ),
    );
  });

  it("requires of a reader nothing this package does not meet", () => {
    const unmet = allEntries.filter(({ requires }) =>
      !meetsRequirementsForTestingOnly(requires)
    );

    expect(unmet.map(({ name }) => name)).toEqual([]);
  });

  it("records for each text and mods what decoding them does", () => {
    for (const entry of entries) {
      const { name } = entry;
      expect({
        name,
        outcome: fvj1DecodeOutcomeOfForTestingOnly(statedOf(entry)),
      }).toEqual({ name, outcome: decodedOf(entry) });
    }
  });

  it("accounts for each child of each array and record its probes describe", () => {
    for (const { name, probes, patches, divergence } of entries) {
      const decode = divergence?.decode;
      const ours = (decode !== undefined && "probes" in decode)
        ? decode.probes
        : undefined;
      for (const stated of [probes, ours]) {
        if (stated !== undefined) {
          expect({ name, unprobed: unprobedChildrenOf(stated, patches) })
            .toEqual({ name, unprobed: [] });
        }
      }
    }
  });

  it("records for each decoded text what re-encoding the value does", () => {
    // A divergence's own decode is not re-encoded: the fixture states no text
    // for a value the spec says the text does not decode to.

    for (const entry of entries) {
      const { name, divergence } = entry;
      if (entry.refused !== undefined || divergence?.decode !== undefined) {
        continue;
      }
      const value = fabricValueOfTextWithModsForTestingOnly(statedOf(entry));
      expect({ name, outcome: fvj1EncodeOutcomeOfForTestingOnly(value) })
        .toEqual({ name, outcome: reencodedOf(entry) });
    }
  });

  it("records for each text the spec decodes and this package decodes otherwise what encoding the case's value does", () => {
    const cases = new Map(
      FVJ1_CONFORMANCE_CASES_FOR_TESTING_ONLY.map((c) => [c.name, c]),
    );
    const diverging = entries.filter((entry) =>
      entry.refused === undefined && entry.divergence?.decode !== undefined
    );
    expect(diverging.length).toBeGreaterThan(0);
    for (const entry of diverging) {
      const { name } = entry;
      const conformanceCase = cases.get(name);
      if (conformanceCase === undefined || !("make" in conformanceCase)) {
        throw new Error(`${name}: no case makes the value.`);
      }
      expect({
        name,
        outcome: fvj1EncodeOutcomeOfForTestingOnly(conformanceCase.make()),
      }).toEqual({ name, outcome: reencodedOf(entry) });
    }
  });

  it("records for each refused text where a lenient decode puts its one problematic value", () => {
    for (const entry of entries) {
      const { name, text, divergence } = entry;
      if (entry.refused === undefined || divergence?.decode !== undefined) {
        continue;
      }
      expect({ name, paths: fvj1ProblematicPathsOfForTestingOnly(text) })
        .toEqual({ name, paths: [entry.problematicAt] });
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

    it("throws given a divergence on a text this package refuses", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          { name: "bare", section: "s", text: "42", divergence: "note" },
        ])
      ).toThrow("declares a divergence, but this implementation does what");
    });

    it("returns an entry holding the spec's decode and a re-encode divergence, for a text the spec decodes as this package does", () => {
      const entry = JSON.parse(
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "proto",
            section: "s",
            text: 'fvj1:{"/quote":{"__proto__":1}}',
            specDecodes: true,
            divergence: "note",
          },
        ]),
      ).cases[0];
      expect(entry).toEqual({
        name: "proto",
        section: "s",
        text: 'fvj1:{"/quote":{"__proto__":1}}',
        probes: [[[], { record: 1 }], [["__proto__"], "fvj1:1"]],
        canonical: 'fvj1:{"__proto__":1}',
        divergence: { note: "note", encode: { refused: "unencodable" } },
      });
    });

    it("returns an entry requiring the flavors a case marks", () => {
      const entry = JSON.parse(
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "unconstructed",
            section: "s",
            text: 'fvj1:{"/RegExp@1":{"flags":"","flavor":"es2025",' +
              '"source":"("}}',
            requires: { flavors: ["es2025"] },
          },
        ]),
      ).cases[0];

      expect(entry.requires).toEqual({ flavors: ["es2025"] });
    });

    it("returns an entry requiring the length of an array past the floor", () => {
      const length = SIZE_FLOORS_FOR_TESTING_ONLY.arrayLength + 1;
      const entry = JSON.parse(
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "long",
            section: "s",
            text: `fvj1:[{"/hole":${length}}]`,
          },
        ]),
      ).cases[0];

      expect(entry.requires).toEqual({ arrayLength: length });
    });

    it("returns an entry requiring the member count of a record past the floor", () => {
      const count = SIZE_FLOORS_FOR_TESTING_ONLY.propertyCount + 1;
      const members = Array.from(
        { length: count },
        (_, i) => `"k${String(i).padStart(6, "0")}":${i}`,
      );
      const entry = JSON.parse(
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "wide",
            section: "s",
            text: `fvj1:{${members.join(",")}}`,
          },
        ]),
      ).cases[0];

      expect(entry.requires).toEqual({ propertyCount: count });
    });

    it("returns entries requiring the length of a string, a byte sequence and a symbol's key past their floors, and a depth past its floor", () => {
      const floors = SIZE_FLOORS_FOR_TESTING_ONLY;
      const string = "x".repeat(floors.stringLength + 1);
      const state = "A".repeat(Math.ceil((floors.bytesLength + 1) * 4 / 3));
      const key = "x".repeat(floors.symbolKeyLength + 1);
      const depth = floors.depth + 1;
      const cases: readonly Fvj1ConformanceCase[] = [
        { name: "string", section: "s", text: `fvj1:"${string}"` },
        { name: "bytes", section: "s", text: `fvj1:{"/Bytes@1":"${state}"}` },
        { name: "key", section: "s", text: `fvj1:{"/Symbol@1":"${key}"}` },
        {
          name: "deep",
          section: "s",
          text: `fvj1:${"[".repeat(depth)}${"]".repeat(depth)}`,
        },
      ];
      const entries =
        JSON.parse(fvj1ConformanceFixtureTextForTestingOnly(cases))
          .cases;

      expect(entries.map((entry: FixtureEntry) => entry.requires)).toEqual([
        { stringLength: floors.stringLength + 1 },
        { bytesLength: floors.bytesLength + 1 },
        { symbolKeyLength: floors.symbolKeyLength + 1 },
        { depth },
      ]);
    });

    it("throws given a text the spec is said to decode that this package refuses", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "bare",
            section: "s",
            text: "42",
            specDecodes: true,
            divergence: "note",
          },
        ])
      ).toThrow("says the spec decodes a text this package refuses");
    });

    it("throws given a divergence on a text the spec is said to decode, whose spec text is not computed", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "bigint",
            section: "s",
            text: 'fvj1:{"/BigInt@1":"AQ"}',
            specDecodes: true,
            divergence: "note",
          },
        ])
      ).toThrow("does not compute");
    });

    it("throws given a value whose decoded text re-encodes unlike its spec text, with no divergence", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          { name: "keys", section: "s", make: () => ({ "2": 0, "10": 0 }) },
        ])
      ).toThrow(
        'keys: the encode is {"text":"fvj1:{\\"2\\":0,\\"10\\":0}"}, not ' +
          '{"text":"fvj1:{\\"10\\":0,\\"2\\":0}"}, and no divergence says so.',
      );
    });

    it("throws given a value whose text this package decodes otherwise, with no divergence", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "proto",
            section: "s",
            make: () => JSON.parse('{"__proto__":1}'),
          },
        ])
      ).toThrow('proto: the decode is {"refused":"malformed"}, not');
    });

    it("returns a divergence holding the encode of the value a case makes, where its text decodes to another value", () => {
      // The getter returns a new number at each read, so the text is decoded
      // to a value other than the one the probes are taken from, and the
      // value made a second time encodes unlike the text.

      let reads = 0;
      const text = fvj1ConformanceFixtureTextForTestingOnly([
        {
          name: "drifting",
          section: "s",
          divergence: "note",
          make: () => ({
            get a() {
              reads++;
              return reads;
            },
          }),
        },
      ]);
      const { divergence } = JSON.parse(text).cases[0];
      expect(Object.keys(divergence)).toEqual(["note", "decode", "encode"]);
    });

    it("throws given a refused text whose lenient decode yields more than one problematic value", () => {
      expect(() =>
        fvj1ConformanceFixtureTextForTestingOnly([
          {
            name: "two",
            section: "s",
            text: 'fvj1:[{"/Bytes@1":null},{"/Symbol@1":1}]',
          },
        ])
      ).toThrow("two: a lenient decode yields 2 problematic values, not one.");
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

  describe("fvj1DecodeOutcomeOfForTestingOnly()", () => {
    it("returns no probe where a patch puts a value", () => {
      expect(
        fvj1DecodeOutcomeOfForTestingOnly({
          text: "fvj1:[1,null]",
          patches: [{ at: [1], put: { unregisteredSymbol: "s" } }],
        }),
      ).toEqual({ probes: [[[], { array: 2 }], [[0], "fvj1:1"]] });
    });

    it("throws mods that break their rules rather than returning a refusal", () => {
      expect(() =>
        fvj1DecodeOutcomeOfForTestingOnly({
          text: "fvj1:[1]",
          patches: [{ at: [0], put: { unregisteredSymbol: null } }],
        })
      ).toThrow("No `null` to patch at [0]");
    });
  });

  describe("fvj1ProblematicPathsOfForTestingOnly()", () => {
    it("returns the path of the value a malformed tagged form is put in place of", () => {
      expect(
        fvj1ProblematicPathsOfForTestingOnly('fvj1:[1,{"/Undefined@1":{}}]'),
      ).toEqual([[1]]);
    });

    it("returns the path of the container a malformed hole run is in", () => {
      expect(fvj1ProblematicPathsOfForTestingOnly('fvj1:[{"/hole":0}]'))
        .toEqual([[]]);
    });

    it("returns no path for a problematic value within another's state", () => {
      expect(fvj1ProblematicPathsOfForTestingOnly('fvj1:{"/Link@1":{"/x":1}}'))
        .toEqual([[]]);
    });

    it("returns no path for a text that decodes", () => {
      expect(fvj1ProblematicPathsOfForTestingOnly("fvj1:[1]")).toEqual([]);
    });
  });
});
