import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { testIdentityKey } from "@commonfabric/test-support/records";

import { census, unknownIdentity } from "./census.ts";
import {
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
} from "./manifest.ts";
import type { Suite } from "../test-topology/suite.ts";
import { loadTopology } from "../test-topology.ts";

/**
 * The repository, found from this file rather than from the process's
 * own directory: a package's tests run with that package as the working
 * directory, and the paths the topology reads are the repository's.
 */
const REPOSITORY = new URL("../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
import { UNMEASURED_COST_SECONDS } from "./policy.ts";

/** A suite holding exactly what a case describes. */
function suite(partial: Partial<Suite> & { id: string }): Suite {
  return {
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs: ["deno"],
    units: [],
    unavailable: [],
    whole: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
    ...partial,
  };
}

/** A manifest carrying exactly these entries. */
function manifestOf(entries: readonly Partial<ManifestEntry>[]): Manifest {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: "2026-09-01T00:00:00.000Z",
    seed: "seed",
    commit: "c".repeat(40),
    runs: 1,
    dials: {},
    calibration: { setupCost: {}, suites: {}, prologue: 40 },
    entries: entries.map((entry) => ({
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1,
      score: 0.5,
      inputs: { catches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
      ...entry,
    })),
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 0, digest: "" },
    coverageBaselines: [],
  };
}

describe("what a lane must run whatever the score says", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
  });

  it("runs a unit no manifest has ever seen", () => {
    const manifest = manifestOf([{}]);
    const { mandatory, manifest: seen } = census(
      [bakery],
      manifest,
      new Set(),
    );
    const key = testIdentityKey(
      unknownIdentity(bakery, "packages/bakery/proof.test.ts"),
    );
    expect(mandatory.get(key)).toBe("unknown");
    // It carries a stand-in entry, since the packer cannot place an
    // identity the manifest it was handed does not hold.
    const standing = seen.entries.find((entry) =>
      testIdentityKey(entry.test) === key
    );
    expect(standing?.unit).toBe("packages/bakery/proof.test.ts");
    expect(standing?.suite).toBe("workspace-unit");
  });

  it("runs every unit when there is no manifest at all", () => {
    const { mandatory } = census([bakery], undefined, new Set());
    expect(mandatory.size).toBe(2);
    expect([...mandatory.values()]).toEqual(["unknown", "unknown"]);
  });

  it("runs the identities of a unit the change touched", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const { mandatory } = census(
      [bakery],
      manifest,
      new Set(["packages/bakery/glaze.test.ts"]),
    );
    expect(
      mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "glaze > sets" }),
      ),
    ).toBe("changed");
    expect(
      mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "glaze > browns" }),
      ),
    ).toBe("changed");
  });

  it("asks a suite which of its units a change reaches", () => {
    // A unit that is not a path — a type-check group, a binary — is one
    // only its suite can map the diff onto, so the suite is asked rather
    // than the diff being matched against the unit's name.
    const binaries = suite({
      id: "binaries",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["toolshed", "cf"],
      unitsForChange: (changed) =>
        changed.has("packages/shell/index.ts") ? ["toolshed"] : [],
    });
    const manifest = manifestOf([
      {
        test: { k: "gate", s: "repo", n: "build-binary toolshed" },
        suite: "binaries",
        unit: "toolshed",
      },
      {
        test: { k: "gate", s: "repo", n: "build-binary cf" },
        suite: "binaries",
        unit: "cf",
      },
    ]);
    const { mandatory } = census(
      [binaries],
      manifest,
      new Set(["packages/shell/index.ts"]),
    );
    expect(
      mandatory.get(
        testIdentityKey({ k: "gate", s: "repo", n: "build-binary toolshed" }),
      ),
    ).toBe("changed");
    expect(
      mandatory.get(
        testIdentityKey({ k: "gate", s: "repo", n: "build-binary cf" }),
      ),
    ).toBeUndefined();
  });

  it("leaves a gate the corpus already knows to the score", () => {
    // A gate is a test of the tree like any other: what it is worth is
    // what decides, so a gate that catches nothing stops being paid for.

    const gates = suite({
      id: "repo-gates",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["deno-fmt"],
    });
    const manifest = manifestOf([{
      test: { k: "gate", s: "repo", n: "deno-fmt" },
      suite: "repo-gates",
      unit: "deno-fmt",
    }]);
    expect(census([gates], manifest, new Set()).mandatory.size).toBe(0);
    // A gate's unit is a name rather than a path and its suite maps no
    // change onto its units, so the rule that reaches it is the corpus
    // having no record of it.
    expect([
      ...census([gates], undefined, new Set()).mandatory.values(),
    ]).toEqual(["unknown"]);
  });

  it("says nothing about a unit a configuration declares unavailable", () => {
    const on = suite({
      id: "package-integration-on",
      variant: "server-execution",
      units: ["packages/oven/a.test.ts"],
      unavailable: [{
        unit: "packages/oven/a.test.ts",
        reason: "the surface it exercises has not landed",
      }],
    });
    const seen = census([on], undefined, new Set());
    expect(seen.mandatory.size).toBe(0);
    expect(seen.manifest.entries).toEqual([]);
  });

  it("keeps a unit whose unavailability names only one leaf", () => {
    // Every other identity in the file still runs, so taking the file
    // out would stop far more than the configuration asked to stop.
    const on = suite({
      id: "package-integration-on",
      variant: "server-execution",
      units: ["packages/oven/a.test.ts"],
      unavailable: [{
        unit: "packages/oven/a.test.ts",
        leafName: "bakes > slowly",
        reason: "the surface that step exercises has not landed",
      }],
    });
    expect(census([on], undefined, new Set()).mandatory.size).toBe(1);
  });
});

