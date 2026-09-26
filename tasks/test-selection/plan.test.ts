import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { testIdentityKey } from "@commonfabric/test-support/records";

import {
  crowdingLine,
  foldWholeUnits,
  fullLaneCount,
  plan,
  type PlanInput,
  seededOrder,
  type Selection,
  type SelectionReason,
} from "./plan.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import type { WithheldReason } from "@commonfabric/test-support/records";
import { sampleEntry, sampleManifest } from "./testing.ts";
import {
  FULL_LANE_BUDGET_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES,
} from "./policy.ts";

const NO_CAPABILITIES = new Map<string, readonly string[]>();
const NO_WHOLE_UNITS: ReadonlySet<string> = new Set();

/** `count` identities of one suite, each in its own invocation unit. */
function entries(
  count: number,
  fields: (i: number) => Partial<ManifestEntry> = () => ({}),
): ManifestEntry[] {
  return Array.from(
    { length: count },
    (_, i) =>
      sampleEntry({ k: "unit", s: "memory", n: `case ${i}` }, {
        unit: `packages/memory/test/case-${i}.test.ts`,
        ...fields(i),
      }),
  );
}

function run(
  manifest: Manifest,
  overrides: Partial<PlanInput> = {},
) {
  return plan({
    manifest,
    mandatory: new Map(),
    capabilities: NO_CAPABILITIES,
    wholeUnits: NO_WHOLE_UNITS,
    ...overrides,
  });
}

function selected(result: ReturnType<typeof plan>): Selection[] {
  return result.lanes.flatMap((lane) => lane.selections);
}

function keysOf(result: ReturnType<typeof plan>): string[] {
  return selected(result).map((s) => testIdentityKey(s.entry.test)).sort();
}

/** Every identity of a manifest, mandatory, in the manifest's own order. */
function everything(manifest: Manifest): Map<string, SelectionReason> {
  return new Map(
    manifest.entries.map((entry) => [
      testIdentityKey(entry.test),
      "changed" as const,
    ]),
  );
}

