import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  coverageGateFor,
  measuredMembersOf,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
  measuredUnitKeys,
} from "./coverage.ts";
import { LOCAL_COVERAGE_MAX_SETS } from "./policy.ts";
import type { MeasuredSet, Suite } from "../test-topology/suite.ts";

/** A suite carrying only what the coverage selection reads. */
function suite(
  id: string,
  measured: MeasuredSet[],
  unavailable: Suite["unavailable"] = [],
): Suite {
  return {
    id,
    recordSurfaces: [{ kind: "unit", scope: id }],
    needs: [],
    units: measured.flatMap((set) => set.units),
    unavailable,
    whole: [],
    measured,
    locate: () => undefined,
    command: () => Promise.resolve([]),
  };
}

const bakery: MeasuredSet = {
  member: "packages/bakery",
  reachedBy: ["packages/bakery/"],
  units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
};

const cellar: MeasuredSet = {
  member: "packages/cellar",
  reachedBy: ["packages/cellar/"],
  units: ["packages/cellar/rack.test.ts"],
};

describe("coverage", () => {
  describe("measured sets", () => {
    it("lists every set the topology declares, suite then member", () => {
      const suites = [suite("z-unit", [cellar]), suite("a-unit", [bakery])];
      expect(measuredSets(suites).map(measuredSetName)).toEqual([
        "a-unit/packages/bakery",
        "z-unit/packages/cellar",
      ]);
    });

    it("lists nothing for a suite that declares nothing", () => {
      const bare = suite("bare", []);
      delete (bare as { measured?: unknown }).measured;
      expect(measuredSets([bare])).toEqual([]);
    });

    it("names a directory that a member's own slashes cannot break", () => {
      const nested: MeasuredSet = {
        member: "packages/connectors/github",
        reachedBy: ["packages/connectors/github/"],
        units: ["packages/connectors/github/issue.test.ts"],
      };
      const ref = measuredSets([suite("workspace-unit", [nested])])[0]!;
      expect(measuredSetDirectory(ref))
        .toBe("workspace-unit/packages__connectors__github");
    });

    it("leaves out a set nothing in this configuration runs", () => {
      // Scoring it would score whatever some other lane left in the
      // directory, since nothing would be required to run the set.
      const suites = [suite(
        "workspace-unit",
        [bakery],
        bakery.units.map(
          (unit) => ({ unit, reason: "this configuration cannot run it" }),
        ),
      )];
      expect(measuredSets(suites)).toEqual([]);
    });

    it("keeps a set some of whose units this configuration runs", () => {
      const suites = [suite("workspace-unit", [bakery], [{
        unit: bakery.units[0]!,
        reason: "this configuration cannot run it",
      }])];
      expect(measuredSets(suites)).toHaveLength(1);
    });
  });

  describe("the coverage gate's selection", () => {
    it("reaches a set through the paths it declares", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/src/oven.ts"]),
      );
      expect(gate.sets.map(measuredSetName))
        .toEqual(["workspace-unit/packages/bakery"]);
      expect(gate.off).toBeUndefined();
    });

    it("reaches nothing where the change is somewhere else", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gate = coverageGateFor(suites, new Set(["docs/README.md"]));
      expect(gate.sets).toEqual([]);
      expect(gate.reached).toEqual([]);
      expect(gate.off).toBeUndefined();
    });

    it("keeps two suites over one member apart", () => {
      const other: MeasuredSet = {
        ...bakery,
        units: ["packages/bakery/e2e.ts"],
      };
      const suites = [
        suite("workspace-unit", [bakery]),
        suite("bakery-integration", [other]),
      ];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/src/oven.ts"]),
      );
      expect(gate.sets.map(measuredSetName)).toEqual([
        "bakery-integration/packages/bakery",
        "workspace-unit/packages/bakery",
      ]);
    });

    it("turns the gate off past the cap, and says what it reached", () => {
      const many = Array.from(
        { length: LOCAL_COVERAGE_MAX_SETS + 1 },
        (_, index): MeasuredSet => ({
          member: `packages/p${index}`,
          reachedBy: [`packages/p${index}/`],
          units: [`packages/p${index}/one.test.ts`],
        }),
      );
      const suites = [suite("workspace-unit", many)];
      const changed = new Set(many.map((set) => `${set.member}/src/main.ts`));
      const gate = coverageGateFor(suites, changed);
      expect(gate.sets).toEqual([]);
      expect(gate.reached).toHaveLength(LOCAL_COVERAGE_MAX_SETS + 1);
      expect(gate.off).toContain(
        `${LOCAL_COVERAGE_MAX_SETS + 1} measured sets`,
      );
    });

    it("still gates a change that reaches exactly the cap", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/src/oven.ts", "packages/cellar/src/rack.ts"]),
      );
      expect(gate.sets).toHaveLength(2);
      expect(gate.off).toBeUndefined();
    });

    it("makes every unit of a gated set mandatory", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/oven.ts"]),
      );
      expect([...measuredUnitKeys(suites, gate)].sort()).toEqual([
        "workspace-unit\tpackages/bakery/glaze.test.ts",
        "workspace-unit\tpackages/bakery/proof.test.ts",
      ]);
    });

    it("leaves a unit the suite declares unavailable out of the mandatory set", () => {
      const suites = [suite("workspace-unit", [bakery], [{
        unit: "packages/bakery/proof.test.ts",
        reason: "it needs an oven nobody has",
      }])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/oven.ts"]),
      );
      expect([...measuredUnitKeys(suites, gate)]).toEqual([
        "workspace-unit\tpackages/bakery/glaze.test.ts",
      ]);
    });

    it("keeps a unit whose unavailability names one leaf", () => {
      const suites = [suite("workspace-unit", [bakery], [{
        unit: "packages/bakery/proof.test.ts",
        leafName: "rises twice",
        reason: "it is slow on this configuration",
      }])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/oven.ts"]),
      );
      expect([...measuredUnitKeys(suites, gate)]).toHaveLength(2);
    });

    it("requires nothing of a suite this tree does not hold", () => {
      // A manifest can name a suite a later tree dropped, and a unit of
      // one cannot be placed by anything.
      const suites = [suite("workspace-unit", [bakery])];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/oven.ts"]),
      );
      expect(measuredUnitKeys([], gate).size).toBe(0);
    });

    it("requires nothing when the cap turned the gate off", () => {
      const many = Array.from(
        { length: LOCAL_COVERAGE_MAX_SETS + 1 },
        (_, index): MeasuredSet => ({
          member: `packages/p${index}`,
          reachedBy: [`packages/p${index}/`],
          units: [`packages/p${index}/one.test.ts`],
        }),
      );
      const suites = [suite("workspace-unit", many)];
      const gate = coverageGateFor(
        suites,
        new Set(many.map((set) => `${set.member}/src/main.ts`)),
      );
      expect(measuredUnitKeys(suites, gate).size).toBe(0);
    });

    it("names the members one suite measures", () => {
      const suites = [
        suite("workspace-unit", [bakery, cellar]),
        suite("runner-unit", [{
          member: "packages/runner",
          reachedBy: ["packages/runner/"],
          units: ["packages/runner/one.test.ts"],
        }]),
      ];
      const gate = coverageGateFor(
        suites,
        new Set(["packages/bakery/oven.ts", "packages/runner/src/run.ts"]),
      );
      expect([...measuredMembersOf(gate, "workspace-unit")])
        .toEqual(["packages/bakery"]);
      expect([...measuredMembersOf(gate, "runner-unit")])
        .toEqual(["packages/runner"]);
      expect([...measuredMembersOf(gate, "nothing-unit")]).toEqual([]);
    });
  });
});