describe("the identity a unit nothing has recorded stands on", () => {
  const unit = "packages/oven/bakes.test.ts";
  const on = suite({
    id: "package-integration-opposite",
    variant: "server-execution",
    units: [unit],
  });
  const off = suite({ id: "package-integration", units: [unit] });

  it("carries the configuration its suite runs in", () => {
    expect(unknownIdentity(on, unit).v).toBe("server-execution");
    expect(unknownIdentity(off, unit).v).toBeUndefined();
  });

  it("keeps two configurations of one unit apart", () => {
    // A source file belongs to one default suite and one suite for each
    // non-default configuration, and those are separate execution
    // surfaces with separate histories. Were the stand-ins to collide,
    // one entry would stand for both, one of the two would be placed in
    // no lane, and the lane would exit zero having never run it.
    const seen = census([off, on], undefined, new Set());
    expect(seen.manifest.entries.length).toBe(2);
    expect(new Set(seen.mandatory.keys()).size).toBe(2);
    expect(seen.manifest.entries.map((entry) => entry.suite).toSorted())
      .toEqual(["package-integration", "package-integration-opposite"]);
  });

  it("refuses a stand-in whose name a real test already has", () => {
    // Vanishingly unlikely and cheap to refuse. What it costs to ignore
    // is a unit that goes into no lane while everything downstream
    // counts as though it had, which is a test that quietly stops
    // running.
    const collides = manifestOf([{
      test: {
        k: "unit",
        s: "bakery",
        n: `unrecorded ${"packages/oven/bakes.test.ts"}`,
      },
      unit: "packages/oven/somewhere-else.test.ts",
    }]);
    expect(() => census([off], collides, new Set())).toThrow("run nowhere");
  });

  it("gives the whole topology as many stand-ins as it has units", async () => {
    // The property above, over the repository's real suites rather than
    // over a pair built to show it.
    const suites = await loadTopology(REPOSITORY);
    const seen = census(suites, undefined, new Set());
    const available = suites.reduce(
      (total, suite) =>
        total + suite.units.length -
        suite.unavailable.filter((entry) => entry.leafName === undefined)
          .length,
      0,
    );
    expect(seen.manifest.entries.length).toBe(available);
    expect(new Set(seen.mandatory.keys()).size).toBe(available);
  });
});

