/**
 * The expected-posture spec, and the one thing it must never do: pass by
 * asserting nothing.
 *
 * A spec is the audit's only way to say what a deployment was supposed to be
 * at. A file that names no field, or names one nothing reads, checks nothing
 * while looking in every line of output exactly like a deployment that held.
 * That is the failure the parse refuses, on the same terms `scripts/cell-spec.ts`
 * refuses it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import {
  loadExpectedPosture,
  parseExpectedPosture,
  postureMismatches,
} from "../expected-posture.ts";

const PROFILES_DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "profiles",
);

const MAX_ENFORCEMENT_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:spec",
  cfcPosture: "max-enforcement",
});

const FLEET_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:spec",
});

/**
 * A session below the `max-enforcement` profile on both kinds of field it
 * carries. It states `off` for flow labels, where the profile expects
 * `persist`, and it selects no bundle, so nothing gives its sinks a ceiling.
 */
const BELOW_PROFILE_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:spec",
  cfcFlowLabels: "off",
});

describe("the expected-posture spec", () => {
  describe("what it refuses", () => {
    it("refuses a spec that asserts nothing", () => {
      expect(() => parseExpectedPosture({})).toThrow("asserts nothing");
    });

    it("refuses a spec whose only field is a label", () => {
      expect(() => parseExpectedPosture({ label: "empty" })).toThrow(
        "asserts nothing",
      );
    });

    it("refuses a field nothing reads", () => {
      expect(() => parseExpectedPosture({ enforcementModes: "enforce" }))
        .toThrow("nothing asserts");
    });

    it("refuses an empty ceilingedSinks, which every deployment satisfies", () => {
      expect(() => parseExpectedPosture({ ceilingedSinks: [] })).toThrow(
        "which every deployment satisfies",
      );
    });

    it("admits an empty ungatedSinks, which is the strongest claim it can make", () => {
      expect(parseExpectedPosture({ ungatedSinks: [] })).toEqual({
        ungatedSinks: [],
      });
    });

    it("refuses requireDeviationsPublished: false, which asserts nothing", () => {
      expect(() => parseExpectedPosture({ requireDeviationsPublished: false }))
        .toThrow("asserts something only as true");
    });

    it("refuses a rung field that is not a non-empty string", () => {
      expect(() => parseExpectedPosture({ flowLabels: "" })).toThrow(
        "must be a non-empty string",
      );
      expect(() => parseExpectedPosture({ flowLabels: 3 })).toThrow(
        "must be a non-empty string",
      );
    });

    it("refuses a rung name that is not on that dial's ladder", () => {
      // A rung off the ladder is compared against every record and matches
      // none of them, so it reads as a deployment permanently at fault.
      expect(() => parseExpectedPosture({ flowLabels: "enforce" })).toThrow(
        "not one of off, observe, persist",
      );
      expect(() => parseExpectedPosture({ enforcementMode: "enforce" }))
        .toThrow("not one of disabled, observe, enforce-explicit");
    });

    it("refuses a boolean field that is not a boolean", () => {
      expect(() => parseExpectedPosture({ triggerReadGating: "true" })).toThrow(
        "must be true or false",
      );
    });

    it("refuses a policyDigest that is neither a string nor null", () => {
      expect(() => parseExpectedPosture({ policyDigest: 7 })).toThrow(
        "must be a string or null",
      );
    });

    it("admits a null policyDigest, which asserts that none is configured", () => {
      expect(parseExpectedPosture({ policyDigest: null })).toEqual({
        policyDigest: null,
      });
    });

    it("refuses a sink list that is not a list of strings", () => {
      expect(() => parseExpectedPosture({ ceilingedSinks: "fetchText" }))
        .toThrow("must be a list of strings");
      expect(() => parseExpectedPosture({ ungatedSinks: [1] })).toThrow(
        "must be a list of strings",
      );
    });

    it("refuses a label that is not a non-empty string", () => {
      expect(() => parseExpectedPosture({ label: "  ", flowLabels: "persist" }))
        .toThrow("label must be a non-empty string");
    });

    it("refuses a spec that is not a JSON object", () => {
      expect(() => parseExpectedPosture([])).toThrow("must be a JSON object");
    });
  });

  describe("loading a spec file", () => {
    it("says which file could not be read, rather than throwing a bare ENOENT", async () => {
      await expect(loadExpectedPosture("/nonexistent/spec.json")).rejects
        .toThrow("could not be read");
    });

    it("says which file is not JSON", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cfc-audit-spec-" });
      const path = join(dir, "broken.json");
      try {
        await Deno.writeTextFile(path, "{not json");
        await expect(loadExpectedPosture(path)).rejects.toThrow(
          "is not valid JSON",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("comparing a record against a spec", () => {
    it("finds nothing wrong with the record the profile describes", async () => {
      const spec = await loadExpectedPosture(
        join(PROFILES_DIR, "max-enforcement.json"),
      );
      expect(postureMismatches(spec, MAX_ENFORCEMENT_RECORD)).toEqual([]);
    });

    it("names a rung field and a sink field a posture below that profile misses", async () => {
      // One of each kind the profile carries, rather than the whole set: the
      // rest of the set is whatever rungs the fleet resolves for the dials a
      // session cannot state, which is not what this case is about.
      const spec = await loadExpectedPosture(
        join(PROFILES_DIR, "max-enforcement.json"),
      );
      const fields = postureMismatches(spec, BELOW_PROFILE_RECORD).map(
        (mismatch) => mismatch.field,
      );
      expect(fields).toContain("flowLabels");
      expect(fields).toContain("ceilingedSinks[fetchText]");
      // The profile's enforcement rung is a floor this record sits on, so it
      // is not among them.
      expect(fields).not.toContain("enforcementMode");
    });

    it("finds nothing wrong with a record stricter than the rung a spec names", () => {
      // A rung field is a floor, so the bundle's `persist` satisfies a spec
      // naming `observe`, and a record below the floor is what fails.
      const spec = parseExpectedPosture({ flowLabels: "observe" });
      expect(postureMismatches(spec, MAX_ENFORCEMENT_RECORD)).toEqual([]);
      expect(postureMismatches(spec, BELOW_PROFILE_RECORD)).toEqual([
        { field: "flowLabels", expected: "observe or stricter", found: "off" },
      ]);
    });

    it("names a boolean dial the record does not carry", () => {
      // The boolean fields are equality, not a floor: a spec asking for one
      // is unsatisfied by a record that does not carry it, whatever the rung
      // fields say. Stated over `decomposedEnvelopes`, which no preset and no
      // posture bundle turns on, so the case does not rest on a dial the
      // fleet's own defaults may move.

      const spec = parseExpectedPosture({ decomposedEnvelopes: true });
      expect(postureMismatches(spec, MAX_ENFORCEMENT_RECORD)).toEqual([
        { field: "decomposedEnvelopes", expected: "true", found: "false" },
      ]);
      expect(postureMismatches(
        parseExpectedPosture({
          decomposedEnvelopes: false,
        }),
        MAX_ENFORCEMENT_RECORD,
      )).toEqual([]);
    });

    it("names a policy digest the record does not carry", () => {
      const spec = parseExpectedPosture({ policyDigest: null });
      expect(
        postureMismatches(spec, MAX_ENFORCEMENT_RECORD)
          .map((mismatch) => mismatch.field),
      ).toEqual(["policyDigest"]);
    });

    it("names an ungated sink the spec does not permit ungated", () => {
      const spec = parseExpectedPosture({ ungatedSinks: ["llm"] });
      expect(
        postureMismatches(spec, MAX_ENFORCEMENT_RECORD)
          .map((mismatch) => mismatch.field),
      ).toEqual([
        "ungatedSinks[llmDialog]",
        "ungatedSinks[generateText]",
        "ungatedSinks[generateObject]",
      ]);
    });

    it("names a digest the record does not carry, against a record carrying none", () => {
      const spec = parseExpectedPosture({ policyDigest: "digest-1" });
      expect(postureMismatches(spec, FLEET_RECORD)).toEqual([
        { field: "policyDigest", expected: "digest-1", found: "null" },
      ]);
    });

    it("says so when the spec requires a ceiling on a sink nothing knows about", () => {
      // A spec naming a sink the registry does not hold is a spec written
      // against a different deployment, and reads as a typo either way.
      const spec = parseExpectedPosture({
        ceilingedSinks: ["fetchEverything"],
      });
      expect(postureMismatches(spec, MAX_ENFORCEMENT_RECORD)).toEqual([
        {
          field: "ceilingedSinks[fetchEverything]",
          expected: "a confidentiality ceiling",
          found: "not a known sink",
        },
      ]);
    });

    it("requires a deviation for every ungated sink when the spec asks", () => {
      const spec = parseExpectedPosture({ requireDeviationsPublished: true });
      // The fleet posture leaves the six network-fetch sinks and the agent
      // sink ungated with no recorded rationale, so nothing publishes them as
      // deviations.
      expect(
        postureMismatches(spec, FLEET_RECORD)
          .map((mismatch) => mismatch.field),
      ).toEqual([
        "deviations[fetchBinary]",
        "deviations[fetchText]",
        "deviations[fetchJson]",
        "deviations[fetchJsonUnchecked]",
        "deviations[fetchProgram]",
        "deviations[streamData]",
        "deviations[agent]",
      ]);
    });
  });
});
