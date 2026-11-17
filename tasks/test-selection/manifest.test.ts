import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AliasResolver,
  parseManifest,
  serializeManifest,
  testIdentityKey,
} from "@commonfabric/test-support/records";

import { dialSnapshot, manifestUnderAliases } from "./manifest.ts";
import { DIALS } from "./policy.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";

describe("manifest", () => {
  describe("dialSnapshot()", () => {
    it("records every dial, so a manifest explains its own behavior", () => {
      expect(Object.keys(dialSnapshot()).sort()).toEqual(
        DIALS.map((dial) => dial.name).sort(),
      );
    });

    it("survives the format's own validator", () => {
      const manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))?.dials).toEqual(
        dialSnapshot(),
      );
    });
  });

  describe("manifestUnderAliases()", () => {
    // The sample manifest was generated on 2026-08-20.
    const moved = new AliasResolver([
      {
        date: "2026-09-01",
        from: { p: "packages/memory" },
        to: { p: "runtime/memory" },
      },
      {
        date: "2026-09-01",
        from: { k: "unit", s: "memory", n: "space > writes" },
        to: { k: "unit", s: "memory", n: "space > commits" },
      },
    ]);

    it("returns the entries, their units, and coverage baselines under the names the aliases give them", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "space > writes" }, {
            unit: "packages/memory/test/space.test.ts",
          }),
        ],
        coverageBaselines: [{
          suite: "workspace-unit",
          member: "packages/memory",
          commit: "c",
          createdAt: "2026-08-20T00:00:00.000Z",
          uncoveredLines: 3,
        }],
      });
      const resolved = manifestUnderAliases(manifest, moved);
      expect(resolved.entries.map(({ test, unit }) => ({ test, unit })))
        .toEqual([{
          test: { k: "unit", s: "memory", n: "space > commits" },
          unit: "runtime/memory/test/space.test.ts",
        }]);
      expect(resolved.coverageBaselines.map(({ member }) => member))
        .toEqual(["runtime/memory"]);
    });

    it("returns every other identity and path the manifest names under the names the aliases give them", () => {
      const writes = { k: "unit", s: "memory", n: "space > writes" };
      const commits = { k: "unit", s: "memory", n: "space > commits" };
      const fit = {
        overhead: 1,
        correction: 1,
        unitHooks: { "packages/memory/test/space.test.ts": 2 },
      };
      const manifest = sampleManifest({
        calibration: {
          setupCost: {},
          prologue: 0,
          suites: { "workspace-unit": { ...fit, unitOverhead: 0 } },
          suitesWithCoverage: { "workspace-unit": { ...fit, unitOverhead: 3 } },
        },
        withheld: [{ test: writes, suite: "workspace-unit", reason: "flaky" }],
        unavailable: [
          {
            suite: "workspace-unit",
            unit: "packages/memory/test/space.test.ts",
            reason: "needs a database",
          },
          {
            suite: "workspace-unit",
            unit: "packages/memory/test/space.test.ts",
            leafName: "packages/memory/test/space.test.ts",
            reason: "needs a database",
          },
        ],
        unschedulable: [{ test: writes, suite: "workspace-unit", cost: 900 }],
        lanes: [{
          lane: 1,
          projectedSeconds: 10,
          batches: [{
            suite: "workspace-unit",
            identities: [testIdentityKey(writes), "not an identity"],
          }],
        }],
      });
      const resolved = manifestUnderAliases(manifest, moved);
      const hooks = { "runtime/memory/test/space.test.ts": 2 };
      expect(resolved.calibration.suites["workspace-unit"]?.unitHooks)
        .toEqual(hooks);
      expect(resolved.calibration.suitesWithCoverage?.["workspace-unit"])
        .toEqual({ ...fit, unitOverhead: 3, unitHooks: hooks });
      expect(resolved.withheld.map(({ test }) => test)).toEqual([commits]);
      expect(resolved.unavailable.map(({ unit, leafName }) => [unit, leafName]))
        .toEqual([
          ["runtime/memory/test/space.test.ts", undefined],
          [
            "runtime/memory/test/space.test.ts",
            "runtime/memory/test/space.test.ts",
          ],
        ]);
      expect(resolved.unavailable[0]).not.toHaveProperty("leafName");
      expect(resolved.unschedulable.map(({ test }) => test)).toEqual([commits]);
      expect(resolved.lanes[0]!.batches[0]!.identities).toEqual([
        testIdentityKey(commits),
        "not an identity",
      ]);
    });

    it("leaves a fit that names no hooks, and a manifest with no coverage fits, as they are", () => {
      const fit = { overhead: 1, correction: 1, unitOverhead: 0 };
      const manifest = sampleManifest({
        calibration: {
          setupCost: {},
          prologue: 0,
          suites: { "workspace-unit": fit },
        },
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "space > writes" }),
        ],
      });
      const resolved = manifestUnderAliases(manifest, moved);
      expect(resolved.calibration).toEqual(manifest.calibration);
      expect(resolved.calibration).not.toHaveProperty("suitesWithCoverage");
    });

    it("returns the entry already under a name over a renamed entry that claims it", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "space > writes" }, {
            cost: 1,
          }),
          sampleEntry({ k: "unit", s: "memory", n: "space > commits" }, {
            cost: 2,
          }),
        ],
      });
      expect(
        manifestUnderAliases(manifest, moved).entries.map(({ cost }) => cost),
      )
        .toEqual([2]);
    });

    it("returns the manifest unchanged where no alias applies before its day", () => {
      const manifest = sampleManifest({
        generatedAt: "2026-09-02T00:00:00.000Z",
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "space > writes" }),
        ],
      });
      expect(manifestUnderAliases(manifest, moved).entries).toEqual(
        manifest.entries,
      );
    });
  });
});