describe("plan", () => {
  describe("the partition", () => {
    it("fills exactly the lanes it was asked for", () => {
      const result = run(sampleManifest({ entries: entries(20) }));
      expect(result.lanes.length).toBe(LANES);
      expect(result.lanes.map((lane) => lane.lane)).toEqual([1, 2, 3, 4, 5]);
    });

    it("refuses to pack into no lanes at all", () => {
      const manifest = sampleManifest({ entries: entries(3) });
      expect(() => run(manifest, { lanes: 0 })).toThrow(RangeError);
    });

    it("puts no identity in two lanes", () => {
      const result = run(sampleManifest({ entries: entries(200) }));
      const keys = keysOf(result);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("gives the same answer every time from the same inputs", () => {
      const manifest = sampleManifest({ entries: entries(200) });
      expect(keysOf(run(manifest))).toEqual(keysOf(run(manifest)));
    });

    it("keeps one lane's selections in a stable order", () => {
      // Determinism of the set is checked above; this is the order within
      // a lane, which is what a lane runs its batches in and what a job
      // summary lists.
      const manifest = sampleManifest({ entries: entries(200) });
      expect(run(manifest).lanes[2]!.selections.map((s) => s.entry.test.n))
        .toEqual(run(manifest).lanes[2]!.selections.map((s) => s.entry.test.n));
    });
  });

  describe("what must run", () => {
    it("takes every mandatory identity before anything else", () => {
      const manifest = sampleManifest({ entries: entries(50) });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[7]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory });
      const taken = selected(result).find((s) => s.entry.test.n === "case 7");
      expect(taken?.reason).toBe("changed");
    });

    it("keeps the repeats of an identity the coverage gate pulled in", () => {
      // Measuring a set is not a reason to run one of its tests fewer
      // times than a lane that never measured it would have.
      const manifest = sampleManifest({
        entries: entries(3, () => ({ repeats: 3 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "coverage-gate" as const,
      ]]);
      const result = run(manifest, { mandatory });
      const taken = selected(result).find((s) => s.entry.test.n === "case 0");
      expect(taken?.repeats).toBe(3);
    });

    it("charges a lane for every run of a repeated mandatory identity", () => {
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 10, repeats: 3 })),
      });
      const once = run(
        sampleManifest({ entries: entries(1, () => ({ cost: 10 })) }),
        {
          mandatory: new Map([[
            testIdentityKey(manifest.entries[0]!.test),
            "coverage-gate" as const,
          ]]),
        },
      );
      const thrice = run(manifest, {
        mandatory: new Map([[
          testIdentityKey(manifest.entries[0]!.test),
          "coverage-gate" as const,
        ]]),
      });
      const load = (result: ReturnType<typeof run>) =>
        result.lanes.reduce((total, lane) => total + lane.projectedSeconds, 0);
      expect(load(thrice)).toBeGreaterThan(load(once));
    });

    it("keeps the repeats of an identity the change edited", () => {
      // A test the change edits is one of the two routes an excluded
      // identity reaches a lane by, and the count is what makes it prove
      // itself there.
      const manifest = sampleManifest({
        entries: entries(3, () => ({ repeats: 3 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory });
      const taken = selected(result).find((s) => s.entry.test.n === "case 0");
      expect(taken?.repeats).toBe(3);
    });

    it("keeps the repeats of every identity of the full run", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({ repeats: 3 })),
      });
      const result = run(manifest, { policy: "everything" });
      expect(selected(result).map((s) => s.repeats)).toEqual([3, 3, 3]);
    });

    it("gives up a mandatory identity's runs until they fit a lane", () => {
      // All of one identity's runs go in one lane, so a lane cannot be
      // added to make room for them, and one observation beats none.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 100, repeats: 3 })),
      });
      const result = run(manifest, {
        mandatory: new Map([[
          testIdentityKey(manifest.entries[0]!.test),
          "coverage-gate" as const,
        ]]),
        budgetSeconds: 250,
      });
      expect(selected(result)[0]?.repeats).toBe(2);
    });

    it("places a mandatory identity no lane can hold, and says so", () => {
      // Mandatory means mandatory. Leaving it out would report a pass
      // over a test that never ran, where placing it produces a lane
      // that runs long and a figure saying by how much.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 1000, repeats: 3 })),
      });
      const key = testIdentityKey(manifest.entries[0]!.test);
      const result = run(manifest, {
        mandatory: new Map([[key, "coverage-gate" as const]]),
        budgetSeconds: 10,
      });
      expect(selected(result).map((s) => testIdentityKey(s.entry.test)))
        .toEqual([key]);
      // Down to once, and never to nothing.
      expect(selected(result)[0]?.repeats).toBe(1);
      expect(result.overBudgetSeconds).toBeGreaterThan(0);
      // The list of work no lane can hold names the discretionary
      // identities alone, so nothing reads a required one as dropped.
      expect(result.unschedulable).toEqual([]);
    });

    it("never leaves a mandatory identity out, whatever it costs", () => {
      // Every identity is mandatory here, and each costs more than a
      // lane's whole budget.
      const manifest = sampleManifest({
        entries: entries(4, () => ({ cost: 5000, repeats: 2 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 10,
      });
      expect(selected(result)).toHaveLength(4);
      expect(result.unschedulable).toEqual([]);
    });

    it("says by how much the mandatory set alone overran", () => {
      const manifest = sampleManifest({
        entries: entries(4, () => ({ cost: 100 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 10,
      });
      expect(result.overBudgetSeconds).toBeCloseTo(90, 6);
      expect(selected(result).length).toBe(4);
    });

    it("says a lane is past its budget where the run's total fits", () => {
      // Six identities at 120 seconds, in five lanes of 230. The six fit
      // the run's 1,150 seconds between them, and the sixth still fits no
      // lane: five of them are carrying 120 seconds each already.
      const manifest = sampleManifest({
        entries: entries(6, () => ({ cost: 120 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 230,
      });
      expect(result.overBudgetSeconds).toBeCloseTo(10, 6);
    });
  });

  describe("what must not run", () => {
    it("leaves out an identity the manifest withholds", () => {
      const manifest = sampleManifest({ entries: entries(5) });
      const held = manifest.entries[2]!;
      manifest.withheld = [{
        test: held.test,
        suite: held.suite,
        reason: "flaky",
      }];
      const result = run(manifest);
      expect(selected(result).some((s) => s.entry.test.n === "case 2")).toBe(
        false,
      );
    });

    it("leaves out an identity too flaky to judge a change by", () => {
      const manifest = sampleManifest({
        entries: entries(5, (i) => (i === 3 ? { flakeRate: 0.5 } : {})),
      });
      const result = run(manifest);
      expect(selected(result).some((s) => s.entry.test.n === "case 3")).toBe(
        false,
      );
    });

    it("lets a withheld identity back in when the change touches it", () => {
      const manifest = sampleManifest({
        entries: entries(5, (i) => (i === 3 ? { flakeRate: 0.5 } : {})),
      });
      const held = manifest.entries[2]!;
      manifest.withheld = [{
        test: held.test,
        suite: held.suite,
        reason: "flaky",
      }];
      const mandatory = new Map([
        [testIdentityKey(held.test), "changed" as const],
        [testIdentityKey(manifest.entries[3]!.test), "changed" as const],
      ]);
      const names = selected(run(manifest, { mandatory })).map((s) =>
        s.entry.test.n
      );
      expect(names).toContain("case 2");
      expect(names).toContain("case 3");
    });

    it("hands the withheld set on, so a lane can say what is absent", () => {
      const manifest = sampleManifest({ entries: entries(5) });
      manifest.withheld = [{
        test: manifest.entries[1]!.test,
        suite: "workspace-unit",
        reason: "flaky",
      }];
      expect(run(manifest).withheld).toEqual(manifest.withheld);
    });
  });

  describe("the budget", () => {
    it("stops before the budget when the corpus is larger than it", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const total = result.lanes.reduce(
        (sum, lane) => sum + lane.projectedSeconds,
        0,
      );
      expect(total).toBeLessThanOrEqual(20 * LANES);
      expect(selected(result).length).toBeLessThan(500);
    });

    it("runs everything when the corpus fits", () => {
      const manifest = sampleManifest({
        entries: entries(10, () => ({ cost: 0.01 })),
      });
      expect(selected(run(manifest)).length).toBe(10);
    });

    it("drops repeats before it drops the identity", () => {
      // Three identities wanting three runs each, in a budget that holds
      // four runs. One observation of each beats three of one.
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1, repeats: 3 })),
      });
      const result = run(manifest, { lanes: 1, budgetSeconds: 4 });
      expect(selected(result).length).toBe(3);
      expect(selected(result).every((s) => s.repeats >= 1)).toBe(true);
    });
  });

  describe("the lane budget", () => {
    // A suite charging an overhead every lane that opens it pays. That is
    // what makes the lane which has already paid it the cheapest place
    // for the rest of the suite, and so what a per-lane budget has to
    // overrule.
    const grouped: Calibration = {
      setupCost: {},
      suites: {
        "workspace-unit": { overhead: 10, correction: 1, unitOverhead: 0 },
      },
      prologue: 0,
    };

    it("gives no lane more work than one lane's budget", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
        calibration: grouped,
      });
      for (const lane of run(manifest, { budgetSeconds: 20 }).lanes) {
        expect(lane.projectedSeconds).toBeLessThanOrEqual(20);
      }
    });

    it("fills every lane rather than one lane five times over", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
        calibration: grouped,
      });
      for (const lane of run(manifest, { budgetSeconds: 40 }).lanes) {
        expect(lane.projectedSeconds).toBeCloseTo(40, 6);
      }
    });

    it("gives an identity larger than a lane's budget a lane to itself", () => {
      const manifest = sampleManifest({
        entries: entries(60, (i) => (i === 0 ? { cost: 250 } : { cost: 1 })),
        calibration: grouped,
      });
      const result = run(manifest, { budgetSeconds: 230, boundSeconds: 300 });
      const alone = result.lanes.find((lane) =>
        lane.selections.some((s) => s.entry.test.n === "case 0")
      )!;
      expect(alone.selections.length).toBe(1);
      expect(alone.projectedSeconds).toBeCloseTo(260, 6);
    });

    it("holds a repeated identity to the budget rather than the bound", () => {
      // The lane to itself is for an identity that cannot be split. Three
      // runs of a hundred seconds do not fit a lane's budget and two do,
      // so the identity gives up a run rather than the lane its budget.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 100, repeats: 3 })),
      });
      const result = run(manifest, { budgetSeconds: 230, boundSeconds: 300 });
      expect(selected(result)[0]!.repeats).toBe(2);
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(200, 6);
    });

    it("takes the largest mandatory identity before the small ones", () => {
      // Nine identities that between them fill most of the lanes, and one
      // costing most of a lane on its own. Taken in the order the caller
      // listed them, the nine leave the tenth no lane it fits inside;
      // taken largest first, all ten fit.
      const manifest = sampleManifest({
        entries: entries(10, (i) => (i === 9 ? { cost: 90 } : { cost: 18 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 100,
      });
      expect(selected(result).length).toBe(10);
      for (const lane of result.lanes) {
        expect(lane.projectedSeconds).toBeLessThanOrEqual(100);
      }
    });

    it("spreads a mandatory set no lane can hold over all of them", () => {
      // Twenty identities that must run, costing between them nearly
      // twice what the five lanes hold. Each lane carries four of them,
      // rather than one lane carrying the whole overrun.
      const manifest = sampleManifest({
        entries: entries(20, () => ({ cost: 30 })),
        calibration: grouped,
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 70,
      });
      for (const lane of result.lanes) {
        expect(lane.selections.length).toBe(4);
        expect(lane.projectedSeconds).toBeCloseTo(130, 6);
      }
      expect(result.overBudgetSeconds).toBeCloseTo(60, 6);
    });
  });

  describe("the filling order", () => {
    it("takes the highest-scoring identity even when it is expensive", () => {
      const manifest = sampleManifest({
        entries: entries(
          30,
          (i) =>
            i === 17 ? { cost: 40, score: 0.9 } : { cost: 0.1, score: 0.05 },
        ),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const taken = selected(result).find((s) => s.entry.test.n === "case 17");
      expect(taken?.reason).toBe("value");
    });

    it("sweeps the cheap tail up under the density pass", () => {
      // Expensive proven tests take the value pass's whole share. The
      // tail is worth a hundred times more per second, so the density
      // pass is where it comes in.
      const manifest = sampleManifest({
        entries: entries(
          220,
          (i) => i < 20 ? { cost: 5, score: 0.9 } : { cost: 0.01, score: 0.05 },
        ),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const byReason = new Map<string, number>();
      for (const selection of selected(result)) {
        byReason.set(
          selection.reason,
          (byReason.get(selection.reason) ?? 0) + 1,
        );
      }
      expect(byReason.get("value")).toBeGreaterThan(0);
      expect(byReason.get("density")).toBeGreaterThan(100);
    });

    it("spends its last share on what the value ordering passed over", () => {
      const manifest = sampleManifest({
        entries: entries(400, (i) => ({
          cost: 0.5,
          score: i < 20 ? 0.9 : 0.05,
        })),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const reasons = new Set(selected(result).map((s) => s.reason));
      expect(reasons.has("exploration")).toBe(true);
    });

    it("draws the longest-unrun first", () => {
      // What makes the draw a sweep of the corpus rather than a sample
      // of it: everything ran yesterday except one that has not run for
      // a year, and that one is what the draw reaches for.
      const manifest = sampleManifest({
        entries: entries(60, (i) => ({
          cost: 1,
          score: 0.05,
          lastRun: i === 41 ? "2025-09-01" : "2026-08-31",
        })),
      });
      const result = run(manifest, { budgetSeconds: 2, lanes: 1 });
      const drawn = selected(result).filter((s) => s.reason === "exploration");
      expect(drawn.length).toBeGreaterThan(0);
      expect(testIdentityKey(drawn[0]!.entry.test)).toBe(
        testIdentityKey({ k: "unit", s: "memory", n: "case 41" }),
      );
    });

    it("draws an identity nothing has run ahead of every day there is", () => {
      const manifest = sampleManifest({
        entries: entries(60, (i) => ({
          cost: 1,
          score: 0.05,
          ...(i === 17 ? {} : { lastRun: "2020-01-01" }),
        })),
      });
      const result = run(manifest, { budgetSeconds: 2, lanes: 1 });
      const drawn = selected(result).filter((s) => s.reason === "exploration");
      expect(testIdentityKey(drawn[0]!.entry.test)).toBe(
        testIdentityKey({ k: "unit", s: "memory", n: "case 17" }),
      );
    });
  });

  describe("the density pass", () => {
    // One lane of 111 seconds unless a case says otherwise. A mandatory
    // test opens `open.test.ts` for eleven of them, leaving 100 for the
    // three discretionary passes, and a test worth more than anything
    // else takes 59.5 of the value pass's 60. The density pass then has
    // 25.5 seconds, and what the rest cost the lane decides what it
    // spends them on. Opening a file costs ten seconds.
    const perFile: Calibration = {
      setupCost: { toolshed: 10 },
      suites: {
        "workspace-unit": { overhead: 0, correction: 1, unitOverhead: 10 },
        "runner-unit": { overhead: 10, correction: 1, unitOverhead: 5 },
        "cli-deno": { overhead: 0, correction: 1, unitOverhead: 0 },
        "cli-core": { overhead: 0, correction: 1, unitOverhead: 0 },
      },
      prologue: 0,
    };

    function test(
      name: string,
      unit: string,
      fields: Partial<ManifestEntry> = {},
    ): ManifestEntry {
      return sampleEntry({ k: "unit", s: "memory", n: name }, {
        unit,
        cost: 1,
        score: 0.05,
        ...fields,
      });
    }

    const opener = test("opener", "open.test.ts");
    const opened = new Map([[
      testIdentityKey(opener.test),
      "changed" as const,
    ]]);

    function packed(
      rest: ManifestEntry[],
      overrides: Partial<PlanInput> = {},
    ): ReturnType<typeof plan> {
      const proven = test("proven", "proven.test.ts", {
        cost: 49.5,
        score: 0.9,
      });
      return run(
        sampleManifest({
          entries: [opener, proven, ...rest],
          calibration: perFile,
        }),
        { lanes: 1, budgetSeconds: 111, mandatory: opened, ...overrides },
      );
    }

    function reasons(result: ReturnType<typeof plan>): Map<string, string> {
      return new Map(
        selected(result).map((s) => [s.entry.test.n, s.reason]),
      );
    }

    it("takes the tests of a file a lane has opened ahead of files it has not", () => {
      // Every candidate is worth the same and takes a second. Each of the
      // four strangers opens a file of its own, so it costs the lane
      // eleven, where each sibling of the mandatory test costs one. The
      // strangers are listed first.
      const strangers = [1, 2, 3, 4].map((i) =>
        test(`stranger ${i}`, `stranger-${i}.test.ts`)
      );
      const siblings = [2, 3, 4, 5].map((i) =>
        test(`sibling ${i}`, "open.test.ts")
      );
      const chosen = reasons(packed([...strangers, ...siblings]));
      for (const sibling of siblings) {
        expect(chosen.get(sibling.test.n)).toBe("density");
      }
      expect(
        strangers.filter((s) => chosen.get(s.test.n) === "density").length,
      ).toBe(1);
    });

    it("charges a test the overhead of a suite its lane is not holding", () => {
      // The runner test shares the opened file's path and takes half a
      // second of its own. Its suite is not in the lane, so it costs the
      // lane that suite's ten seconds and its own unit's five. The
      // stranger costs eleven. There is room for one of the two.
      const other = test("other suite", "open.test.ts", {
        suite: "runner-unit",
        cost: 0.5,
      });
      const stranger = test("stranger", "stranger.test.ts");
      const chosen = reasons(packed([other, stranger]));
      expect(chosen.get("stranger")).toBe("density");
      expect(chosen.get("other suite")).not.toBe("density");
    });

    it("moves a suite up once its lane has set up a capability it needs", () => {
      // Two suites with no overheads need one capability, which costs ten
      // seconds to set up. The first suite's test is worth enough to be
      // taken first, and its lane sets the capability up. The other
      // suite's test then costs the lane its own second, where the
      // stranger, which the identity key puts first between equals, still
      // costs eleven.
      const stranger = test("stranger", "stranger.test.ts");
      const first = test("first", "first.test.ts", {
        suite: "cli-deno",
        score: 0.5,
      });
      const then = test("then", "then.test.ts", { suite: "cli-core" });
      const lane = packed([stranger, then, first], {
        capabilities: new Map([
          ["cli-deno", ["toolshed"]],
          ["cli-core", ["toolshed"]],
        ]),
      }).lanes[0]!;
      expect(
        lane.selections
          .filter((s) => s.reason === "density")
          .map((s) => s.entry.test.n),
      ).toEqual(["first", "then", "stranger"]);
    });

    it("charges a test what the next lane costs once its file's lane is full", () => {
      // Three lanes of 31.5 seconds. The mandatory test fills the first to
      // thirty and the proven test has the second to itself, so the
      // density pass has 16.825 seconds. One sibling fits beside the
      // mandatory test; the other then costs eleven in the third lane,
      // which the test of a suite with no overheads beats at five.
      // Taking both is past what the pass may spend.
      const siblings = [2, 3].map((i) => test(`sibling ${i}`, "open.test.ts"));
      const cheap = test("cheap", "cheap.test.ts", {
        suite: "cli-deno",
        cost: 5,
      });
      const result = run(
        sampleManifest({
          entries: [
            test("opener", "open.test.ts", { cost: 20 }),
            test("proven", "proven.test.ts", { cost: 28, score: 0.9 }),
            ...siblings,
            cheap,
          ],
          calibration: perFile,
        }),
        { lanes: 3, budgetSeconds: 31.5, mandatory: opened },
      );
      const chosen = reasons(result);
      expect(chosen.get("sibling 2")).toBe("density");
      expect(chosen.get("cheap")).toBe("density");
      expect(chosen.get("sibling 3")).not.toBe("density");
      expect(
        result.lanes[0]!.selections.map((s) => s.entry.test.n),
      ).toEqual(["opener", "sibling 2"]);
    });

    it("gives the same plan whatever order the manifest lists its tests in", () => {
      // Three lanes of 100 seconds, the proven test filling the value
      // pass's share in a lane to itself. Sixty tests in fifteen files,
      // at two values and two costs, tie with each other in many places,
      // which the identity key decides. What follows the density pass is
      // a draw seeded by position, so it is left out.
      const corpus = [
        opener,
        test("proven", "proven.test.ts", { cost: 163, score: 0.9 }),
        ...Array.from(
          { length: 60 },
          (_, i) =>
            test(`case ${i}`, `file-${i % 15}.test.ts`, {
              score: [0.05, 0.1][i % 2]!,
              cost: [1, 2][(i >> 1) % 2]!,
            }),
        ),
      ];
      const chosen = (entries: ManifestEntry[]) =>
        run(sampleManifest({ entries, calibration: perFile }), {
          lanes: 3,
          budgetSeconds: 100,
          mandatory: opened,
        }).lanes.map((lane) =>
          lane.selections
            .filter((s) => s.reason !== "exploration")
            .map((s) => [s.entry.test.n, s.reason])
        );
      const inOrder = chosen(corpus);
      expect(
        inOrder.flat().filter(([, reason]) => reason === "density").length,
      ).toBeGreaterThan(10);
      expect(chosen([...corpus].reverse())).toEqual(inOrder);
      expect(
        chosen(seededOrder("shuffle", corpus.length).map((i) => corpus[i]!)),
      ).toEqual(inOrder);
    });
  });

  describe("capabilities", () => {
    it("charges a lane for setup it has not opened yet", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "integration", s: "patterns", n: "one" }, {
            suite: "pattern-integration",
            unit: "packages/patterns/integration/one.test.ts",
            cost: 1,
          }),
        ],
        calibration: {
          setupCost: { toolshed: 40 },
          suites: {},
          prologue: 0,
        },
      });
      const result = run(manifest, {
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      const lane = result.lanes.find((l) => l.selections.length > 0)!;
      expect(lane.capabilities).toEqual(["toolshed"]);
      expect(lane.projectedSeconds).toBeCloseTo(41, 6);
    });

    it("groups a suite's identities where its setup is already paid", () => {
      const manifest = sampleManifest({
        entries: entries(4, (i) => ({
          suite: "pattern-integration",
          unit: `packages/patterns/integration/case-${i}.test.ts`,
          cost: 1,
        })),
        calibration: {
          setupCost: { toolshed: 40 },
          suites: {},
          prologue: 0,
        },
      });
      const result = run(manifest, {
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      const opened = result.lanes.filter((lane) =>
        lane.capabilities.includes("toolshed")
      );
      expect(opened.length).toBe(1);
    });
  });

  describe("the hard bound", () => {
    it("reports an identity no lane could hold, and runs it nowhere", () => {
      const manifest = sampleManifest({
        entries: entries(3, (i) => (i === 1 ? { cost: 400 } : { cost: 1 })),
      });
      const result = run(manifest, { boundSeconds: 300 });
      expect(result.unschedulable.map((e) => e.test.n)).toEqual(["case 1"]);
      expect(selected(result).some((s) => s.entry.test.n === "case 1")).toBe(
        false,
      );
    });

    it("counts the overheads a lane would pay for it", () => {
      // A test inside the bound whose suite, unit and capability setup
      // put the lane past it is still one no lane can hold.
      const manifest = sampleManifest({
        entries: entries(
          1,
          () => ({ cost: 200, suite: "pattern-integration" }),
        ),
        calibration: {
          setupCost: { toolshed: 60 },
          suites: {
            "pattern-integration": {
              overhead: 50,
              correction: 1,
              unitOverhead: 0,
            },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, {
        boundSeconds: 300,
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      expect(result.unschedulable.length).toBe(1);
    });

    it("reports the cost the bound was compared against", () => {
      // 200 seconds of test, a suite that costs 50 to open and doubles
      // what runs inside it, a unit that costs 10, and a capability whose
      // setup costs 60. What a lane pays is 520, and that is the number
      // to report: reporting the entry's own 200 would say a test inside
      // a 300-second bound is past it.
      const manifest = sampleManifest({
        entries: entries(1, () => ({
          cost: 200,
          suite: "pattern-integration",
          unit: "packages/patterns/one.test.ts",
        })),
        calibration: {
          setupCost: { toolshed: 60 },
          suites: {
            "pattern-integration": {
              overhead: 50,
              correction: 2,
              unitOverhead: 10,
            },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, {
        boundSeconds: 300,
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      expect(result.unschedulable.length).toBe(1);
      expect(result.unschedulable[0]!.cost).toBeCloseTo(520, 5);
      expect(result.unschedulable[0]!.suite).toBe("pattern-integration");
    });

    it("runs one anyway when the change touches it", () => {
      // Mandatory says the change is not tested without it. A lane that
      // runs long reports that it ran long; dropping the test reports a
      // pass over something that never ran, which is the worse answer.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 400 })),
      });
      const key = testIdentityKey(manifest.entries[0]!.test);
      const mandatory = new Map([[key, "changed" as const]]);
      const result = run(manifest, { mandatory, boundSeconds: 300 });
      expect(selected(result).map((s) => testIdentityKey(s.entry.test)))
        .toEqual([key]);
      // It is placed, so it is not among the ones nothing can run.
      expect(result.unschedulable).toEqual([]);
    });

    it("names a suite nothing can share a lane with, once", () => {
      // Every identity of the suite is past the bound by the same fixed
      // charge and by nothing about itself, so the suite is what there is
      // to say. Naming each of them instead is one line per test saying
      // what one line per suite already said, and it sends whoever reads
      // it to look at a test that costs a thousandth of the figure.
      const manifest = sampleManifest({
        entries: entries(40, () => ({ cost: 0.001 })),
        calibration: {
          setupCost: { fuse: 45 },
          suites: {
            "workspace-unit": { overhead: 400, correction: 1, unitOverhead: 1 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, {
        boundSeconds: 300,
        budgetSeconds: 230,
        capabilities: new Map([["workspace-unit", ["fuse"]]]),
      });
      expect(result.crowding).toEqual([{
        suite: "workspace-unit",
        fixed: 446,
        identities: 40,
        heldNowhere: 40,
      }]);
      expect(selected(result)).toEqual([]);
    });

    it("names a suite that can only be placed one test to a lane", () => {
      // Between the budget and the bound a lane may hold one of the
      // suite's identities and nothing else, which is a plan that spends
      // a whole lane on one test and says nothing about why.
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1 })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 250, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { boundSeconds: 300, budgetSeconds: 230 });
      expect(result.crowding).toEqual([{
        suite: "workspace-unit",
        fixed: 250,
        identities: 3,
        heldNowhere: 0,
      }]);
      // One per lane, and the plan ran out of lanes before tests.
      expect(result.lanes.map((lane) => lane.selections.length))
        .toEqual([1, 1, 1, 0, 0]);
    });

    it("leaves an identity held back for its own sake out of the count", () => {
      // The count says what the suite's charge costs. A withheld identity
      // and one its flake rate keeps out are not running whatever the
      // charge comes to, so counting them would report them as lost to
      // something that is not why they did not run.
      const all = entries(4, () => ({ cost: 1 }));
      all[0]!.flakeRate = 1;
      const manifest = sampleManifest({
        entries: all,
        withheld: [{
          test: all[1]!.test,
          suite: all[1]!.suite,
          reason: "flaky",
        }],
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 400, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { boundSeconds: 300, budgetSeconds: 230 });
      expect(result.crowding.map((suite) => suite.identities)).toEqual([2]);
    });

    it("counts only what a crowded suite can still run", () => {
      // A charge inside the bound leaves room for the cheaper of the
      // suite's tests and not the dearer, so some of it runs and some of
      // it does not. Reporting every identity as one a lane could run
      // would say the suite runs tests the list beside it names as tests
      // nothing ran.
      const manifest = sampleManifest({
        entries: [
          ...entries(2, () => ({ cost: 1 })),
          ...entries(1, () => ({ cost: 90 })),
        ].map((entry, i) => ({
          ...entry,
          test: { ...entry.test, n: `case ${i}` },
        })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 250, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { boundSeconds: 300, budgetSeconds: 230 });
      expect(result.crowding).toEqual([{
        suite: "workspace-unit",
        fixed: 250,
        identities: 3,
        heldNowhere: 1,
      }]);
      expect(crowdingLine(result.crowding[0]!))
        .toContain("each of the 2 tests it can still run");
      // The dear one is still named on its own, since what puts it past
      // the bound is its own time on top of the charge.
      expect(result.unschedulable.map((entry) => entry.test.n))
        .toEqual(["case 2"]);
    });

    it("says nothing about a suite a lane can fill around", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1 })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 10, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      expect(run(manifest, { boundSeconds: 300, budgetSeconds: 230 }).crowding)
        .toEqual([]);
    });

    it("leaves a suite the change forces in out of the count", () => {
      // Mandatory identities are placed whatever the charge, so they are
      // not what a crowded suite costs, and a suite with nothing else is
      // not crowding anything.
      const manifest = sampleManifest({
        entries: entries(2, () => ({ cost: 1 })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 400, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const mandatory = new Map(
        manifest.entries.map((
          entry,
        ) => [testIdentityKey(entry.test), "changed" as const]),
      );
      expect(run(manifest, { mandatory, boundSeconds: 300 }).crowding)
        .toEqual([]);
    });

    it("says how far past its budget forcing one put a lane", () => {
      // The lane running long is the whole signal that the bound may need
      // raising, so the figure has to come out even though nothing failed.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 400 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory, boundSeconds: 300 });
      expect(result.overBudgetSeconds).toBeGreaterThan(0);
    });
  });

  describe("the cost model", () => {
    it("charges a suite's overhead once per lane", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1 })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 10, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(13, 6);
    });

    it("charges a suite's per-unit overhead once per unit it opens", () => {
      const manifest = sampleManifest({
        entries: entries(3, (i) => ({
          cost: 1,
          unit: `packages/memory/test/${i}.test.ts`,
        })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 0, correction: 1, unitOverhead: 5 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(18, 6);
    });

    it("charges a suite's per-unit overhead once for a shared unit", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({
          cost: 1,
          unit: "packages/memory/test/one.test.ts",
        })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 0, correction: 1, unitOverhead: 5 },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(8, 6);
    });

    it("charges each suite for a unit path the two of them share", () => {
      // Two suites name the same path where they run the same file two
      // ways: the two postures of a pattern integration test, a package
      // built for two targets. Each is a runner started and a module
      // loaded of its own, so a lane holding both pays for both.
      const manifest = sampleManifest({
        entries: ["pattern-integration", "pattern-integration-opposite"].map(
          (suite) =>
            sampleEntry({
              k: "integration",
              s: "patterns",
              n: "poll",
              v: suite,
            }, {
              cost: 1,
              suite,
              unit: "packages/patterns/integration/all.test.ts",
            }),
        ),
        calibration: {
          setupCost: {},
          suites: {
            "pattern-integration": {
              overhead: 0,
              correction: 1,
              unitOverhead: 5,
            },
            "pattern-integration-opposite": {
              overhead: 0,
              correction: 1,
              unitOverhead: 5,
            },
          },
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(12, 6);
    });

    it("applies the suite's fitted correction to a measured cost", () => {
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 2 })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 0, correction: 1.5, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      expect(run(manifest, { lanes: 1 }).lanes[0]!.projectedSeconds)
        .toBeCloseTo(3, 6);
    });
  });

  describe("seededOrder()", () => {
    it("permutes every index exactly once", () => {
      const order = seededOrder("seed", 50);
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
    });

    it("gives the same order from the same seed", () => {
      expect(seededOrder("one", 30)).toEqual(seededOrder("one", 30));
    });

    it("gives a different order from a different seed", () => {
      expect(seededOrder("one", 30)).not.toEqual(seededOrder("two", 30));
    });

    it("handles a corpus of nothing", () => {
      expect(seededOrder("seed", 0)).toEqual([]);
    });
  });
});

describe("a unit its runner runs whole", () => {
  // A lane that picks any test in such a unit runs every test in it. The packer
  // places the unit as one choice, and the plan lists its tests.

  const HALF = "packages/ui#browser-test";
  const WHOLE = new Set([`workspace-unit\t${HALF}`]);

  /** Three tests of the browser half, and five ordinary ones beside it. */
  function corpus(fields: (i: number) => Partial<ManifestEntry> = () => ({})) {
    return sampleManifest({
      entries: [
        ...[0, 1, 2].map((i) =>
          sampleEntry({ k: "browser", s: "ui", n: `half ${i}` }, {
            unit: HALF,
            cost: 2,
            ...fields(i),
          })
        ),
        ...entries(5),
      ],
    });
  }

  function lanesHolding(result: ReturnType<typeof plan>, name: string) {
    return result.lanes.filter((lane) =>
      lane.selections.some((s) => s.entry.test.n === name)
    );
  }

  it("places every test of the unit in one lane, charged for all of them", () => {
    const result = run(corpus(), {
      wholeUnits: WHOLE,
      mandatory: new Map([
        [testIdentityKey({ k: "browser", s: "ui", n: "half 1" }), "changed"],
      ]),
    });
    const holding = lanesHolding(result, "half 0");
    expect(holding.length).toBe(1);
    const names = holding[0]!.selections.map((s) => s.entry.test.n);
    expect(names).toEqual(
      expect.arrayContaining(["half 0", "half 1", "half 2"]),
    );
    // The lane is charged for all three tests, six seconds in total.
    expect(holding[0]!.projectedSeconds).toBeGreaterThanOrEqual(6);
  });

  it("reports each test under its own reason, and the rest under the unit's", () => {
    // Two tests are mandatory for different reasons. The unit is placed
    // under the first, so the second keeping its own is what the plan
    // has to show, and the third takes the unit's.
    const result = run(corpus(), {
      wholeUnits: WHOLE,
      mandatory: new Map([
        [testIdentityKey({ k: "browser", s: "ui", n: "half 1" }), "changed"],
        [testIdentityKey({ k: "browser", s: "ui", n: "half 0" }), "unknown"],
      ]),
    });
    const reasons = new Map(
      selected(result).map((s) => [s.entry.test.n, s.reason]),
    );
    expect(reasons.get("half 1")).toBe("changed");
    expect(reasons.get("half 0")).toBe("unknown");
    expect(reasons.get("half 2")).toBe("changed");
  });

  it("dates a unit's last run by its least-run test", () => {
    // The exploration pass draws the longest-unrun entries first, and a
    // unit is as unrun as its least-run test.
    const merged = (days: (string | undefined)[]) =>
      foldWholeUnits(
        sampleManifest({
          entries: days.map((day, i) =>
            sampleEntry({ k: "browser", s: "ui", n: `half ${i}` }, {
              unit: HALF,
              ...(day === undefined ? {} : { lastRun: day }),
            })
          ),
        }),
        WHOLE,
      ).entries[0]!;
    expect(merged(["2026-08-01", "2026-07-01"]).lastRun).toBe("2026-07-01");
    expect(merged(["2026-08-01", undefined]).lastRun).toBeUndefined();
  });

  it("refuses a corpus already holding the name a merged unit takes", () => {
    const manifest = corpus();
    manifest.entries.push(
      sampleEntry({
        k: "browser",
        s: "ui",
        n: `whole workspace-unit ${HALF}`,
      }, { unit: "packages/ui/test/other.test.ts" }),
    );
    expect(() => foldWholeUnits(manifest, WHOLE)).toThrow(
      "another entry in the corpus already has",
    );
  });

  it("names only the tests in the plan, never the unit", () => {
    const result = run(corpus(), { wholeUnits: WHOLE, policy: "everything" });
    const names = selected(result).map((s) => s.entry.test.n);
    expect(names.filter((name) => name.startsWith("half")).sort()).toEqual([
      "half 0",
      "half 1",
      "half 2",
    ]);
    expect(names.some((name) => name.startsWith("whole "))).toBe(false);
  });

  it("holds the unit back with a test in it the manifest withholds", () => {
    const manifest = corpus();
    manifest.withheld = [{
      test: { k: "browser", s: "ui", n: "half 2" },
      suite: "workspace-unit",
      reason: "flaky",
    }];
    const result = run(manifest, { wholeUnits: WHOLE });
    expect(lanesHolding(result, "half 0")).toEqual([]);
    expect(lanesHolding(result, "half 2")).toEqual([]);
  });

  it("excuses a flaky test in the unit on a full run under its own name", () => {
    // A failing record is matched by the name it carries, which is the test's
    // name. The excused list therefore has to name the test.
    const manifest = corpus((i) => (i === 2 ? { flakeRate: 0.5 } : {}));
    manifest.withheld = [{
      test: { k: "browser", s: "ui", n: "half 2" },
      suite: "workspace-unit",
      reason: "flaky",
    }];
    const result = run(manifest, { wholeUnits: WHOLE, policy: "everything" });
    expect(result.nonGating.map((held) => held.test.n)).toEqual(["half 2"]);
  });

  it("reports every test of the unit as a full run's on a full run", () => {
    const result = run(corpus(), {
      wholeUnits: WHOLE,
      policy: "everything",
      mandatory: new Map([
        [testIdentityKey({ k: "browser", s: "ui", n: "half 1" }), "changed"],
      ]),
    });
    const reasons = selected(result)
      .filter((s) => s.entry.test.n.startsWith("half"))
      .map((s) => s.reason);
    expect(reasons).toEqual(["full", "full", "full"]);
  });

  it("runs a test the manifest carries twice once", () => {
    const manifest = corpus();
    manifest.entries.push({ ...manifest.entries[0]! });
    const result = run(manifest, { wholeUnits: WHOLE, policy: "everything" });
    expect(
      selected(result).filter((s) => s.entry.test.n === "half 0").length,
    ).toBe(1);
  });

  it("keeps two suites' units of one name apart", () => {
    // Both units are whole, and their tests share a kind and a scope. Each
    // merged entry has to be named for its suite as well as its unit, so that
    // the two keys differ and both units are placed.
    const other = [0, 1].map((i) =>
      sampleEntry({ k: "browser", s: "ui", n: `other ${i}` }, {
        suite: "pattern-integration",
        unit: HALF,
      })
    );
    const manifest = corpus();
    manifest.entries.push(...other);
    const result = run(manifest, {
      wholeUnits: new Set([...WHOLE, `pattern-integration\t${HALF}`]),
      policy: "everything",
    });
    const names = selected(result).map((s) => s.entry.test.n);
    expect(names).toEqual(
      expect.arrayContaining(["half 0", "half 2", "other 0", "other 1"]),
    );
  });

  it("leaves a unit holding one test as that test", () => {
    const only = sampleEntry({ k: "browser", s: "ui", n: "alone" }, {
      unit: HALF,
      cost: 2,
      score: 0.25,
    });
    const result = run(sampleManifest({ entries: [only, ...entries(5)] }), {
      wholeUnits: WHOLE,
      policy: "everything",
    });
    expect(selected(result).find((s) => s.entry.test.n === "alone")!.entry)
      .toBe(only);
  });
});

describe("an identity a manifest carries twice", () => {
  it("runs it once, rather than placing it in two lanes", () => {
    // A duplicated entry is one identity however many rows describe it,
    // and running it twice would charge a lane for work it did not do.
    const twice = sampleEntry({ k: "unit", s: "memory", n: "case 0" }, {
      unit: "packages/memory/test/case-0.test.ts",
    });
    const manifest = sampleManifest({
      entries: [...entries(3), twice],
    });
    const key = testIdentityKey(twice.test);
    const placed = keysOf(run(manifest)).filter((k) => k === key);
    expect(placed.length).toBe(1);
  });

  it("places it as the last of its rows, whatever the first one scores", () => {
    // The value pass orders by score, so a first row scoring far above
    // the last would be the one it reached, where the density pass would
    // reach the last.

    const first = sampleEntry({ k: "unit", s: "memory", n: "case 0" }, {
      unit: "packages/memory/test/case-0.test.ts",
      score: 0.9,
    });
    const last = { ...first, score: 0.01 };
    const placed = selected(
      run(sampleManifest({ entries: [first, ...entries(3).slice(1), last] })),
    ).filter((s) => s.entry.test.n === "case 0");
    expect(placed.length).toBe(1);
    expect(placed[0]!.entry).toBe(last);
  });
});

describe("an identity the manifest does not carry", () => {
  it("refuses to plan, rather than dropping a test that must run", () => {
    // Whoever read the tree carries a stand-in for every unit it holds,
    // so this is the caller naming something mandatory and handing over
    // a corpus without it. Leaving it out would report a pass over a
    // test that never ran, which is the failure with no trace.
    const key = '["unit","memory","brand new"]';
    expect(() =>
      run(sampleManifest({ entries: entries(3) }), {
        mandatory: new Map([[key, "changed" as const]]),
      })
    ).toThrow("must run");
  });
});

describe("running everything", () => {
  /** A manifest whose entries differ in every way selection reads. */
  function corpus(): Manifest {
    return sampleManifest({
      entries: [
        ...entries(6, (i) => ({ cost: 1 + i, score: 0.9 - i / 10 })),
        sampleEntry({ k: "unit", s: "memory", n: "flaky" }, {
          unit: "packages/memory/test/flaky.test.ts",
          flakeRate: 0.9,
          cost: 2,
        }),
        sampleEntry({ k: "unit", s: "memory", n: "worthless" }, {
          unit: "packages/memory/test/worthless.test.ts",
          score: 0,
          cost: 2,
        }),
      ],
      withheld: [
        {
          test: { k: "unit", s: "memory", n: "worthless" },
          suite: "workspace-unit",
          reason: "flaky",
        },
        {
          test: { k: "unit", s: "memory", n: "case 0" },
          suite: "workspace-unit",
          // A reason nothing gives today. What a flake rate excuses is
          // narrower than what a pull request holds back, and a corpus
          // whose every entry is flaky cannot tell the two apart.
          reason: "quarantined" as WithheldReason,
        },
      ],
    });
  }

  it("runs every identity once, whatever it is worth", () => {
    const result = run(corpus(), { policy: "everything" });
    expect(keysOf(result)).toEqual(
      corpus().entries.map((entry) => testIdentityKey(entry.test)).sort(),
    );
    expect(selected(result).every((s) => s.repeats === 1)).toBe(true);
    expect(selected(result).every((s) => s.reason === "full")).toBe(true);
  });

  it("says it withheld nothing, because it ran everything", () => {
    expect(run(corpus()).withheld).toEqual(corpus().withheld);
    expect(run(corpus(), { policy: "everything" }).withheld).toEqual([]);
  });

  it("says what it will not fail for, and a pull request says nothing", () => {
    // A test too noisy to judge a change by is held back from a pull
    // request and run here anyway: what this run learns about it is the
    // whole of what says whether the exclusion should reverse. Failing
    // for it would make the branch red for something no change caused.
    //
    // The reason decides, not membership of the withheld set: an entry
    // held back for anything else runs here and goes on failing the run,
    // so a reason added later is not excused by nobody's decision.
    const flaky = corpus().withheld.filter((held) => held.reason === "flaky");
    expect(flaky.length).toBeLessThan(corpus().withheld.length);
    expect(run(corpus(), { policy: "everything" }).nonGating).toEqual(flaky);
    expect(run(corpus()).nonGating).toEqual([]);
    // And a pull request holds back everything the manifest names,
    // whatever the reason.
    expect(run(corpus()).withheld).toEqual(corpus().withheld);
  });

  it("gives a withheld identity the runs its own share asks for", () => {
    // What a flake share asks for is read off the entry, and being
    // withheld does not reduce it: these runs are the whole of what
    // lets an excluded test's share rise again, so a plan placing such
    // an identity once would leave the exclusion where it is for good.
    const held = testIdentityKey({ k: "unit", s: "memory", n: "worthless" });
    const manifest = sampleManifest({
      entries: corpus().entries.map((entry) =>
        testIdentityKey(entry.test) === held ? { ...entry, repeats: 4 } : entry
      ),
      withheld: corpus().withheld,
    });
    const placed = selected(run(manifest, { policy: "everything" }));
    const runs = new Map(
      placed.map((s) => [testIdentityKey(s.entry.test), s.repeats]),
    );
    expect(runs.get(held)).toBe(4);
    expect([...runs].filter(([key]) => key !== held).every(([, n]) => n === 1))
      .toBe(true);
  });

  it("runs what a budgeted plan withholds and excludes", () => {
    const budgeted = keysOf(run(corpus()));
    const flaky = testIdentityKey({ k: "unit", s: "memory", n: "flaky" });
    const red = testIdentityKey({ k: "unit", s: "memory", n: "worthless" });
    expect(budgeted).not.toContain(flaky);
    expect(budgeted).not.toContain(red);
    const full = keysOf(run(corpus(), { policy: "everything" }));
    expect(full).toContain(flaky);
    expect(full).toContain(red);
  });

  it("reports nothing unschedulable, since it places everything", () => {
    const manifest = sampleManifest({
      entries: entries(2, () => ({ cost: 5_000 })),
    });
    expect(run(manifest).unschedulable.length).toBe(2);
    const full = run(manifest, { policy: "everything" });
    expect(full.unschedulable).toEqual([]);
    expect(keysOf(full).length).toBe(2);
  });

  it("takes the full run's budget rather than a pull request's", () => {
    // Work that fits one lane of the full run and does not fit one of a
    // pull request's, which is the whole gap between the two dials.
    const manifest = sampleManifest({
      entries: entries(FULL_LANE_BUDGET_SECONDS, () => ({ cost: 1 })),
    });
    const full = run(manifest, { policy: "everything", lanes: 1 });
    expect(full.budgetSeconds).toBe(FULL_LANE_BUDGET_SECONDS);
    expect(full.overBudgetSeconds).toBe(0);
    const budgeted = run(manifest, {
      policy: "everything",
      lanes: 1,
      budgetSeconds: LANE_BUDGET_SECONDS,
    });
    expect(budgeted.overBudgetSeconds).toBeGreaterThan(0);
  });

  it("places every identity, however awkward the corpus", () => {
    // A corpus mixing tests that fit easily, tests larger than a lane,
    // and tests a budgeted plan would exclude. None of it may go
    // missing: what `main` does not run, nothing runs.
    const manifest = sampleManifest({
      entries: [
        ...entries(40, (i) => ({ cost: i % 7 === 0 ? 5_000 : i / 10 })),
        sampleEntry({ k: "unit", s: "memory", n: "flaky" }, {
          unit: "packages/memory/test/flaky.test.ts",
          flakeRate: 1,
        }),
      ],
    });
    for (const lanes of [1, 2, 5, 13]) {
      const result = run(manifest, { policy: "everything", lanes });
      expect(keysOf(result).length).toBe(manifest.entries.length);
      expect(new Set(keysOf(result)).size).toBe(manifest.entries.length);
    }
  });

  it("gives the same answer every time it is asked", () => {
    const once = run(corpus(), { policy: "everything" });
    const twice = run(corpus(), { policy: "everything" });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("how many lanes the full run needs", () => {
  const capabilities = NO_CAPABILITIES;

  function count(manifest: Manifest, overrides: Partial<PlanInput> = {}) {
    return fullLaneCount({
      manifest,
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      ...overrides,
    });
  }

  it("takes one lane for work that fits in one", () => {
    expect(count(sampleManifest({ entries: entries(5, () => ({ cost: 1 })) })))
      .toBe(1);
  });

  it("takes enough lanes that none of them runs long", () => {
    // Three lanes' worth of work, in tests small enough that the packer
    // can divide them evenly.
    const manifest = sampleManifest({
      entries: entries(FULL_LANE_BUDGET_SECONDS * 3, () => ({ cost: 1 })),
    });
    const lanes = count(manifest);
    expect(lanes).toBe(3);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      policy: "everything",
      lanes,
    });
    expect(packed.overBudgetSeconds).toBe(0);
  });

  it("honors a budget it was handed", () => {
    const manifest = sampleManifest({
      entries: entries(600, () => ({ cost: 1 })),
    });
    expect(count(manifest, { budgetSeconds: 100 })).toBe(6);
  });

  it("drops lanes the repeat count over-estimated, and keeps an overrun", () => {
    // The starting figure charges every execution the packer was asked
    // for, and the packer gives up runs rather than putting a lane past
    // its bound, so it can land above the fewest lanes that hold the
    // run. A search that only climbed would keep whatever it overshot
    // by, which costs the default branch a job per commit for each lane.
    //
    // The identity costing more than a whole lane is what makes this
    // worth measuring against the overrun rather than against zero: its
    // overrun is there at every count, so a shrink that waited for zero
    // would never run.
    const manifest = sampleManifest({
      entries: [
        ...entries(20, () => ({ cost: 1, repeats: 10 })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: 4_000,
        }),
      ],
    });
    const lanes = count(manifest, { budgetSeconds: 100 });
    // Every execution asked for comes to 200 seconds beside the one
    // vast test, which the estimate divides into far more lanes than
    // the packing needs.
    const estimate = Math.ceil(
      manifest.entries.reduce((t, e) => t + e.cost * e.repeats, 0) / 100,
    );
    expect(estimate).toBeGreaterThan(lanes);
    // And what it settled on is a packing no smaller count matches.
    const overrunAt = (count: number) =>
      plan({
        manifest,
        mandatory: new Map(),
        capabilities,
        wholeUnits: NO_WHOLE_UNITS,
        policy: "everything",
        budgetSeconds: 100,
        lanes: count,
      }).lanes.reduce((t, l) => t + Math.max(0, l.projectedSeconds - 100), 0);
    expect(overrunAt(lanes - 1)).toBeGreaterThanOrEqual(overrunAt(lanes) + 1);
  });

  it("adds lanes while each one still buys something", () => {
    // The fewest lanes the raw work could fit in is not enough lanes,
    // because a lane loses part of its budget to the overhead of the
    // suite it opens. The search has to climb past that starting point,
    // and this is the case that makes it: three lanes hold 1,440
    // seconds of tests only if their overheads are free, and they are
    // not.
    const manifest = sampleManifest({
      entries: entries(24, () => ({ cost: 60 })),
      calibration: {
        setupCost: {},
        suites: {
          "workspace-unit": { overhead: 150, correction: 1, unitOverhead: 0 },
        },
        prologue: 0,
      },
    });
    const work = manifest.entries.reduce((total, e) => total + e.cost, 0);
    const floor = Math.ceil(work / FULL_LANE_BUDGET_SECONDS);
    const lanes = count(manifest);
    expect(lanes).toBeGreaterThan(floor);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      policy: "everything",
      lanes,
    });
    expect(packed.overBudgetSeconds).toBe(0);
  });

  it("stops rather than chasing work no number of lanes can fit", () => {
    // The search has to reach its stopping rule to be tested by this, so
    // the corpus has to be one where lanes are still worth adding for a
    // while and then stop being. A single oversized identity would cap
    // the search at one lane before the loop ran at all, and the case
    // would pass with the rule deleted.
    const manifest = sampleManifest({
      entries: [
        ...entries(20, () => ({ cost: 100 })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: FULL_LANE_BUDGET_SECONDS * 3,
        }),
      ],
    });
    const lanes = count(manifest);
    // Adding lanes past this buys nothing, because what is left over
    // budget is one identity no lane can hold.
    const at = (n: number) =>
      plan({
        manifest,
        mandatory: new Map(),
        capabilities,
        wholeUnits: NO_WHOLE_UNITS,
        policy: "everything",
        lanes: n,
      });
    const overrun = (result: ReturnType<typeof plan>) =>
      result.lanes.reduce(
        (total, lane) =>
          total + Math.max(0, lane.projectedSeconds - result.budgetSeconds),
        0,
      );
    expect(overrun(at(lanes))).toBeGreaterThan(0);
    expect(overrun(at(lanes + 1))).toBeGreaterThan(overrun(at(lanes)) - 1);
    // And it did reach the rule rather than stopping at the cap.
    expect(lanes).toBeGreaterThan(1);
    expect(lanes).toBeLessThan(manifest.entries.length);
  });

  it("keeps adding lanes for work one oversized test would hide", () => {
    // The oversized test pins the worst lane's overrun at every count,
    // so a search reading the worst lane alone would stop at once and
    // leave every other lane crowded. What the rest of the corpus needs
    // is what decides the count.
    const manifest = sampleManifest({
      entries: [
        ...entries(40, () => ({ cost: 100 })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: 900,
        }),
      ],
    });
    const lanes = count(manifest);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      policy: "everything",
      lanes,
    });
    // Every lane but the one carrying the oversized test fits its
    // budget, and that one carries nothing else.
    const over = packed.lanes.filter((lane) =>
      lane.projectedSeconds > packed.budgetSeconds
    );
    expect(over.length).toBe(1);
    expect(over[0]!.selections.length).toBe(1);
  });

  it("takes one lane for a corpus of nothing", () => {
    expect(count(sampleManifest({ entries: [] }))).toBe(1);
  });
});