describe("what the tree says and the manifest does not", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
    unavailable: [{
      unit: "packages/bakery/gone.test.ts",
      reason: "not in this configuration",
    }],
  });

  it("drops an entry naming a unit this tree does not have", () => {
    const stale = manifestOf([
      { unit: "packages/bakery/glaze.test.ts" },
      {
        test: { k: "unit", s: "bakery", n: "gone > entirely" },
        unit: "packages/bakery/gone.test.ts",
      },
      {
        test: { k: "unit", s: "bakery", n: "deleted > long ago" },
        unit: "packages/bakery/deleted.test.ts",
      },
    ]);
    const seen = census([bakery], stale, new Set());
    expect(seen.manifest.entries.map((entry) => entry.unit).toSorted())
      .toEqual([
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
      ]);
  });

  it("says nothing about an identity withheld that it cannot run", () => {
    const stale = manifestOf([{ unit: "packages/bakery/glaze.test.ts" }]);
    stale.withheld = [
      {
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        suite: "workspace-unit",
        reason: "flaky",
      },
      {
        test: { k: "unit", s: "bakery", n: "gone > entirely" },
        suite: "workspace-unit",
        reason: "flaky",
      },
    ];
    const seen = census([bakery], stale, new Set());
    expect(seen.manifest.withheld.map((held) => held.test.n))
      .toEqual(["glaze > sets"]);
  });

  /**
   * A suite of `measured` units costing what the numbers say, plus one
   * more the manifest has never seen, and what that one is charged.
   */
  function standInCostOf(measured: readonly number[]): number | undefined {
    const units = measured.map((_, at) => `packages/bakery/u${at}.test.ts`);
    const wide = suite({
      id: "workspace-unit",
      units: [...units, "packages/bakery/rest.test.ts"],
    });
    const manifest = manifestOf(measured.map((cost, at) => ({
      test: { k: "unit", s: "bakery", n: `u${at} > sets` },
      unit: units[at]!,
      cost,
    })));
    return census([wide], manifest, new Set()).manifest.entries.find((entry) =>
      entry.unit === "packages/bakery/rest.test.ts"
    )?.cost;
  }

  it("charges an unmeasured unit the ninetieth percentile of its suite", () => {
    // Eight units at a second, one at two and one at three. The
    // ninetieth percentile of those is 2 and their mean is 1.3, so the
    // percentile is what stands. A figure at the mean, or at the middle
    // of 1, leaves a lane no time for the unit it drew.
    expect(standInCostOf([1, 1, 1, 1, 1, 1, 1, 1, 2, 3])).toBe(2);
  });

  it("charges the suite's mean where its tail carries that above the percentile", () => {
    // Nine units at a second and one at a hundred. The ninetieth
    // percentile of those is 1, and twenty such units come to 218 rather
    // than to 20, so the mean is what holds a lane's total.
    expect(standInCostOf([1, 1, 1, 1, 1, 1, 1, 1, 1, 100])).toBe(10.9);
  });

  it("charges an unmeasured unit what a whole unit costs, not one test", () => {
    // Three units holding one, three and one test: 2 seconds, three
    // tests of 70, and 50. What a stand-in stands for is a whole unit,
    // so the figures are 2, 210 and 50, whose ninetieth percentile is
    // 210. Read from the five tests instead, the same five costs give
    // 70, which is a third of what running the file takes.
    const wide = suite({
      id: "workspace-unit",
      units: [
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
        "packages/bakery/knead.test.ts",
        "packages/bakery/rest.test.ts",
      ],
    });
    const manifest = manifestOf([
      { unit: "packages/bakery/glaze.test.ts", cost: 2 },
      {
        test: { k: "unit", s: "bakery", n: "proof > rises" },
        unit: "packages/bakery/proof.test.ts",
        cost: 70,
      },
      {
        test: { k: "unit", s: "bakery", n: "proof > doubles" },
        unit: "packages/bakery/proof.test.ts",
        cost: 70,
      },
      {
        test: { k: "unit", s: "bakery", n: "proof > slumps" },
        unit: "packages/bakery/proof.test.ts",
        cost: 70,
      },
      {
        test: { k: "unit", s: "bakery", n: "knead > folds" },
        unit: "packages/bakery/knead.test.ts",
        cost: 50,
      },
    ]);
    const seen = census([wide], manifest, new Set());
    const standing = seen.manifest.entries.find((entry) =>
      entry.unit === "packages/bakery/rest.test.ts"
    );
    expect(standing?.cost).toBe(210);
  });

  it("charges every unmeasured unit of a suite the same figure", () => {
    // What the packer is told about one of them cannot depend on how
    // many others the tree holds, since none of them is measured.
    const wide = suite({
      id: "workspace-unit",
      units: [
        "packages/bakery/glaze.test.ts",
        "packages/bakery/rest.test.ts",
        "packages/bakery/knead.test.ts",
      ],
    });
    const manifest = manifestOf([
      { unit: "packages/bakery/glaze.test.ts", cost: 7 },
    ]);
    const seen = census([wide], manifest, new Set());
    expect(
      seen.manifest.entries.filter((entry) =>
        entry.unit !== "packages/bakery/glaze.test.ts"
      ).map((entry) => entry.cost),
    ).toEqual([7, 7]);
  });

  it("replaces what the publisher's own tree said, and its packing", () => {
    const published = manifestOf([{ unit: "packages/bakery/glaze.test.ts" }]);
    published.unavailable = [{
      suite: "workspace-unit",
      unit: "packages/bakery/somewhere-else.test.ts",
      reason: "unavailable in the tree the publisher read",
    }];
    published.lanes = [{ lane: 1, projectedSeconds: 12, batches: [] }];
    published.unschedulable = [{
      test: { k: "unit", s: "bakery", n: "gone > entirely" },
      suite: "workspace-unit",
      cost: 900,
    }];
    const seen = census([bakery], published, new Set());
    expect(seen.manifest.unavailable.map((entry) => entry.unit))
      .toEqual(["packages/bakery/gone.test.ts"]);
    // A packing over a corpus this is not answers a different question.
    expect(seen.manifest.lanes).toEqual([]);
    expect(seen.manifest.unschedulable).toEqual([]);
    // What the store has seen is the store's figure, not this tree's.
    expect(seen.manifest.known).toEqual(published.known);
    expect(seen.manifest.calibration).toEqual(published.calibration);
    expect(seen.manifest.seed).toBe(published.seed);
  });

  it("charges a suite with nothing measured the unmeasured figure", () => {
    const seen = census([bakery], undefined, new Set());
    expect(seen.manifest.entries.map((entry) => entry.cost))
      .toEqual([UNMEASURED_COST_SECONDS, UNMEASURED_COST_SECONDS]);
  });
});

