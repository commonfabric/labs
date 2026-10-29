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
  member: "runtime/bakery",
  reachedBy: ["runtime/bakery/"],
  units: ["runtime/bakery/glaze.test.ts", "runtime/bakery/proof.test.ts"],
};

const cellar: MeasuredSet = {
  member: "runtime/cellar",
  reachedBy: ["runtime/cellar/"],
  units: ["runtime/cellar/rack.test.ts"],
};

describe("coverage-gates", () => {
  describe("coverageGateSuite()", () => {
    const unit = suite("workspace-unit", [bakery, cellar]);
    const gates = coverageGateSuite([unit]);

    it("holds one gate for each measured set, each a whole unit", () => {
      expect(gates.id).toBe(COVERAGE_GATE_SUITE);
      expect(gates.units).toEqual([
        "workspace-unit/runtime/bakery",
        "workspace-unit/runtime/cellar",
      ]);
      expect(gates.whole).toEqual(gates.units);
    });

    it("is reached by the paths its set declares, and by nothing else", () => {
      expect(gates.unitsForChange!(new Set(["runtime/bakery/src/oven.ts"])))
        .toEqual(["workspace-unit/runtime/bakery"]);
      expect(gates.unitsForChange!(new Set(["docs/README.md"]))).toEqual([]);
    });

    it("keeps two suites over one member apart", () => {
      const other = suite("bakery-integration", [{
        ...bakery,
        units: ["runtime/bakery/e2e.ts"],
      }]);
      const both = coverageGateSuite([unit, other]);
      expect(both.unitsForChange!(new Set(["runtime/bakery/src/oven.ts"])))
        .toEqual([
          "bakery-integration/runtime/bakery",
          "workspace-unit/runtime/bakery",
        ]);
      expect(both.judges!.get("bakery-integration/runtime/bakery")?.units)
        .toEqual(["runtime/bakery/e2e.ts"]);
    });

    it("judges the units of its set that this configuration runs", () => {
      const partial = coverageGateSuite([suite("workspace-unit", [bakery], [
        {
          unit: "runtime/bakery/proof.test.ts",
          reason: "it needs an oven nobody has",
        },
        {
          unit: "runtime/bakery/glaze.test.ts",
          leafName: "sets twice",
          reason: "it is slow on this configuration",
        },
      ])]);
      expect(partial.judges!.get("workspace-unit/runtime/bakery")).toEqual({
        suite: "workspace-unit",
        units: ["runtime/bakery/glaze.test.ts"],
        identity: { k: "gate", s: "bakery", n: "coverage-gate workspace-unit" },
      });
    });

    it("holds no gate for a set nothing in this configuration runs", () => {
      const none = coverageGateSuite([suite(
        "workspace-unit",
        [cellar],
        [{ unit: "runtime/cellar/rack.test.ts", reason: "no cellar here" }],
      )]);
      expect(none.units).toEqual([]);
    });

    it("claims the record of each gate as that gate's unit", () => {
      const ref = measuredSets([unit])[0]!;
      expect(gates.locate({ test: coverageGateIdentity(ref) })).toEqual({
        level: "unit",
        unit: "workspace-unit/runtime/bakery",
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
        gates.command([{ unit: "workspace-unit/runtime/bakery", skip: [] }], {
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
          new Set(["runtime/cellar/x.ts", "runtime/bakery/y.ts"]),
        ).map((ref) => `${ref.suite}/${ref.set.member}`),
      ).toEqual(["a-unit/runtime/bakery", "z-unit/runtime/cellar"]);
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
