import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  COVERAGE_GATE_SUITE,
  coverageGateIdentity,
  coverageGateSuite,
  measuredSets,
  reachedSets,
} from "./coverage-gates.ts";
import { claimsFor, loadTopology } from "../test-topology.ts";
import type { MeasuredSet, Suite } from "./suite.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** A suite carrying only what the coverage gates are built from. */
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

describe("coverage-gates", () => {
  describe("coverageGateSuite()", () => {
    const unit = suite("workspace-unit", [bakery, cellar]);
    const gates = coverageGateSuite([unit]);

    it("holds one gate for each measured set, each a whole unit", () => {
      expect(gates.id).toBe(COVERAGE_GATE_SUITE);
      expect(gates.units).toEqual([
        "workspace-unit/packages/bakery",
        "workspace-unit/packages/cellar",
      ]);
      expect(gates.whole).toEqual(gates.units);
    });

    it("is reached by the paths its set declares, and by nothing else", () => {
      expect(gates.unitsForChange!(new Set(["packages/bakery/src/oven.ts"])))
        .toEqual(["workspace-unit/packages/bakery"]);
      expect(gates.unitsForChange!(new Set(["docs/README.md"]))).toEqual([]);
    });

    it("keeps two suites over one member apart", () => {
      const other = suite("bakery-integration", [{
        ...bakery,
        units: ["packages/bakery/e2e.ts"],
      }]);
      const both = coverageGateSuite([unit, other]);
      expect(both.unitsForChange!(new Set(["packages/bakery/src/oven.ts"])))
        .toEqual([
          "bakery-integration/packages/bakery",
          "workspace-unit/packages/bakery",
        ]);
      expect(both.judges!.get("bakery-integration/packages/bakery")?.units)
        .toEqual(["packages/bakery/e2e.ts"]);
    });

    it("judges the units of its set that this configuration runs", () => {
      const partial = coverageGateSuite([suite("workspace-unit", [bakery], [
        {
          unit: "packages/bakery/proof.test.ts",
          reason: "it needs an oven nobody has",
        },
        {
          unit: "packages/bakery/glaze.test.ts",
          leafName: "sets twice",
          reason: "it is slow on this configuration",
        },
      ])]);
      expect(partial.judges!.get("workspace-unit/packages/bakery")).toEqual({
        suite: "workspace-unit",
        units: ["packages/bakery/glaze.test.ts"],
        identity: { k: "gate", s: "bakery", n: "coverage-gate workspace-unit" },
      });
    });

    it("holds no gate for a set nothing in this configuration runs", () => {
      const none = coverageGateSuite([suite(
        "workspace-unit",
        [cellar],
        [{ unit: "packages/cellar/rack.test.ts", reason: "no cellar here" }],
      )]);
      expect(none.units).toEqual([]);
    });

    it("claims the record of each gate as that gate's unit", () => {
      const ref = measuredSets([unit])[0]!;
      expect(gates.locate({ test: coverageGateIdentity(ref) })).toEqual({
        level: "unit",
        unit: "workspace-unit/packages/bakery",
      });
    });

    it("claims no record of another kind, scope, name or configuration", () => {
      const identity = {
        k: "gate",
        s: "bakery",
        n: "coverage-gate workspace-unit",
      };
      expect(gates.locate({ test: { ...identity, k: "unit" } }))
        .toBeUndefined();
      expect(gates.locate({ test: { ...identity, s: "oven" } }))
        .toBeUndefined();
      expect(gates.locate({ test: { ...identity, n: "coverage-gate runner" } }))
        .toBeUndefined();
      expect(gates.locate({ test: { ...identity, v: "server-execution" } }))
        .toBeUndefined();
    });

    it("refuses to build a command, since no lane runs a gate", async () => {
      await expect(
        gates.command([{ unit: "workspace-unit/packages/bakery", skip: [] }], {
          root: "/repo",
          outputDir: "/out",
          spoolDir: "/spool",
        }),
      ).rejects.toThrow("no lane runs a gate");
    });
  });

  describe("reachedSets()", () => {
    it("lists the sets a change reaches, in the order of every set", () => {
      const suites = [suite("z-unit", [cellar]), suite("a-unit", [bakery])];
      expect(
        reachedSets(
          suites,
          new Set(["packages/cellar/x.ts", "packages/bakery/y.ts"]),
        ).map((ref) => `${ref.suite}/${ref.set.member}`),
      ).toEqual(["a-unit/packages/bakery", "z-unit/packages/cellar"]);
    });
  });

  describe("the coverage gates in the repository's own topology", () => {
    it("holds a gate for every measured set, and one suite claims each", async () => {
      const suites = await loadTopology(root);
      const gates = suites.find((one) => one.id === COVERAGE_GATE_SUITE)!;
      const sets = measuredSets(suites);
      expect(sets.length).toBeGreaterThan(0);
      expect(gates.units).toHaveLength(sets.length);
      for (const ref of sets) {
        const claims = claimsFor(suites, { test: coverageGateIdentity(ref) });
        expect(claims.map((claim) => claim.suite.id)).toEqual([
          COVERAGE_GATE_SUITE,
        ]);
      }
    });
  });
});