describe("an entry whose unit its suite has re-grained", () => {
  // A suite that splits one unit into many leaves every entry it
  // published naming the unit that is gone. Read as stored, the history
  // covers nothing and each unit that replaced it is charged as new.

  const split = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
    locate: (record) =>
      record.test.n.startsWith("glaze")
        ? { level: "unit", unit: "packages/bakery/glaze.test.ts" }
        : record.test.n === "the whole bakery"
        ? { level: "suite" }
        : undefined,
  });

  it("reads it against the unit its suite gives it now", () => {
    const before = manifestOf([
      { test: { k: "unit", s: "bakery", n: "glaze > sets" }, unit: "bakery" },
    ]);

    const seen = census([split], before, new Set());

    // Placed, so the unit it belongs to is recorded rather than new, and
    // nothing about it is mandatory.
    expect(seen.manifest.entries.map((entry) => entry.unit).toSorted())
      .toEqual([
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
      ]);
    expect(seen.unmeasured).toBe(1);
    expect(
      seen.manifest.entries.find((entry) =>
        entry.unit === "packages/bakery/glaze.test.ts"
      )?.test.n,
    ).toBe("glaze > sets");
  });

  it("leaves one its suite cannot place where the manifest put it", () => {
    // A suite answering for the suite rather than for a unit, and one
    // answering not at all, each keep the stored unit and drop out with
    // it. Reading the suite can only place an entry the stored value
    // would have lost, never lose one it would have kept.
    const before = manifestOf([
      { test: { k: "unit", s: "bakery", n: "the whole bakery" }, unit: "gone" },
      { test: { k: "unit", s: "bakery", n: "proof > rises" }, unit: "gone" },
    ]);

    const seen = census([split], before, new Set());

    expect(seen.unmeasured).toBe(2);
    expect(
      seen.manifest.entries.every((entry) =>
        entry.test.n.startsWith("unrecorded ")
      ),
    ).toBe(true);
  });
});

