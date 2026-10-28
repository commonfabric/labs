import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  coverageGateSelection,
  measuredCost,
  measuredCostLines,
  measuredMembersOf,
} from "./coverage.ts";
import {
  COVERAGE_GATE_SUITE,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "../test-topology/coverage-gates.ts";
import type { GateChoice } from "./plan.ts";
import type { Calibration, ManifestEntry, SuiteFit } from "./manifest.ts";
import {
  COST_WINDOW_DAYS,
  LANE_BUDGET_SECONDS,
  LANES_MAX,
  LOCAL_COVERAGE_MAX_SECONDS,
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
    /** A gate over `set`, as the census offers it. */
    function gateOf(set: MeasuredSet, reached: boolean): GateChoice {
      return {
        entry: sampleEntry(
          { k: "gate", s: set.member.slice("packages/".length), n: "g" },
          {
            suite: COVERAGE_GATE_SUITE,
            unit: `workspace-unit/${set.member}`,
          },
        ),
        judges: "workspace-unit",
        members: [],
        reached,
      };
    }

    it("names the sets of the gates a plan chose, apart from those it reached", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gates = [gateOf(bakery, true), gateOf(cellar, true)];
      const selection = coverageGateSelection(suites, gates, [gates[1]!]);
      expect(selection.sets.map(measuredSetName))
        .toEqual(["workspace-unit/packages/cellar"]);
      expect(selection.reached.map(measuredSetName)).toEqual([
        "workspace-unit/packages/bakery",
        "workspace-unit/packages/cellar",
      ]);
    });

    it("names a gate the full run chose that the change did not reach", () => {
      const suites = [suite("workspace-unit", [bakery, cellar])];
      const gates = [gateOf(bakery, false), gateOf(cellar, false)];
      const selection = coverageGateSelection(suites, gates, gates);
      expect(selection.sets).toHaveLength(2);
      expect(selection.reached).toEqual([]);
    });

    it("names no set for a chosen entry that is not a coverage gate", () => {
      const suites = [suite("workspace-unit", [bakery])];
      const other = sampleEntry({ k: "unit", s: "bakery", n: "glaze" }, {
        unit: "workspace-unit/packages/bakery",
      });
      expect(coverageGateSelection(suites, [], [{ entry: other }]).sets)
        .toEqual([]);
    });

    it("names the members one suite measures", () => {
      const runner: MeasuredSet = {
        member: "packages/runner",
        reachedBy: ["packages/runner/"],
        units: ["packages/runner/one.test.ts"],
      };
      const selection = {
        sets: [
          { suite: "workspace-unit", set: bakery },
          { suite: "runner-unit", set: runner },
        ],
        reached: [],
      };
      expect([...measuredMembersOf(selection, "workspace-unit")])
        .toEqual(["packages/bakery"]);
      expect([...measuredMembersOf(selection, "runner-unit")])
        .toEqual(["packages/runner"]);
      expect([...measuredMembersOf(selection, "nothing-unit")]).toEqual([]);
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
      const fittedAs = (fit: SuiteFit): Calibration => ({
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

      it("counts each unit's hooks with its entries' time", () => {
        // The glaze unit's hooks take five seconds on top of its entries'
        // seven, and the proof unit has none, so the tests take seventeen
        // seconds through the correction of two. The largest entry is then
        // glaze's four seconds rather than proof's five.
        expect(measuredCost(
          fittedAs({
            overhead: 10,
            correction: 2,
            unitOverhead: 1,
            unitHooks: { "packages/bakery/glaze.test.ts": 5 },
          }),
          [
            entry("bakery", "packages/bakery/glaze.test.ts", 3),
            entry("bakery", "packages/bakery/glaze.test.ts", 4),
            entry("bakery", "packages/bakery/proof.test.ts", 5),
          ],
        )).toEqual({
          overhead: 10,
          spread: 34,
          units: [{ overhead: 1, entries: 2 }, { overhead: 1, entries: 1 }],
          largest: 29,
        });
      });

      it("charges its largest entry no less than that entry's own time", () => {
        // The suite runs its units side by side, and a lane holding one
        // entry still takes that entry's whole time, twice over where it
        // runs twice, however the entries are spread. Each run is a pass
        // of its own, which starts the suite and opens the unit again.
        const repeated = {
          ...entry("bakery", "packages/bakery/glaze.test.ts", 100),
          repeats: 2,
        };
        expect(
          measuredCost(
            fittedAs({ overhead: 10, correction: 0.4, unitOverhead: 1 }),
            [repeated],
          ),
        ).toEqual({
          overhead: 10,
          spread: 211,
          units: [{ overhead: 1, entries: 1 }],
          largest: 222,
        });
      });

      it("spreads no less than the longest unit takes", () => {
        // Corrected, the two entries of the one unit come to 36 seconds.
        // They run one after the other, so the unit takes 90.
        expect(
          measuredCost(
            fittedAs({ overhead: 0, correction: 0.4, unitOverhead: 0 }),
            [
              entry("bakery", "packages/bakery/glaze.test.ts", 40),
              entry("bakery", "packages/bakery/glaze.test.ts", 50),
            ],
          )?.spread,
        ).toBe(90);
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
        expect(measuredCost(
          measuredFits(),
          [entry("bakery", "packages/bakery/glaze.test.ts", 3)],
        )).toBeUndefined();
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
              `than the ${LANES_MAX} lanes of ${
                duration(LANE_BUDGET_SECONDS)
              } a pull request may take hold`,
          );
          expect(costing(LANE_BUDGET_SECONDS / 2, LANE_BUDGET_SECONDS / 2)[0])
            .toContain(
              `costs ${duration(LANE_BUDGET_SECONDS + 2 * 15)} with ` +
                "coverage on",
            );
        });

        it("says so where the run's lanes cannot hold it", () => {
          expect(costing(LANE_BUDGET_SECONDS * LANES_MAX)[0]).toContain(
            "workspace-unit/packages/cellar costs more with coverage on " +
              `than the ${LANES_MAX} lanes of ${
                duration(LANE_BUDGET_SECONDS)
              } a pull request may take hold, past ` +
              "LOCAL_COVERAGE_MAX_SECONDS",
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
            } with coverage on across 3 lane(s), inside the ` +
            `${LANES_MAX} lanes of ${
              duration(LANE_BUDGET_SECONDS)
            } a pull request may take, so its line can come off.`,
          ]);
        });

        it("is not named where it fits the run only by paying its overhead once", () => {
          // Charged once, this fits the most lanes' budget exactly. Each
          // lane it spreads over pays the thirty again, so it does not.
          const tests = LANE_BUDGET_SECONDS * LANES_MAX - 30;
          expect(
            costing(...Array(2 * LANES_MAX).fill(tests / (2 * LANES_MAX))),
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
            } with coverage on across 2 lane(s), inside the ` +
            `${LANES_MAX} lanes of ${
              duration(LANE_BUDGET_SECONDS)
            } a pull request may take, so its line can come off.`,
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
