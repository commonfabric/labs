import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AliasResolver,
  parseManifest,
  serializeManifest,
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
