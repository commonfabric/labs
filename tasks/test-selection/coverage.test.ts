import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  coverageGateFor,
  measuredCost,
  measuredCostLines,
  measuredMembersOf,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
  measuredUnitKeys,
} from "./coverage.ts";
import type { Calibration, ManifestEntry } from "./manifest.ts";
import {
  COST_WINDOW_DAYS,
  LANE_BUDGET_SECONDS,
  LANES,
  LOCAL_COVERAGE_MAX_SECONDS,
  LOCAL_COVERAGE_MAX_SETS,
} from "./policy.ts";
import { duration } from "./duration.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
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

  describe("what measured sets cost", () => {
    const FREE = { overhead: 0, correction: 1, unitOverhead: 0 };

    /** A calibration fitting each named suite's batches both ways. */
    function measuredFits(...suites: string[]): Calibration {
      const fits = Object.fromEntries(suites.map((id) => [id, FREE]));
      return {
        setupCost: {},
        suites: fits,
        suitesWithCoverage: { ...fits },
        prologue: 0,
      };
    }

    /** One recorded test of a unit, costing `cost`. */
    function entry(
      scope: string,
      unit: string,
      cost: number,
      suite = "workspace-unit",
    ): ManifestEntry {
      return sampleEntry(
        { k: "unit", s: scope, n: `${unit} > ${cost}` },
        { suite, unit, cost },
      );
    }

    const suites = [suite("workspace-unit", [bakery, cellar])];

    describe("measuredCost()", () => {
      /** A calibration whose coverage-on fit for `workspace-unit` is this. */
      const fittedAs = (fit: typeof FREE): Calibration => ({
        ...measuredFits(),
        suitesWithCoverage: { "workspace-unit": fit },
      });

      it("returns what the entries cost with coverage on", () => {
        // The overhead, twice the tests' twelve seconds, and the unit
        // overhead of each of the two units, against how many of the
        // entries each holds.
        expect(measuredCost(
          fittedAs({ overhead: 10, correction: 2, unitOverhead: 1 }),
          [
            entry("bakery", "packages/bakery/glaze.test.ts", 3),
            entry("bakery", "packages/bakery/glaze.test.ts", 4),
            entry("bakery", "packages/bakery/proof.test.ts", 5),
          ],
        )).toEqual({
          overhead: 10,
          spread: 24,
          units: [{ overhead: 1, entries: 2 }, { overhead: 1, entries: 1 }],
          largest: 21,
        });
      });

      it("charges an entry once for every time it runs", () => {
        const repeated = {
          ...entry("bakery", "packages/bakery/glaze.test.ts", 3),
          repeats: 4,
        };
        expect(
          measuredCost(
            fittedAs({ overhead: 0, correction: 2, unitOverhead: 0 }),
            [repeated],
          )?.spread,
        ).toBe(24);
      });

      it("returns `undefined` where no lane has run a suite with coverage on", () => {
        expect(measuredCost(measuredFits(), [
          entry("bakery", "packages/bakery/glaze.test.ts", 3),
        ])).toBeUndefined();
      });
    });

    describe("measuredCostLines()", () => {
      it("names a set past `LOCAL_COVERAGE_MAX_SECONDS`, and no set inside it", () => {
        const lines = measuredCostLines(
          sampleManifest({
            calibration: measuredFits("workspace-unit"),
            entries: [
              entry("bakery", "packages/bakery/glaze.test.ts", 20),
              entry("bakery", "packages/bakery/proof.test.ts", 20),
              entry(
                "cellar",
                "packages/cellar/rack.test.ts",
                LOCAL_COVERAGE_MAX_SECONDS,
              ),
            ],
          }),
          suites,
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
          "workspace-unit/packages/bakery costs 40s with coverage on",
        );
      });

      it("leaves out the units the suite declares unavailable", () => {
        // `proof.test.ts` does not run here, so the set costs only what
        // `glaze.test.ts` does.

        const lines = measuredCostLines(
          sampleManifest({
            calibration: measuredFits("workspace-unit"),
            entries: [
              entry("bakery", "packages/bakery/glaze.test.ts", 20),
              entry("bakery", "packages/bakery/proof.test.ts", 20),
            ],
          }),
          [
            suite("workspace-unit", [bakery], [{
              unit: "packages/bakery/proof.test.ts",
              reason: "needs a display",
            }]),
          ],
        );
        expect(lines).toEqual([]);
      });

      describe("what a set is charged", () => {
        /**
         * A set of one suite, which opens a capability costing ten
         * seconds, and whose batches with coverage on pay five before
         * running anything: fifteen a lane before its tests.
         */
        const costing = (...costs: number[]) =>
          measuredCostLines(
            sampleManifest({
              calibration: {
                setupCost: { deno: 10 },
                suites: {},
                suitesWithCoverage: {
                  "workspace-unit": {
                    overhead: 5,
                    correction: 1,
                    unitOverhead: 0,
                  },
                },
                prologue: 0,
              },
              entries: costs.map((cost) =>
                entry("cellar", "packages/cellar/rack.test.ts", cost)
              ),
            }),
            [{ ...suite("workspace-unit", [cellar]), needs: ["deno"] }],
          );

        it("counts the setup of the capabilities its suite needs", () => {
          // Twenty seconds of tests are inside the limit, and the fifteen
          // the lane pays first are not.

          expect(costing(20)).toEqual([
            "workspace-unit/packages/cellar costs 35s with coverage on, " +
            `past LOCAL_COVERAGE_MAX_SECONDS of ${
              duration(LOCAL_COVERAGE_MAX_SECONDS)
            }. ` +
            "Its member's tests could be split, the run could carry the " +
            "cost, or the member could go on EXCLUDED_FROM_COVERAGE_GATE.",
          ]);
          expect(costing(LOCAL_COVERAGE_MAX_SECONDS - 15)).toEqual([]);
        });

        it("counts the overhead and setup again in each lane it spreads over", () => {
          const tests = LANE_BUDGET_SECONDS * 1.5;
          expect(costing(tests / 2, tests / 2)[0]).toContain(
            `costs ${duration(tests + 2 * 15)} with coverage on`,
          );
        });

        it("says so where one of its tests costs more than a lane holds", () => {
          // Two lanes hold the total, but one test's runs all go in one lane.
          expect(costing(LANE_BUDGET_SECONDS)[0]).toContain(
            "workspace-unit/packages/cellar costs more with coverage on " +
              `than the run's ${LANES} lanes of ${
                duration(LANE_BUDGET_SECONDS)
              } hold`,
          );
          expect(costing(LANE_BUDGET_SECONDS / 2, LANE_BUDGET_SECONDS / 2)[0])
            .toContain(
              `costs ${duration(LANE_BUDGET_SECONDS + 2 * 15)} with ` +
                "coverage on",
            );
        });

        it("says so where the run's lanes cannot hold it", () => {
          expect(costing(LANE_BUDGET_SECONDS * LANES)[0]).toContain(
            "workspace-unit/packages/cellar costs more with coverage on " +
              `than the run's ${LANES} lanes of ${
                duration(LANE_BUDGET_SECONDS)
              } ` +
              "hold, past LOCAL_COVERAGE_MAX_SECONDS",
          );
        });
      });

      describe("a member excluded for its size", () => {
        /**
         * The runner's unit suite, which opens a capability costing ten
         * seconds, and whose batches with coverage on pay twenty before
         * running anything: thirty a lane before its tests.
         */
        const runner: Suite = { ...suite("runner-unit", []), needs: ["deno"] };
        const calibration = (): Calibration => ({
          setupCost: { deno: 10 },
          suites: {},
          suitesWithCoverage: {
            "runner-unit": { overhead: 20, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        });
        /** One test of the runner costing each of `seconds`. */
        const costing = (...seconds: number[]) =>
          measuredCostLines(
            sampleManifest({
              calibration: calibration(),
              entries: seconds.map((cost, index) =>
                sampleEntry(
                  { k: "unit", s: "runner", n: `test ${index}` },
                  {
                    suite: "runner-unit",
                    unit: "packages/runner/test/one.test.ts",
                    cost,
                  },
                )
              ),
            }),
            [runner],
          );
        const room = LANE_BUDGET_SECONDS - 30;

        it("is named once its tests fit the run's lanes, each paying its own overhead", () => {
          expect(costing(room, room, room)).toEqual([
            `packages/runner is on EXCLUDED_FROM_COVERAGE_GATE for its ` +
            `size, and its tests now cost ${
              duration(room * 3 + 3 * 30)
            } with coverage on across 3 lane(s), inside the run's ` +
            `${LANES} lanes of ${
              duration(LANE_BUDGET_SECONDS)
            }, so its line can ` +
            `come off.`,
          ]);
        });

        it("is not named where it fits the run only by paying its overhead once", () => {
          // Charged once, this fits the five lanes' budget exactly. Each
          // lane it spreads over pays the thirty again, so it does not.
          const tests = LANE_BUDGET_SECONDS * LANES - 30;
          expect(
            costing(...Array(2 * LANES).fill(tests / (2 * LANES))),
          ).toEqual([]);
        });

        it("counts a unit's overhead in each lane its entries are split over", () => {
          // Two entries of one unit that no one lane holds together, so
          // two lanes each open the unit.

          const unitOverhead = 5;
          const half = (LANE_BUDGET_SECONDS - 33) / 2;
          const lines = measuredCostLines(
            sampleManifest({
              calibration: {
                ...calibration(),
                suitesWithCoverage: {
                  "runner-unit": { overhead: 20, correction: 1, unitOverhead },
                },
              },
              entries: [half, half].map((seconds, index) =>
                sampleEntry(
                  { k: "unit", s: "runner", n: `half ${index}` },
                  {
                    suite: "runner-unit",
                    unit: "packages/runner/test/one.test.ts",
                    cost: seconds,
                  },
                )
              ),
            }),
            [runner],
          );
          expect(lines).toEqual([
            `packages/runner is on EXCLUDED_FROM_COVERAGE_GATE for its ` +
            `size, and its tests now cost ${
              duration(2 * half + 2 * 30 + 2 * unitOverhead)
            } with coverage on across 2 lane(s), inside the run's ` +
            `${LANES} lanes of ${
              duration(LANE_BUDGET_SECONDS)
            }, so its line can ` +
            `come off.`,
          ]);
        });

        it("counts a unit's overhead once where it holds one entry", () => {
          // Two units of one entry each, which two lanes hold only if each
          // unit's overhead is paid once.
          const unitOverhead = 5;
          const each = LANE_BUDGET_SECONDS - 40;
          const lines = measuredCostLines(
            sampleManifest({
              calibration: {
                ...calibration(),
                suitesWithCoverage: {
                  "runner-unit": { overhead: 20, correction: 1, unitOverhead },
                },
              },
              entries: ["one", "two"].map((name) =>
                entry(
                  "runner",
                  `packages/runner/test/${name}.test.ts`,
                  each,
                  "runner-unit",
                )
              ),
            }),
            [runner],
          );
          expect(lines[0]).toContain(
            `now cost ${
              duration(2 * each + 2 * 30 + 2 * unitOverhead)
            } with coverage on across 2 lane(s)`,
          );
        });

        it("is not named where a lane's fixed charge leaves no room for its tests", () => {
          const lines = measuredCostLines(
            sampleManifest({
              calibration: {
                ...calibration(),
                setupCost: { deno: LANE_BUDGET_SECONDS },
              },
              entries: [
                entry(
                  "runner",
                  "packages/runner/test/one.test.ts",
                  1,
                  "runner-unit",
                ),
              ],
            }),
            [runner],
          );
          expect(lines).toEqual([]);
        });
      });

      it("names no member excluded for a reason other than its size", () => {
        const lines = measuredCostLines(
          sampleManifest({
            calibration: measuredFits("workspace-unit"),
            entries: [entry("cli", "packages/cli/test/one.test.ts", 1)],
          }),
          [],
        );
        expect(lines).toEqual([]);
      });

      it("says it cannot say what anything costs before a lane has run it with coverage on", () => {
        const lines = measuredCostLines(
          sampleManifest({
            calibration: measuredFits(),
            entries: [
              entry("bakery", "packages/bakery/glaze.test.ts", 900),
              entry("cellar", "packages/cellar/rack.test.ts", 1),
              entry(
                "runner",
                "packages/runner/test/one.test.ts",
                1,
                "runner-unit",
              ),
            ],
          }),
          suites,
        );
        expect(lines).toEqual([
          "What 3 measured set(s) or exclusion-list entries cost with " +
          "coverage on cannot be said yet: no lane has run runner-unit, " +
          `workspace-unit with coverage on in the last ${COST_WINDOW_DAYS} ` +
          "day(s).",
        ]);
      });

      it("says nothing of a set with no recorded test", () => {
        expect(
          measuredCostLines(
            sampleManifest({ calibration: measuredFits(), entries: [] }),
            suites,
          ),
        ).toEqual([]);
      });
    });
  });
});
