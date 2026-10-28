import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { testIdentityKey } from "@commonfabric/test-support/records";

import {
  aroundIn,
  crowdingLine,
  fixedCharges,
  foldWholeUnits,
  type GateChoice,
  laneCount,
  placedOnlyMandatory,
  plan,
  type PlanInput,
  seededOrder,
  type Selection,
  type SelectionReason,
  suiteCharge,
  suiteLoad,
  testsOf,
} from "./plan.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import type { WithheldReason } from "@commonfabric/test-support/records";
import { sampleEntry, sampleManifest } from "./testing.ts";
import {
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BUDGET_SECONDS,
} from "./policy.ts";

const NO_CAPABILITIES = new Map<string, readonly string[]>();
const NO_WHOLE_UNITS: ReadonlySet<string> = new Set();

/** How many lanes the plans below are packed into unless they say. */
const LANES = 5;

/**
 * What the plans below give the passes choosing by score unless they say:
 * all of their lanes' budgets, so that what limits those passes is the
 * lanes and their shares rather than the target.
 */
const ROOM = LANES * LANE_BUDGET_SECONDS;

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
    lanes: LANES,
    discretionarySeconds: ROOM,
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

    it("says whether the mandatory set left room for anything else", () => {
      const manifest = sampleManifest({
        entries: entries(5, () => ({ cost: 10 })),
      });
      const key = testIdentityKey(manifest.entries[0]!.test);
      const mandatory = new Map([[key, "changed" as const]]);
      const roomy = run(manifest, { mandatory, budgetSeconds: 230 });
      expect(selected(roomy).some((s) => s.reason !== "changed")).toBe(true);
      expect(placedOnlyMandatory(roomy)).toBe(false);
      const full = run(manifest, { mandatory, budgetSeconds: 10, lanes: 1 });
      expect(selected(full).map((s) => s.reason)).toEqual(["changed"]);
      expect(placedOnlyMandatory(full)).toBe(true);
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

    it("breaks a tie in value by the identity key, not by position", () => {
      // Two tests of one score, and room in the value pass's share for
      // one of them: the same one is taken for value however the
      // manifest lists the two, and no later pass has room for the other.
      const tied = entries(2, () => ({ cost: 15, score: 0.5 }));
      const reasons = (listed: ManifestEntry[]) =>
        selected(run(sampleManifest({ entries: listed }), {
          budgetSeconds: 26,
          lanes: 1,
        })).map((s) => [s.entry.test.n, s.reason]);
      const inOrder = reasons(tied);
      expect(inOrder).toEqual([["case 0", "value"]]);
      expect(reasons([...tied].reverse())).toEqual(inOrder);
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
        "pattern-unit": { overhead: 0, correction: 0.8, unitOverhead: 0 },
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

    it("moves a leaf up once its lane runs the `describe` around it", () => {
      // Every candidate is in the opened file. The two leaves sit inside a
      // `describe` whose hooks take eight seconds and which no lane is
      // given. The first leaf costs the lane nine, for itself and the
      // hooks, and is worth enough to go ahead of the strangers at four.
      // Once it is in, the second costs one, which is denser than any
      // stranger. That leaves room for three of the four strangers.
      const leaf = (name: string, score: number) =>
        test(`hooks > ${name}`, "open.test.ts", { score });
      const strangers = [1, 2, 3, 4].map((i) =>
        test(`stranger ${i}`, "open.test.ts", { cost: 4 })
      );
      const chosen = reasons(packed([
        test("hooks", "open.test.ts", { cost: 8, flakeRate: 0.5 }),
        leaf("first", 0.12),
        leaf("second", 0.05),
        ...strangers,
      ]));
      expect(chosen.get("hooks > first")).toBe("density");
      expect(chosen.get("hooks > second")).toBe("density");
      expect(
        strangers.filter((s) => chosen.get(s.test.n) === "density").length,
      ).toBe(3);
    });

    it("moves a leaf up as its lane's share of the suite grows, by what the `describe` around it adds", () => {
      // The pattern unit suite runs its tests side by side, and its lane is
      // charged the 100 seconds its longest unit takes. The leaf takes one
      // second of its own and 45 with the hooks of the `describe` around
      // it, and costs the lane 16; the stranger takes 50 and costs 20. The
      // test growing the longest unit to 150 is the densest there is, and
      // once it is in, the leaf costs 6 and the stranger 10. There is room
      // left for one of the two, and the leaf is now the denser.
      const pattern = (
        name: string,
        unit: string,
        fields: Partial<ManifestEntry>,
      ) => test(name, `${unit}.test.tsx`, { suite: "pattern-unit", ...fields });
      const longest = pattern("longest", "longest", { cost: 100 });
      const chosen = reasons(run(
        sampleManifest({
          entries: [
            longest,
            test("proven", "proven.test.ts", { cost: 135.4, score: 0.9 }),
            pattern("grows", "longest", { cost: 50, score: 0.5 }),
            pattern("hooks", "hooks", { cost: 44, flakeRate: 0.5 }),
            pattern("hooks > runs a leaf", "hooks", { score: 0.06 }),
            pattern("stranger", "stranger", { cost: 50, score: 0.06 }),
          ],
          calibration: perFile,
        }),
        {
          lanes: 1,
          budgetSeconds: 344,
          mandatory: new Map([[
            testIdentityKey(longest.test),
            "changed" as const,
          ]]),
        },
      ));
      expect(chosen.get("grows")).toBe("density");
      expect(chosen.get("hooks > runs a leaf")).toBe("density");
      expect(chosen.get("stranger")).not.toBe("density");
    });

    it("moves a suite's shorter tests up once its lane holds a longer one", () => {
      // The pattern unit suite runs its tests side by side. A mandatory
      // test puts it in the lane, so taking the long test opens nothing
      // but its own file. The long test is the densest there is, and
      // costs the lane 13.9 of the 25.4 seconds the density pass has. The
      // short test alone would cost nine, and the stranger costs eight,
      // so the stranger is denser to start with. Once the long test is
      // in, the short one's own time fits under it and it costs 4.48,
      // which is denser than the stranger. There is room for one of the
      // two.
      const pattern = (name: string, cost: number, score = 0.05) =>
        test(name, `${name}.test.tsx`, { suite: "pattern-unit", cost, score });
      const tiny = pattern("tiny", 0.1);
      const chosen = reasons(packed(
        [
          tiny,
          pattern("long", 14, 0.5),
          pattern("short", 9),
          test("stranger", "open.test.ts", { cost: 8 }),
        ],
        {
          mandatory: new Map([
            ...opened,
            [testIdentityKey(tiny.test), "changed" as const],
          ]),
        },
      ));
      expect(chosen.get("long")).toBe("density");
      expect(chosen.get("short")).toBe("density");
      expect(chosen.get("stranger")).not.toBe("density");
    });

    it("moves a long test of a suite up as its lane's share of the suite grows", () => {
      // The long test's own time is more than the suite's loads in the
      // lane come to, so it is charged what its own time adds past them,
      // and that falls with every short test the lane takes. The three
      // short tests are the densest there are. After them the long test
      // costs 16 seconds, and is denser than the stranger at 7.5; after
      // only the first, it cost 18 and was not. The density pass has 20.6
      // seconds left, which holds one of the two.
      const pattern = (name: string, cost: number, score = 0.05) =>
        test(name, `${name}.test.tsx`, { suite: "pattern-unit", cost, score });
      const tiny = pattern("tiny", 0.1);
      const chosen = reasons(packed(
        [
          tiny,
          pattern("short 1", 2, 0.5),
          pattern("short 2", 2, 0.5),
          pattern("short 3", 2, 0.5),
          pattern("long", 20, 0.115),
          test("stranger", "open.test.ts", { cost: 7.5 }),
        ],
        {
          mandatory: new Map([
            ...opened,
            [testIdentityKey(tiny.test), "changed" as const],
          ]),
        },
      ));
      expect(chosen.get("short 3")).toBe("density");
      expect(chosen.get("long")).toBe("density");
      expect(chosen.get("stranger")).not.toBe("density");
    });

    it("moves a suite's long tests up once its longest unit sets the lane's charge", () => {
      // One lane of 24 seconds, and a suite running its units side by side
      // at a correction of a quarter. The value pass takes the files of
      // 10, 5 and 11 seconds, so the lane is charged the 11 its longest
      // unit takes. The density pass then takes the 18-second file for
      // 7 seconds, and the lane is charged 18. That leaves the 19-second
      // file costing 1 and the 20-second file costing 2, where before
      // they cost 8 and 9, and there is room for one of the two: the
      // 19-second one, which is now the denser.
      const file = (name: string, cost: number, score: number) =>
        sampleEntry({ k: "pattern", s: "patterns", n: name }, {
          suite: "pattern-unit",
          unit: `${name}.test.tsx`,
          cost,
          score,
        });
      const manifest = sampleManifest({
        entries: [
          file("ten", 10, 0.131),
          file("twenty", 20, 0.115),
          file("five", 5, 0.118),
          file("nineteen", 19, 0.075),
          file("eighteen", 18, 0.097),
          file("eleven", 11, 0.11),
        ],
        calibration: {
          setupCost: {},
          suites: {
            "pattern-unit": { overhead: 0, correction: 0.25, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const chosen = reasons(run(manifest, { lanes: 1, budgetSeconds: 24 }));
      expect(chosen.get("eighteen")).toBe("density");
      expect(chosen.get("nineteen")).toBe("density");
      expect(chosen.get("twenty")).not.toBe("density");
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
      // which the identity key decides. The exploration draw is seeded by
      // the manifest, and permutes what is left in an order that is the
      // same however the manifest lists it. A unit run whole, of three
      // tests, adds up the same costs in the same order and lists its
      // tests the same way.
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
        ...[0.1, 0.2, 0.3].map((cost, i) =>
          test(`part ${i}`, "whole.test.ts", {
            cost,
            inputs: {
              catches: 2,
              sources: 2,
              churn: 1,
              lastCatch: "2026-08-19",
            },
          })
        ),
      ];
      const chosen = (entries: ManifestEntry[]) =>
        run(sampleManifest({ entries, calibration: perFile }), {
          lanes: 3,
          budgetSeconds: 100,
          mandatory: opened,
          wholeUnits: new Set(["workspace-unit\twhole.test.ts"]),
        }).lanes.map((lane) => ({
          seconds: lane.projectedSeconds,
          selections: lane.selections.map((s) => [s.entry.test.n, s.reason]),
        }));
      const inOrder = chosen(corpus);
      const selections = inOrder.flatMap((lane) => lane.selections);
      const taken = (reason: string) =>
        selections.filter(([, why]) => why === reason).length;
      expect(taken("density")).toBeGreaterThan(10);
      expect(taken("exploration")).toBeGreaterThan(0);
      expect(
        selections.map(([name]) => name).filter((name) =>
          name!.startsWith("part ")
        ),
      ).toEqual(["part 0", "part 1", "part 2"]);
      expect(chosen([...corpus].reverse())).toEqual(inOrder);
      expect(
        chosen(seededOrder("shuffle", corpus.length).map((i) => corpus[i]!)),
      ).toEqual(inOrder);
    });
  });

  describe("gates", () => {
    /** A gate judging `members`, scoring `score`. */
    function gateOver(
      members: readonly ManifestEntry[],
      score: number,
      fields: Partial<GateChoice> = {},
    ): GateChoice {
      return {
        entry: sampleEntry(
          { k: "gate", s: "memory", n: "coverage-gate workspace-unit" },
          {
            suite: "coverage-gate",
            unit: "workspace-unit/packages/memory",
            score,
          },
        ),
        judges: "workspace-unit",
        members: members.map((entry) => testIdentityKey(entry.test)),
        reached: true,
        ...fields,
      };
    }

    /** What the plan put in lanes for the gate it chose. */
    function forGate(result: ReturnType<typeof plan>): Selection[] {
      return selected(result).filter((s) => s.reason === "coverage-gate");
    }

    it("chooses a gate the change reaches by its score, running all it judges", () => {
      // Thirty units of twenty seconds are more than one lane holds, so
      // choosing the gate spreads what it runs over several lanes.
      const members = entries(30, () => ({ cost: 20 }));
      const gate = gateOver(members, 0.9);
      const result = run(sampleManifest({ entries: members }), {
        gates: [gate],
      });
      expect(result.gates.map((s) => [s.entry.test.n, s.reason])).toEqual([[
        "coverage-gate workspace-unit",
        "value",
      ]]);
      expect(forGate(result).map((s) => testIdentityKey(s.entry.test)).sort())
        .toEqual([...gate.members].sort());
      const holding = result.lanes.filter((lane) =>
        lane.selections.some((s) => s.reason === "coverage-gate")
      );
      expect(holding.length).toBeGreaterThan(1);
      for (const lane of result.lanes) {
        expect(lane.projectedSeconds).toBeLessThanOrEqual(LANE_BUDGET_SECONDS);
      }
      expect(placedOnlyMandatory(result)).toBe(false);
    });

    it("charges a gate what running what it judges adds to the lanes", () => {
      const members = entries(30, () => ({ cost: 20 }));
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9)],
      });
      const projected = result.lanes.reduce(
        (total, lane) => total + lane.projectedSeconds,
        0,
      );
      expect(projected).toBeCloseTo(600);
    });

    it("never chooses a gate the change does not reach", () => {
      const members = entries(30, () => ({ cost: 20 }));
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9, { reached: false })],
      });
      expect(result.gates).toEqual([]);
      expect(forGate(result)).toEqual([]);
    });

    it("chooses no gate whose whole set no run can hold", () => {
      // Sixty-five units of twenty seconds are past the five lanes of the
      // run together, so no share of it holds them, and nothing of the set
      // is placed for the gate's sake.
      const members = entries(65, () => ({ cost: 20 }));
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9)],
      });
      expect(result.gates).toEqual([]);
      expect(forGate(result)).toEqual([]);
    });

    it("chooses no gate one of whose tests fits in no lane", () => {
      const members = [
        ...entries(3, () => ({ cost: 20 })),
        sampleEntry({ k: "unit", s: "memory", n: "too long" }, {
          unit: "packages/memory/test/too-long.test.ts",
          cost: LANE_BUDGET_SECONDS * 2,
        }),
      ];
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9)],
      });
      expect(result.gates).toEqual([]);
      expect(forGate(result)).toEqual([]);
    });

    it("weighs a gate against tests by score in the value pass", () => {
      // The value pass holds six hundred and ninety seconds. The test
      // scoring above the gate goes first, the gate fits after it, and the
      // test scoring below the gate no longer fits.
      const members = entries(30, () => ({ cost: 20 }));
      const above = sampleEntry({ k: "unit", s: "cellar", n: "above" }, {
        unit: "packages/cellar/above.test.ts",
        cost: 50,
        score: 0.95,
      });
      const below = sampleEntry({ k: "unit", s: "cellar", n: "below" }, {
        unit: "packages/cellar/below.test.ts",
        cost: 100,
        score: 0.8,
      });
      const result = run(
        sampleManifest({ entries: [...members, above, below] }),
        { gates: [gateOver(members, 0.9)] },
      );
      expect(result.gates.map((s) => s.reason)).toEqual(["value"]);
      const reasonOf = (name: string) =>
        selected(result).find((s) => s.entry.test.n === name)?.reason;
      expect(reasonOf("above")).toBe("value");
      expect(reasonOf("below")).not.toBe("value");
    });

    it("chooses a gate in the density pass where the value pass had no room", () => {
      // Three tests scoring above the gate take six hundred and seventy-five
      // of the value pass's six hundred and ninety seconds, which leaves no
      // room for the gate's three hundred, nor for any one of its tests.
      // The density pass's share holds the gate, which is denser than any
      // one of the tests it runs.
      const members = entries(15, () => ({ cost: 20 }));
      const above = ["first", "second", "third"].map((name, at) =>
        sampleEntry({ k: "unit", s: "cellar", n: name }, {
          unit: `packages/cellar/${name}.test.ts`,
          cost: 225,
          score: 0.99 - at / 100,
        })
      );
      const result = run(
        sampleManifest({ entries: [...members, ...above] }),
        { gates: [gateOver(members, 0.9)] },
      );
      expect(result.gates.map((s) => s.reason)).toEqual(["density"]);
      expect(forGate(result)).toHaveLength(15);
    });

    it("chooses at no cost a gate whose whole set is already placed", () => {
      // The tests a gate judges each ran for some other reason, so the
      // verdict over them takes nothing more.
      const members = entries(3);
      const result = run(sampleManifest({ entries: members }), {
        mandatory: everything(sampleManifest({ entries: members })),
        gates: [gateOver(members, 0.05)],
      });
      expect(result.gates.map((s) => s.reason)).toEqual(["value"]);
      expect(forGate(result)).toEqual([]);
    });

    it("counts a test already placed as part of the gate's set", () => {
      // A test the change made mandatory runs whatever the gate does, so
      // choosing the gate places only the rest of the set.
      const members = entries(30, () => ({ cost: 20 }));
      const mandatory = new Map([[
        testIdentityKey(members[0]!.test),
        "changed" as const,
      ]]);
      const result = run(sampleManifest({ entries: members }), {
        mandatory,
        gates: [gateOver(members, 0.9)],
      });
      expect(result.gates).toHaveLength(1);
      expect(forGate(result)).toHaveLength(29);
      expect(
        selected(result).filter((s) => s.entry.test.n === "case 0")
          .map((s) => s.reason),
      ).toEqual(["changed"]);
    });

    it("keeps the repeats of an identity a gate runs", () => {
      // Measuring a set is not a reason to run one of its tests fewer
      // times than a lane that never measured it would have.
      const members = entries(3, () => ({ repeats: 3 }));
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9)],
      });
      expect(forGate(result).map((s) => s.repeats)).toEqual([3, 3, 3]);
    });

    it("runs a held-back test its gate judges, and does not fail for it", () => {
      // The set is measured whole, and the held-back test's failure says
      // nothing the change's author can act on.

      const members = entries(3);
      const held = {
        test: members[0]!.test,
        suite: "workspace-unit",
        reason: "flaky" as const,
      };
      const manifest = sampleManifest({
        entries: members.map((entry, at) =>
          at === 0 ? { ...entry, flakeRate: 0.5 } : entry
        ),
        withheld: [held],
      });
      const result = run(manifest, { gates: [gateOver(members, 0.9)] });
      expect(forGate(result)).toHaveLength(3);
      expect(result.nonGating).toEqual([held]);
      expect(run(manifest).nonGating).toEqual([]);
    });

    it("leaves no test a chosen gate ran among those held back with their unit", () => {
      const members = ["w0", "w1", "w2"].map((name) =>
        sampleEntry({ k: "unit", s: "memory", n: name }, {
          unit: "packages/memory/test/whole.test.ts",
        })
      );
      const manifest = sampleManifest({
        entries: members,
        withheld: [{
          test: members[0]!.test,
          suite: "workspace-unit",
          reason: "flaky",
        }],
      });
      const wholeUnits = new Set([
        "workspace-unit\tpackages/memory/test/whole.test.ts",
      ]);
      expect(run(manifest, { wholeUnits }).heldWithUnit).toHaveLength(2);
      expect(
        run(manifest, { wholeUnits, gates: [gateOver(members, 0.9)] })
          .heldWithUnit,
      ).toEqual([]);
    });

    it("gives up repeats of a gate's tests to fit the pass's share", () => {
      // Eight tests of thirty seconds run three times each take seven
      // hundred and twenty seconds, past the value pass's six hundred and
      // ninety; with some of them run fewer times, the whole set fits.
      const members = entries(8, () => ({ cost: 30, repeats: 3 }));
      const result = run(sampleManifest({ entries: members }), {
        gates: [gateOver(members, 0.9)],
      });
      expect(result.gates.map((s) => s.reason)).toEqual(["value"]);
      const repeats = forGate(result).map((s) => s.repeats);
      expect(repeats).toHaveLength(8);
      expect(repeats.some((count) => count < 3)).toBe(true);
    });

    it("lists the gates of the full policy in the order of their keys", () => {
      const members = entries(3);
      const named = (n: string, s: string) => ({
        ...gateOver(members, 0.05),
        entry: sampleEntry({ k: "gate", s, n }, {
          suite: "coverage-gate",
          unit: `workspace-unit/packages/${s}`,
        }),
      });
      const gates = [named("g", "memory"), named("g", "cellar")];
      const order = (given: GateChoice[]) =>
        run(sampleManifest({ entries: members }), {
          policy: "everything",
          gates: given,
        }).gates.map((s) => s.entry.test.s);
      expect(order(gates)).toEqual(["cellar", "memory"]);
      expect(order([...gates].reverse())).toEqual(["cellar", "memory"]);
    });

    it("says it placed nothing past the mandatory pass where a gate cost nothing", () => {
      // A gate whose whole set the change already runs places nothing, so a
      // plan that chose only such a gate is one the mandatory work crowded.

      const members = entries(3);
      const result = run(sampleManifest({ entries: members }), {
        mandatory: everything(sampleManifest({ entries: members })),
        gates: [gateOver(members, 0.9)],
        lanes: 1,
        budgetSeconds: 0.15,
      });
      expect(result.gates).toHaveLength(1);
      expect(placedOnlyMandatory(result)).toBe(true);
    });

    it("holds back a gate the manifest withholds", () => {
      const members = entries(3);
      const gate = gateOver(members, 0.9);
      const result = run(
        sampleManifest({
          entries: members,
          withheld: [{
            test: gate.entry.test,
            suite: "coverage-gate",
            reason: "flaky",
          }],
        }),
        { gates: [gate] },
      );
      expect(result.gates).toEqual([]);
    });

    it("places a gate's own entry in no lane", () => {
      const members = entries(3);
      const gate = gateOver(members, 0.9);
      const result = run(
        sampleManifest({ entries: [...members, gate.entry] }),
        { gates: [gate] },
      );
      expect(selected(result).some((s) => s.entry.suite === "coverage-gate"))
        .toBe(false);
      expect(result.gates).toHaveLength(1);
    });

    it("chooses every gate under the full policy, reached or not", () => {
      const members = entries(3);
      const result = run(sampleManifest({ entries: members }), {
        policy: "everything",
        gates: [gateOver(members, 0.05, { reached: false })],
      });
      expect(result.gates.map((s) => s.reason)).toEqual(["full"]);
      expect(selected(result).map((s) => s.reason)).toEqual([
        "full",
        "full",
        "full",
      ]);
    });

    it("refuses a gate that runs something the corpus does not carry", () => {
      const members = entries(3);
      expect(() =>
        run(sampleManifest({ entries: members.slice(1) }), {
          gates: [gateOver(members, 0.9)],
        })
      ).toThrow("does not carry it");
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

    it("projects a lane as its suites' charges and its capabilities' setup", () => {
      // A lane records each batch's charge beside what the batch spent,
      // so the charges have to add up to the lane's projection, or the
      // two records would describe different packings.
      const suites = ["workspace-unit", "runner-unit", "cli-core"];
      const manifest = sampleManifest({
        entries: suites.flatMap((suite, s) =>
          entries(40, (i) => ({
            suite,
            cost: 1 + ((i * 7 + s) % 11),
            unit: `packages/${suite}/${i % 9}.test.ts`,
            repeats: i % 13 === 0 ? 2 : 1,
          })).map((entry) => ({
            ...entry,
            test: { ...entry.test, s: suite },
          }))
        ),
        calibration: {
          setupCost: { fuse: 14, toolshed: 3 },
          suites: {
            "workspace-unit": {
              overhead: 9,
              correction: 0.8,
              unitOverhead: 2,
              unitHooks: {
                "packages/workspace-unit/0.test.ts": 6,
                "packages/workspace-unit/4.test.ts": 2.5,
              },
            },
            "runner-unit": { overhead: 4, correction: 0.4, unitOverhead: 1 },
            "cli-core": {
              overhead: 21,
              correction: 1.2,
              unitOverhead: 0,
              unitHooks: { "packages/cli-core/3.test.ts": 11 },
            },
          },
          prologue: 0,
        },
      });
      const capabilities = new Map([
        ["workspace-unit", ["fuse"]],
        ["runner-unit", ["fuse", "toolshed"]],
      ]);
      const result = run(manifest, { capabilities });
      for (const lane of result.lanes) {
        const bySuite = Map.groupBy(
          lane.selections,
          ({ entry }) => entry.suite,
        );
        const setup = lane.capabilities.reduce(
          (total, capability) =>
            total + manifest.calibration.setupCost[capability]!,
          0,
        );
        const charges = [...bySuite].reduce(
          (total, [suite, held]) => total + suiteCharge(manifest, suite, held),
          0,
        );
        expect(charges + setup).toBeCloseTo(lane.projectedSeconds, 6);
      }
      expect(result.lanes.some((lane) => lane.selections.length > 0))
        .toBe(true);
    });

    it("charges a unit's hooks through the correction each time a pass opens it", () => {
      // Three units of one test each, the first of them run twice: four
      // openings at the per-unit charge, the first unit's hooks twice and
      // the second's once, through a correction of two, and four seconds
      // of tests through it too.
      const manifest = sampleManifest({
        entries: entries(3, (i) => ({
          cost: 1,
          unit: `packages/memory/test/${i}.test.ts`,
        })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": {
              overhead: 0,
              correction: 2,
              unitOverhead: 1,
              unitHooks: {
                "packages/memory/test/0.test.ts": 4,
                "packages/memory/test/1.test.ts": 3,
              },
            },
          },
          prologue: 0,
        },
      });
      const held = manifest.entries.map((entry, i) => ({
        entry,
        repeats: i === 0 ? 2 : 1,
      }));
      expect(suiteCharge(manifest, "workspace-unit", held))
        .toBeCloseTo(4 * 1 + 2 * (2 * 4 + 3) + 2 * 4, 6);
    });

    it("leaves a unit's hooks out of what a lane pays before it runs anything", () => {
      // They are time of the kind a unit's tests take, and a suite's
      // fixed charge would otherwise be the hooks of whichever unit the
      // manifest happened to list first.
      const manifest = sampleManifest({
        entries: entries(2, () => ({ suite: "workspace-unit" })),
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": {
              overhead: 9,
              correction: 1,
              unitOverhead: 2,
              unitHooks: Object.fromEntries(
                entries(2, () => ({})).map((entry) => [entry.unit, 300]),
              ),
            },
          },
          prologue: 0,
        },
      });
      expect(fixedCharges({ manifest, capabilities: new Map() }))
        .toEqual({ "workspace-unit": 11 });
    });

    it("charges nothing for a suite a lane holds nothing of", () => {
      expect(
        suiteCharge(sampleManifest(), "workspace-unit", []),
      ).toBe(0);
    });

    it("gives every suite's fixed charge, inside the budget or past it", () => {
      const manifest = sampleManifest({
        entries: [
          ...entries(2, () => ({ suite: "workspace-unit" })),
          ...entries(2, () => ({ suite: "cli-core" })).map((entry, i) => ({
            ...entry,
            test: { ...entry.test, n: `cli ${i}` },
          })),
        ],
        calibration: {
          setupCost: { fuse: 14 },
          suites: {
            "workspace-unit": { overhead: 9, correction: 1, unitOverhead: 2 },
            "cli-core": { overhead: 400, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const capabilities = new Map([["workspace-unit", ["fuse"]]]);
      expect(fixedCharges({ manifest, capabilities }))
        .toEqual({ "workspace-unit": 25, "cli-core": 400 });
      // The same figure the crowding report compares against the budget.
      expect(run(manifest, { capabilities }).crowding.map((c) => c.fixed))
        .toEqual([400]);
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

    describe("a unit that runs more than once", () => {
      // A lane runs a suite's share in passes, one for each time its most
      // repeated unit runs, and each pass invokes the suite's command
      // afresh over the units still running.

      /** A manifest of one suite whose tests all have to run. */
      function repeated(
        fit: Calibration["suites"][string],
        tests: { cost: number; repeats: number; unit: string }[],
      ) {
        const manifest = sampleManifest({
          entries: entries(tests.length, (i) => tests[i]!),
          calibration: {
            setupCost: {},
            suites: { "workspace-unit": fit },
            prologue: 0,
          },
        });
        return run(manifest, {
          lanes: 1,
          budgetSeconds: 1000,
          mandatory: everything(manifest),
        }).lanes[0]!.projectedSeconds;
      }

      it("charges a suite's overhead once for each pass", () => {
        // Three passes, for the unit that runs three times; the unit that
        // runs once adds none.
        expect(
          repeated({ overhead: 10, correction: 1, unitOverhead: 0 }, [
            { cost: 1, repeats: 3, unit: "packages/memory/test/a.test.ts" },
            { cost: 1, repeats: 1, unit: "packages/memory/test/b.test.ts" },
          ]),
        ).toBeCloseTo(30 + 4, 6);
      });

      it("charges a unit's overhead once for each pass that opens it", () => {
        expect(
          repeated({ overhead: 0, correction: 1, unitOverhead: 5 }, [
            { cost: 1, repeats: 2, unit: "packages/memory/test/a.test.ts" },
            { cost: 1, repeats: 1, unit: "packages/memory/test/b.test.ts" },
          ]),
        ).toBeCloseTo(15 + 3, 6);
      });

      it("charges the loads every test of a unit for each run of the unit", () => {
        // The repeated unit takes 20 a run and runs twice, so the loads
        // come to 0.4 of 40 and 200, where the floor is 20 and 20.
        expect(
          repeated({ overhead: 0, correction: 0.4, unitOverhead: 0 }, [
            { cost: 10, repeats: 2, unit: "packages/memory/test/a.test.ts" },
            { cost: 10, repeats: 1, unit: "packages/memory/test/a.test.ts" },
            ...Array.from({ length: 10 }, (_, i) => ({
              cost: 20,
              repeats: 1,
              unit: `packages/memory/test/${i}.test.ts`,
            })),
          ]),
        ).toBeCloseTo(96, 6);
      });

      it("charges a unit's earlier tests again when a later one repeats it", () => {
        // The test of 40 is placed first, as the dearer, and runs once.
        // The test of 5 then makes its unit run three times, which runs the
        // test of 40 twice more: the unit takes 135, and with the twelve
        // other files of 20 the loads come to 0.4 of 375.
        expect(
          repeated({ overhead: 0, correction: 0.4, unitOverhead: 0 }, [
            { cost: 40, repeats: 1, unit: "packages/memory/test/a.test.ts" },
            { cost: 5, repeats: 3, unit: "packages/memory/test/a.test.ts" },
            ...Array.from({ length: 12 }, (_, i) => ({
              cost: 20,
              repeats: 1,
              unit: `packages/memory/test/${i}.test.ts`,
            })),
          ]),
        ).toBeCloseTo(150, 6);
      });

      it("charges the floor the longest unit of each pass", () => {
        // The first pass takes the unit of 100, and the second the unit of
        // 60, which is the only one still running.
        expect(
          repeated({ overhead: 0, correction: 0.4, unitOverhead: 0 }, [
            { cost: 100, repeats: 1, unit: "packages/memory/test/a.test.ts" },
            { cost: 60, repeats: 2, unit: "packages/memory/test/b.test.ts" },
          ]),
        ).toBeCloseTo(160, 6);
      });

      it("reads a lane's share the way the packer charged it", () => {
        const manifest = sampleManifest({
          entries: entries(3, (i) => ({
            cost: [100, 60, 30][i]!,
            repeats: [1, 2, 3][i]!,
            unit: `packages/memory/test/${i}.test.ts`,
          })),
          calibration: {
            setupCost: {},
            suites: {
              "workspace-unit": {
                overhead: 0,
                correction: 0.4,
                unitOverhead: 0,
              },
            },
            prologue: 0,
          },
        });
        const lane = run(manifest, {
          lanes: 1,
          budgetSeconds: 1000,
          mandatory: everything(manifest),
        }).lanes[0]!;
        // The passes take 100, 60 and 30.
        expect(suiteLoad(manifest, "workspace-unit", lane.selections))
          .toBeCloseTo(190, 6);
        expect(lane.projectedSeconds).toBeCloseTo(190, 6);
        expect(testsOf(lane.selections, aroundIn(manifest.entries))).toEqual({
          ran: 100 + 120 + 90,
          longest: [100, 60, 30],
          opened: 6,
        });
      });
    });

    describe("a test inside a `describe`", () => {
      // A runner running a leaf runs the `beforeAll` and `afterAll` of
      // every `describe` around it, on every run of the unit, whichever
      // lane the manifest's entry for that `describe` went to. That entry's
      // cost is the time the `describe` spent outside the cases directly
      // inside it, which is what its hooks take.

      /**
       * A test of one file, named for its whole `describe` chain. One too
       * flaky to judge a change by stands for a `describe` no lane is
       * given, whose hooks run all the same around any leaf inside it.
       */
      function named(
        n: string,
        cost: number,
        fields: Partial<ManifestEntry> = {},
      ): ManifestEntry {
        return sampleEntry({ k: "unit", s: "memory", n }, {
          unit: "packages/memory/test/hooks.test.ts",
          cost,
          ...fields,
        });
      }

      const UNPLACED = { flakeRate: 0.5 };

      /** The one lane of a plan that must run `chosen`. */
      function laneRunning(
        corpus: ManifestEntry[],
        chosen: ManifestEntry[],
      ) {
        return run(sampleManifest({ entries: corpus }), {
          lanes: 1,
          budgetSeconds: 1000,
          mandatory: new Map(
            chosen.map((entry) => [
              testIdentityKey(entry.test),
              "changed" as const,
            ]),
          ),
        }).lanes[0]!;
      }

      it("charges a lane holding only a leaf the `describe` around it, once for each run of the unit", () => {
        const leaf = named("hooks > runs a leaf", 1, { repeats: 3 });
        const lane = laneRunning(
          [named("hooks", 100, UNPLACED), leaf],
          [leaf],
        );
        expect(lane.selections.map(({ entry }) => entry.test.n))
          .toEqual(["hooks > runs a leaf"]);
        expect(lane.projectedSeconds).toBeCloseTo(3 * (1 + 100), 6);
      });

      it("charges a `describe` once for each run however many of its leaves the lane holds", () => {
        const leaves = [
          named("hooks > runs one leaf", 1),
          named("hooks > runs another", 2),
        ];
        const lane = laneRunning(
          [named("hooks", 100, UNPLACED), ...leaves],
          leaves,
        );
        expect(lane.projectedSeconds).toBeCloseTo(1 + 2 + 100, 6);
      });

      it("charges a `describe` the lane holds beside a leaf inside it once", () => {
        const corpus = [named("hooks", 100), named("hooks > runs a leaf", 1)];
        const lane = laneRunning(corpus, corpus);
        expect(lane.selections.length).toBe(2);
        expect(lane.projectedSeconds).toBeCloseTo(100 + 1, 6);
      });

      it("charges every `describe` around a leaf, and none it is not inside", () => {
        const leaf = named("outer > inner > runs a leaf", 1, { repeats: 2 });
        const lane = laneRunning(
          [
            named("outer", 50, UNPLACED),
            named("outer > inner", 20, UNPLACED),
            leaf,
            named("outer > beside", 30, UNPLACED),
            named("outer > beside > runs elsewhere", 4, UNPLACED),
          ],
          [leaf],
        );
        expect(lane.projectedSeconds).toBeCloseTo(2 * (1 + 20 + 50), 6);
      });

      it("charges the lane a leaf goes to without its `describe` for the `describe`, as `suiteCharge()` reads it", () => {
        // The two lanes hold 102 seconds each. The first leaf placed costs
        // 101 with its `describe`, and the next one 1 beside it, so the
        // third goes to the second lane, which pays for the `describe` as
        // well.
        const manifest = sampleManifest({
          entries: [
            named("hooks", 100),
            named("hooks > runs one leaf", 1),
            named("hooks > runs another", 1),
            named("hooks > runs a third", 1),
          ],
        });
        const result = run(manifest, {
          policy: "everything",
          lanes: 2,
          budgetSeconds: 102,
        });
        expect(result.lanes.map((lane) => lane.projectedSeconds))
          .toEqual([102, 101]);
        for (const lane of result.lanes) {
          expect(suiteCharge(manifest, "workspace-unit", lane.selections))
            .toBeCloseTo(lane.projectedSeconds, 6);
        }
      });
    });

    describe("testsOf()", () => {
      it("returns the same figures whatever order the selections are listed in", () => {
        // Added in this order, 0.1, 0.2 and 0.3 come to 0.6000000000000001,
        // and in the other to 0.6.
        const corpus = entries(3, (i) => ({
          cost: [0.1, 0.2, 0.3][i]!,
          unit: "packages/memory/test/one.test.ts",
        }));
        const around = aroundIn(corpus);
        const selections = corpus.map((entry) => ({ entry, repeats: 1 }));
        expect(testsOf(selections.toReversed(), around))
          .toEqual(testsOf(selections, around));
        expect(testsOf(selections, around).ran).toBe(0.6000000000000001);
      });
    });

    describe("a suite running its units side by side", () => {
      // Its correction is well below one, because a batch of many units
      // spends a fraction of what they take between them. A batch still
      // does not finish before its longest unit has.

      const sideBySide: Calibration = {
        setupCost: {},
        suites: {
          "workspace-unit": { overhead: 0, correction: 0.4, unitOverhead: 0 },
        },
        prologue: 0,
      };

      it("charges a lane no less than its longest test takes", () => {
        const manifest = sampleManifest({
          entries: entries(3, (i) => ({ cost: i === 0 ? 100 : 1 })),
          calibration: sideBySide,
        });
        const result = run(manifest, { lanes: 1, budgetSeconds: 200 });
        expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(100, 6);
      });

      it("charges a lane no less than the unit it holds most of takes", () => {
        // A unit's tests follow one another, so three tests of one file
        // take their three costs added together.
        const manifest = sampleManifest({
          entries: entries(3, () => ({
            cost: 40,
            unit: "packages/memory/test/one.test.ts",
          })),
          calibration: sideBySide,
        });
        const result = run(manifest, { lanes: 1, budgetSeconds: 200 });
        expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(120, 6);
      });

      it("charges a unit every test in it for each run its most repeated test asks for", () => {
        // The runner runs the unit twice, with both tests each time, so it
        // takes 40 seconds, where the two tests' own runs come to 30.
        const manifest = sampleManifest({
          entries: entries(2, (i) => ({
            cost: 10,
            repeats: i === 0 ? 2 : 1,
            unit: "packages/memory/test/one.test.ts",
          })),
          calibration: sideBySide,
        });
        const result = run(manifest, {
          lanes: 1,
          budgetSeconds: 200,
          mandatory: everything(manifest),
        });
        expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(40, 6);
      });

      it("charges a lane the corrected sum where that is more", () => {
        const manifest = sampleManifest({
          entries: entries(10, () => ({ cost: 20 })),
          calibration: sideBySide,
        });
        const result = run(manifest, { lanes: 1, budgetSeconds: 200 });
        expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(80, 6);
      });

      it("reads a lane's share the way the packer charged it", () => {
        const manifest = sampleManifest({
          entries: entries(
            6,
            (i) =>
              i < 2
                ? { cost: 40, unit: "packages/memory/test/one.test.ts" }
                : { cost: 10 },
          ),
          calibration: sideBySide,
        });
        const result = run(manifest, { lanes: 1, budgetSeconds: 200 });
        const selections = result.lanes[0]!.selections;
        expect(selections.length).toBe(6);
        expect(suiteLoad(manifest, "workspace-unit", selections)).toBeCloseTo(
          result.lanes[0]!.projectedSeconds,
          6,
        );
        expect(suiteLoad(manifest, "workspace-unit", selections)).toBeCloseTo(
          80,
          6,
        );
        expect(suiteLoad(manifest, "workspace-unit", selections.slice(2)))
          .toBeCloseTo(16, 6);
      });

      it("charges a lane every run of a repeated test in full", () => {
        // The runs of one unit follow one another, so none of them is
        // shared out among the rest of the batch.
        const manifest = sampleManifest({
          entries: entries(1, () => ({ cost: 50, repeats: 2 })),
          calibration: sideBySide,
        });
        const result = run(manifest, {
          lanes: 1,
          budgetSeconds: 200,
          mandatory: everything(manifest),
        });
        expect(result.lanes[0]!.selections[0]!.repeats).toBe(2);
        expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(100, 6);
      });

      it("reports a test no lane can hold on its own time rather than the corrected one", () => {
        // Corrected, the test would cost the lane 160 seconds, well inside
        // the bound. It takes 400.
        const manifest = sampleManifest({
          entries: entries(1, () => ({ cost: 400 })),
          calibration: sideBySide,
        });
        const result = run(manifest, { lanes: 1, boundSeconds: 300 });
        expect(result.unschedulable.map(({ cost }) => cost)).toEqual([400]);
        expect(selected(result)).toEqual([]);
      });
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

  it("merges a unit holding more tests than one call takes arguments", () => {
    // Each test is an entry, and the merged entry takes the largest of
    // their flake rates and repeat counts, so a unit of this size is one
    // whose entries cannot all be passed to one call.
    const count = 500_000;
    const { entries } = foldWholeUnits(
      sampleManifest({
        entries: Array.from(
          { length: count },
          (_, i) =>
            sampleEntry({ k: "browser", s: "ui", n: `half ${i}` }, {
              unit: HALF,
              cost: 1,
              flakeRate: i === count / 2 ? 0.25 : 0,
              repeats: i === count / 2 ? 3 : 1,
            }),
        ),
      }),
      WHOLE,
    );
    expect(entries.length).toBe(1);
    expect(entries[0]!.cost).toBe(count);
    expect(entries[0]!.flakeRate).toBe(0.25);
    expect(entries[0]!.repeats).toBe(3);
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
    // The withheld test is reported as withheld, and the rest of its unit
    // as held back with it.
    expect(result.heldWithUnit.map((test) => test.n).sort())
      .toEqual(["half 0", "half 1"]);
    // A change that reaches the unit runs it, so nothing is held back.
    const reached = run(manifest, {
      wholeUnits: WHOLE,
      mandatory: new Map([
        [testIdentityKey({ k: "browser", s: "ui", n: "half 1" }), "changed"],
      ]),
    });
    expect(reached.heldWithUnit).toEqual([]);
    expect(lanesHolding(reached, "half 0")).toHaveLength(1);
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
    for (const entry of other) manifest.entries.push(entry);
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
  it("refuses to plan, rather than choosing between its rows", () => {
    // Two rows of one identity can disagree about what it costs or
    // scores, and which of them a plan followed would depend on where the
    // manifest listed them.
    const first = sampleEntry({ k: "unit", s: "memory", n: "case 0" }, {
      unit: "packages/memory/test/case-0.test.ts",
      score: 0.9,
    });
    const rest = entries(3).slice(1);
    expect(() =>
      run(sampleManifest({ entries: [first, ...rest, { ...first }] }))
    ).toThrow(`${testIdentityKey(first.test)} is listed more than once`);
    expect(() => run(sampleManifest({ entries: [first, ...rest] })))
      .not.toThrow();
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

  function counted(
    manifest: Manifest,
    overrides: Partial<PlanInput> = {},
    most?: number,
  ) {
    return laneCount({
      manifest,
      mandatory: new Map(),
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      policy: "everything",
      ...overrides,
    }, most);
  }

  function count(manifest: Manifest, overrides: Partial<PlanInput> = {}) {
    return counted(manifest, overrides).lanes;
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

  it("takes no lanes for runs the packer gives up, and keeps an overrun", () => {
    // Every execution asked for comes to more lanes than the packing
    // needs, because the packer gives up runs rather than putting a lane
    // past its budget. A lane taken for each of those runs would cost
    // the default branch a job per commit.
    //
    // The identity costing more than a whole lane runs past its budget at
    // every count, so a count that waited for no lane to run long would
    // take every lane it was allowed.
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
    // vast test, which divides into more lanes than the packing needs.
    const everyRun = Math.ceil(
      manifest.entries.reduce((t, e) => t + e.cost * e.repeats, 0) / 100,
    );
    expect(everyRun).toBeGreaterThan(lanes);
    // And one lane fewer runs longer.
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
    // suite it opens: three lanes hold eight tests of a ninth of a
    // budget each only if their overheads are free, and they are not.
    const manifest = sampleManifest({
      entries: entries(24, () => ({ cost: FULL_LANE_BUDGET_SECONDS / 9 })),
      calibration: {
        setupCost: {},
        suites: {
          "workspace-unit": {
            overhead: FULL_LANE_BUDGET_SECONDS * 0.3,
            correction: 1,
            unitOverhead: 0,
          },
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

  /**
   * Five suites, each costing half of a lane of `budget` to open, and two
   * lanes of tests in each, so the run needs twenty lanes. While every
   * lane is crowded, work that fits nowhere goes to the shortest lane and
   * opens its suite there again, so a lane added can cost more than the
   * budget it brings.
   */
  function crowding(budget: number): Manifest {
    const suites = ["a", "b", "c", "d", "e"];
    return sampleManifest({
      entries: suites.flatMap((suite) =>
        Array.from(
          { length: 40 },
          (_, i) =>
            sampleEntry({ k: "unit", s: suite, n: `case ${i}` }, {
              suite,
              unit: `${suite}/case-${i}.test.ts`,
              cost: budget / 20,
            }),
        )
      ),
      calibration: {
        setupCost: {},
        suites: Object.fromEntries(
          suites.map((suite) => [suite, {
            overhead: budget / 2,
            correction: 1,
            unitOverhead: 0,
          }]),
        ),
        prologue: 0,
      },
    });
  }

  /** Seconds the lanes of a full run run past `budget`, added up. */
  function overrunAt(manifest: Manifest, budget: number, lanes: number) {
    return plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      wholeUnits: NO_WHOLE_UNITS,
      policy: "everything",
      budgetSeconds: budget,
      lanes,
    }).lanes.reduce(
      (total, lane) => total + Math.max(0, lane.projectedSeconds - budget),
      0,
    );
  }

  it("finds the count past lanes that add to the overrun", () => {
    // Ten lanes run past their budgets by less in all than eleven do, so
    // counting up a lane at a time from ten would stop there, with every
    // lane long.
    const budget = 1000;
    const manifest = crowding(budget);
    expect(overrunAt(manifest, budget, 11))
      .toBeGreaterThan(overrunAt(manifest, budget, 10));
    expect(counted(manifest, { budgetSeconds: budget }, 100))
      .toEqual({ lanes: 20, capped: false });
    expect(overrunAt(manifest, budget, 20)).toBe(0);
    expect(overrunAt(manifest, budget, 19)).toBeGreaterThan(0);
  });

  it("says the cap binds wherever it is short of what the run needs", () => {
    // One lane runs past its budget by less in all than six do, so a
    // count judged against the overrun at a cap of six would take one.
    const budget = 1000;
    const manifest = crowding(budget);
    expect(overrunAt(manifest, budget, 1))
      .toBeLessThan(overrunAt(manifest, budget, 6));
    for (const most of [1, 6, 10, 19]) {
      expect(counted(manifest, { budgetSeconds: budget }, most))
        .toEqual({ lanes: most, capped: true });
    }
    expect(counted(manifest, { budgetSeconds: budget }, 20))
      .toEqual({ lanes: 20, capped: false });
  });

  it("takes what the run needs where the cap allows it", () => {
    // Three lanes' worth of work, in tests small enough to divide evenly.
    const manifest = sampleManifest({
      entries: entries(FULL_LANE_BUDGET_SECONDS * 3, () => ({ cost: 1 })),
    });
    expect(counted(manifest, {}, 2)).toEqual({ lanes: 2, capped: true });
    expect(counted(manifest, {}, 3)).toEqual({ lanes: 3, capped: false });
    expect(counted(manifest, {}, 4)).toEqual({ lanes: 3, capped: false });
  });

  it("gives a lane apiece to tests only an empty lane can hold", () => {
    // Each costs more than a lane's budget and less than its bound, which
    // a lane holding nothing else may run up to.
    const manifest = sampleManifest({
      entries: entries(3, () => ({
        cost: (FULL_LANE_BUDGET_SECONDS + FULL_LANE_BOUND_SECONDS) / 2,
      })),
    });
    expect(counted(manifest)).toEqual({ lanes: 3, capped: false });
  });

  it("gives a lane apiece to tests no lane can hold", () => {
    // Each runs past the bound wherever it goes, and two in one lane run
    // past it twice over.
    const manifest = sampleManifest({
      entries: entries(3, () => ({ cost: FULL_LANE_BOUND_SECONDS * 2 })),
    });
    expect(counted(manifest)).toEqual({ lanes: 3, capped: false });
    expect(counted(manifest, {}, 2)).toEqual({ lanes: 2, capped: true });
  });

  it("stops rather than chasing work no number of lanes can fit", () => {
    // The vast test runs past its lane's budget at every count, so a
    // count that waited for every lane to fit would take every lane it
    // was allowed.
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
    const at = (n: number) =>
      plan({
        manifest,
        mandatory: new Map(),
        capabilities,
        wholeUnits: NO_WHOLE_UNITS,
        policy: "everything",
        lanes: n,
      });
    // The one lane past its budget holds the vast test alone.
    const over = at(lanes).lanes.filter((lane) =>
      lane.projectedSeconds > FULL_LANE_BUDGET_SECONDS
    );
    expect(over.map((lane) => lane.selections.length)).toEqual([1]);
    expect(at(lanes - 1).overflowed).toBeGreaterThan(0);
    expect(lanes).toBeLessThan(manifest.entries.length);
  });

  it("keeps adding lanes for work one oversized test would hide", () => {
    // The oversized test pins the worst lane's overrun at every count,
    // so a search reading the worst lane alone would stop at once and
    // leave every other lane crowded. What the rest of the corpus needs
    // is what decides the count.
    const manifest = sampleManifest({
      entries: [
        ...entries(40, () => ({
          cost: Math.floor(FULL_LANE_BUDGET_SECONDS / 5.3),
        })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: FULL_LANE_BUDGET_SECONDS * 1.7,
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

describe("how many lanes a pull request needs", () => {
  /**
   * A thousand one-second tests in lanes of a hundred seconds, the first
   * 250 of which the change makes mandatory.
   */
  function change(overrides: Partial<PlanInput> = {}) {
    const manifest = sampleManifest({
      entries: entries(1000, () => ({ cost: 1 })),
    });
    const mandatory = new Map(
      manifest.entries.slice(0, 250).map((entry) => [
        testIdentityKey(entry.test),
        "changed" as const,
      ]),
    );
    return {
      manifest,
      mandatory,
      capabilities: NO_CAPABILITIES,
      wholeUnits: NO_WHOLE_UNITS,
      budgetSeconds: 100,
      ...overrides,
    };
  }

  /** Seconds a plan placed by score, rather than because it must run. */
  function chosenSeconds(laid: ReturnType<typeof plan>): number {
    return selected(laid).filter((selection) => selection.reason !== "changed")
      .length;
  }

  it("takes the fewest lanes that hold its mandatory work and its target", () => {
    const input = change({ discretionarySeconds: 300 });
    expect(laneCount(input)).toEqual({ lanes: 6, capped: false });
    expect(plan({ ...input, lanes: 6 }).discretionarySeconds).toBe(300);
    expect(plan({ ...input, lanes: 5 }).discretionarySeconds).toBe(250);
  });

  it("takes more lanes for a larger target", () => {
    expect(laneCount(change({ discretionarySeconds: 600 })).lanes).toBe(9);
    expect(laneCount(change({ discretionarySeconds: 150 })).lanes).toBe(4);
  });

  it("runs the mandatory work and nothing else under a target of nothing", () => {
    const input = change({ discretionarySeconds: 0 });
    expect(laneCount(input)).toEqual({ lanes: 3, capped: false });
    const laid = plan(input);
    expect(placedOnlyMandatory(laid)).toBe(true);
    expect(selected(laid).length).toBe(250);
    expect(placedOnlyMandatory(plan(change({ discretionarySeconds: 1 }))))
      .toBe(false);
  });

  it("spends its target and no more, however many lanes it has", () => {
    const input = change({ discretionarySeconds: 300 });
    expect(chosenSeconds(plan({ ...input, lanes: 20 }))).toBe(300);
    expect(chosenSeconds(plan({ ...input, lanes: 6 }))).toBe(300);
    expect(chosenSeconds(plan({ ...input, lanes: 5 }))).toBe(250);
  });

  it("gives tests chosen by score the room left where the cap binds", () => {
    const input = change({ discretionarySeconds: 10_000 });
    expect(laneCount(input, 8)).toEqual({ lanes: 8, capped: true });
    expect(plan({ ...input, lanes: 8 }).discretionarySeconds).toBe(550);
  });

  it("asks for no more room than everything it could choose would take", () => {
    // 750 one-second tests to choose from, against a target of far more.
    const input = change({ discretionarySeconds: 1_000_000 });
    expect(laneCount(input)).toEqual({ lanes: 10, capped: false });
    expect(selected(plan({ ...input, lanes: 10 })).length).toBe(1000);
    expect(selected(plan({ ...input, lanes: 9 })).length).toBeLessThan(1000);
  });

  it("counts its own lanes where it is given none", () => {
    const input = change({ discretionarySeconds: 300 });
    expect(plan(input).lanes.length).toBe(6);
  });

  it("opens no lane its tests chosen by score could not fill", () => {
    // Each lane holding any of these pays the suite's twenty seconds, so
    // charging each test as though it ran alone would ask for a lane per
    // twenty or so of them.
    const manifest = sampleManifest({
      entries: entries(1000, () => ({ cost: 1 })),
      calibration: {
        setupCost: {},
        suites: {
          "workspace-unit": { overhead: 20, correction: 1, unitOverhead: 0 },
        },
        prologue: 0,
      },
    });
    const input = {
      manifest,
      mandatory: new Map(),
      capabilities: NO_CAPABILITIES,
      wholeUnits: NO_WHOLE_UNITS,
      budgetSeconds: 230,
      discretionarySeconds: 10_000,
    };
    expect(laneCount(input)).toEqual({ lanes: 5, capped: false });
    const laid = plan({ ...input, lanes: 5 });
    expect(selected(laid).length).toBe(1000);
    expect(laid.lanes.every((lane) => lane.selections.length > 0)).toBe(true);
  });

  it("chooses nothing by score in a full run, whatever its target", () => {
    const input = {
      ...change({ policy: "everything", discretionarySeconds: 300 }),
      mandatory: new Map(),
    };
    expect(laneCount(input).lanes).toBe(10);
    const laid = plan({ ...input, lanes: 20 });
    expect(laid.discretionarySeconds).toBe(0);
    expect(laid.discretionaryTargetSeconds).toBe(0);
    // A budgeted plan given the same room spends its target.
    expect(
      plan({ ...input, policy: "budgeted", lanes: 20 }).discretionarySeconds,
    )
      .toBe(300);
  });
});