describe("what a measured set makes mandatory", () => {
  const measured = suite({
    id: "workspace-unit",
    units: [
      "packages/bakery/glaze.test.ts",
      "packages/bakery/proof.test.ts",
      "packages/cellar/rack.test.ts",
    ],
    measured: [{
      member: "packages/bakery",
      reachedBy: ["packages/bakery/"],
      units: [
        "packages/bakery/glaze.test.ts",
        "packages/bakery/proof.test.ts",
      ],
    }],
  });

  const manifest = manifestOf([
    {
      unit: "packages/bakery/glaze.test.ts",
      test: { k: "unit", s: "bakery", n: "glaze" },
    },
    {
      unit: "packages/bakery/proof.test.ts",
      test: { k: "unit", s: "bakery", n: "proof" },
    },
    {
      unit: "packages/cellar/rack.test.ts",
      test: { k: "unit", s: "bakery", n: "rack" },
    },
  ]);

  it("requires every unit of a set the change reaches", () => {
    const seen = census(
      [measured],
      manifest,
      new Set(["packages/bakery/src/oven.ts"]),
    );
    expect([...seen.mandatory.values()]).toEqual([
      "coverage-gate",
      "coverage-gate",
    ]);
    expect(seen.coverage.sets).toHaveLength(1);
  });

  it("leaves a member the change did not reach alone", () => {
    const seen = census(
      [measured],
      manifest,
      new Set(["packages/bakery/src/oven.ts"]),
    );
    expect(
      seen.mandatory.has(
        testIdentityKey({ k: "unit", s: "bakery", n: "rack" }),
      ),
    ).toBe(false);
  });

  it("says the change touched a test file rather than reached a set", () => {
    // Both hold for a changed test file inside a measured set, and the
    // diff naming the unit outright is the more exact answer.
    const seen = census(
      [measured],
      manifest,
      new Set(["packages/bakery/glaze.test.ts"]),
    );
    expect(
      seen.mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "glaze" }),
      ),
    ).toBe("changed");
    expect(
      seen.mandatory.get(
        testIdentityKey({ k: "unit", s: "bakery", n: "proof" }),
      ),
    ).toBe("coverage-gate");
  });

  it("requires nothing for a change that reaches no set", () => {
    const seen = census([measured], manifest, new Set(["docs/README.md"]));
    expect(seen.mandatory.size).toBe(0);
    expect(seen.coverage.sets).toEqual([]);
  });

  it("requires nothing where the cap turned the gate off", () => {
    const many = suite({
      id: "workspace-unit",
      units: [
        "packages/a/one.test.ts",
        "packages/b/one.test.ts",
        "packages/c/one.test.ts",
      ],
      measured: ["a", "b", "c"].map((name) => ({
        member: `packages/${name}`,
        reachedBy: [`packages/${name}/`],
        units: [`packages/${name}/one.test.ts`],
      })),
    });
    const seen = census(
      [many],
      manifestOf(["a", "b", "c"].map((name) => ({
        unit: `packages/${name}/one.test.ts`,
        test: { k: "unit", s: "bakery", n: name },
      }))),
      new Set(["packages/a/x.ts", "packages/b/x.ts", "packages/c/x.ts"]),
    );
    expect(seen.mandatory.size).toBe(0);
    expect(seen.coverage.off).toBeDefined();
    expect(seen.coverage.reached).toHaveLength(3);
  });
});
