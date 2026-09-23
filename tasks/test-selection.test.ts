import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  coverageLines,
  dialLines,
  dispatch,
  explainLines,
  gatedMembers,
  laneArgument,
  parseIdentityArgument,
  planLines,
  type Sources,
  Stop,
  verdictFor,
} from "./test-selection.ts";
import type { TestIdentity } from "@commonfabric/test-support/records";
import {
  freeCalibration,
  sampleEntry,
  sampleManifest,
} from "./test-selection/testing.ts";
import type { ManifestEntry } from "./test-selection/manifest.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  DIALS,
  dialValue,
  EXCLUDED_FROM_COVERAGE_GATE,
  LANES,
} from "./test-selection/policy.ts";

const TEST = { k: "unit", s: "memory", n: "space > writes" };

/**
 * One suite enumerating exactly these units. The manifest fixtures put
 * their entries under `workspace-unit`, so a topology naming that suite
 * is what the two are compared through.
 */
function suiteHolding(units: readonly string[]): Suite {
  return {
    id: "workspace-unit",
    recordSurfaces: [{ kind: "unit", scope: "memory" }],
    needs: ["deno"],
    units: [...units],
    unavailable: [],
    whole: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
  };
}

const TOPOLOGY: Suite[] = [
  {
    ...suiteHolding(["packages/memory/test/memory.test.ts"]),
    measured: [{
      member: "packages/memory",
      reachedBy: ["packages/memory/"],
      units: ["packages/memory/test/memory.test.ts"],
    }],
  },
];

describe("test-selection", () => {
  describe("parseIdentityArgument()", () => {
    it("takes the three-part key and the four-part one", () => {
      expect(parseIdentityArgument('["unit","memory","a"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
      });
      expect(parseIdentityArgument('["unit","memory","a","on"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
        v: "on",
      });
    });

    it("refuses anything that is not an identity", () => {
      // An empty part is what the manifest validator refuses too, so
      // accepting one here would report a test as unknown and mandatory
      // when the argument was the problem.
      for (
        const argument of [
          "not json",
          "{}",
          '["unit","memory"]',
          '["unit","memory","a","on","extra"]',
          '["","memory","a"]',
          '["unit","","a"]',
          '["unit","memory",""]',
          '["unit","memory","a",""]',
          '["unit","memory",7]',
        ]
      ) {
        expect(parseIdentityArgument(argument)).toBeUndefined();
      }
    });
  });

  describe("explainLines()", () => {
    const manifest = () =>
      sampleManifest({ entries: [sampleEntry(TEST, { cost: 2, score: 0.4 })] });

    it("says an identity with no records is mandatory", () => {
      const lines = explainLines(manifest(), { ...TEST, n: "never seen" });
      expect(lines.join("\n")).toContain(
        "An available unit no manifest knows is mandatory",
      );
    });

    it("says what does not run rather than only what does", () => {
      // The name reaches the same branch a new test's does, and nothing
      // in an identity tells any of them apart, so the answer has to
      // cover them all rather than assert one for every case. A unit a
      // configuration declares unavailable gets no stand-in, so nothing
      // in it is mandatory either.
      const lines = explainLines(manifest(), { ...TEST, n: "never seen" });
      expect(lines.join("\n")).toContain(
        "Nothing runs a test the tree no longer holds",
      );
      expect(lines.join("\n")).toContain("declares unavailable");
    });

    it("does not claim the store or the tree holds nothing for it", () => {
      // The store holds every record it ever took, and the tree holds
      // every identity whose records do not say which unit they are in.
      // What has no entry is the manifest.
      const lines = explainLines(manifest(), { ...TEST, n: "never seen" });
      expect(lines.join("\n")).toContain("The manifest has no entry for it");
    });

    it("prints the catches behind a score", () => {
      const held = manifest();
      held.entries[0]!.inputs = {
        catches: 3,
        sources: 2,
        churn: 0.5,
        lastCatch: "2026-08-20",
      };
      const text = explainLines(held, TEST, { selected: true }).join("\n");
      expect(text).toContain("3.0 weighted catches");
      expect(text).toContain("2 sources");
      expect(text).toContain("2026-08-20");
      expect(text).toContain("selects it");
    });

    it("says a test has never caught anything", () => {
      expect(explainLines(manifest(), TEST).join("\n")).toContain(
        "never caught anything",
      );
    });

    it("says why an identity was withheld", () => {
      const held = manifest();
      held.withheld = [{
        test: TEST,
        suite: "workspace-unit",
        reason: "flaky",
      }];
      expect(explainLines(held, TEST).join("\n")).toContain(
        "too flaky to judge a change by",
      );
    });

    it("says how many runs a withheld identity a change reaches gets", () => {
      // The three answers do not partition: a withheld identity the
      // change reaches is selected, and has a repeat count like any
      // other.
      const held = manifest();
      held.withheld = [{
        test: TEST,
        suite: "workspace-unit",
        reason: "flaky",
      }];
      const text = explainLines(held, TEST, { selected: true, repeats: 3 })
        .join("\n");
      expect(text).toContain("withheld");
      expect(text).toContain("run 3 times");
      expect(text).toContain("the current manifest selects it");
      // And nothing that contradicts the line above it: a change that
      // reaches a withheld test runs it here.
      expect(text).not.toContain("not here");
    });

    it("reports the repeat count the packing settled on", () => {
      const held = manifest();
      held.entries[0]!.repeats = 3;
      const text = explainLines(held, TEST, { selected: true, repeats: 2 })
        .join("\n");
      expect(text).toContain("run 2 times");
    });

    it("separates a test no lane can hold from one the budget missed", () => {
      const held = manifest();
      expect(
        explainLines(held, TEST, { selected: false, unschedulable: true })
          .join("\n"),
      ).toContain("no lane can hold it");
      expect(explainLines(held, TEST, { selected: false }).join("\n"))
        .toContain(
          "does not reach it",
        );
    });
  });

  describe("dialLines()", () => {
    it("prints every dial with its value, unit, source, and reason", () => {
      // Three lines per dial, in `DIALS` order: the name with its value,
      // the reason to move it, and a blank line.

      const lines = dialLines();
      DIALS.forEach((dial, index) => {
        expect(lines[index * 3]).toContain(dial.name);
        expect(lines[index * 3]).toContain(
          `${dialValue(dial)} ${dial.unit} (${dial.setBy})`,
        );
        expect(lines[index * 3 + 1]).toContain(dial.why);
      });
    });

    it("says a dial that is off is off rather than printing nothing", () => {
      expect(dialLines().join("\n")).toContain("off");
    });
  });

  describe("planLines()", () => {
    it("summarizes what each lane would run", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "one" }, { cost: 1 }),
          sampleEntry({ k: "unit", s: "memory", n: "two" }, { cost: 1 }),
        ],
      });
      const text = planLines(manifest, TOPOLOGY, undefined).join("\n");
      expect(text).toContain("2 identities in this tree");
      expect(text).toContain(`${LANES} lanes`);
      expect(text).toContain("lane 1:");
    });

    it("counts the corpus the lanes were packed from", () => {
      // The manifest's own entries are not that corpus: one of these
      // names a unit this tree does not have, and no lane can run it.
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "here" }, {
            unit: "packages/memory/test/memory.test.ts",
          }),
          sampleEntry({ k: "unit", s: "memory", n: "gone" }, {
            unit: "packages/memory/test/deleted.test.ts",
          }),
        ],
      });
      const text = planLines(manifest, TOPOLOGY, undefined).join("\n");
      expect(text).toContain("1 identities in this tree");
    });

    it("prints one lane when asked for one", () => {
      const manifest = sampleManifest({
        entries: [sampleEntry({ k: "unit", s: "memory", n: "one" })],
      });
      const text = planLines(manifest, TOPOLOGY, 3).join("\n");
      expect(text).toContain("lane 3:");
      expect(text).not.toContain("lane 1:");
    });

    it("names a suite no lane can hold, and not the tests inside it", () => {
      // Every identity of such a suite is past the bound by the suite's
      // charge, so the report names the suite and drops the identities
      // that would otherwise repeat it once each.
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "cheap" }, {
            cost: 0.001,
            unit: "packages/memory/test/memory.test.ts",
          }),
        ],
        calibration: {
          setupCost: {},
          suites: {
            "workspace-unit": { overhead: 400, correction: 1, unitOverhead: 0 },
          },
          prologue: 0,
        },
      });
      const text = planLines(manifest, TOPOLOGY, undefined).join("\n");
      expect(text).toContain(
        "workspace-unit costs 400.0s before it runs anything",
      );
      expect(text).toContain("none of its 1 tests ran");
      expect(text).not.toContain("unschedulable");
    });

    it("names an identity no lane can hold", () => {
      const manifest = sampleManifest({
        entries: [sampleEntry({ k: "unit", s: "memory", n: "huge" }, {
          cost: 10_000,
        })],
      });
      expect(planLines(manifest, TOPOLOGY, undefined).join("\n")).toContain(
        "unschedulable",
      );
    });
  });
});

describe("coverageLines()", () => {
  const workspaceUnit = {
    suite: "workspace-unit",
    set: {
      member: "packages/memory",
      reachedBy: ["packages/memory/"],
      units: ["packages/memory/one.test.ts", "packages/memory/two.test.ts"],
    },
  };

  it("names the baseline a measured set is compared against", () => {
    const manifest = sampleManifest({
      coverageBaselines: [{
        suite: "workspace-unit",
        member: "packages/memory",
        commit: "abcdef0",
        createdAt: "2026-08-20T00:00:00.000Z",
        uncoveredLines: 41,
      }],
    });
    expect(coverageLines(manifest, [workspaceUnit], [])).toEqual([
      "workspace-unit/packages/memory  2 units, against 41 uncovered lines " +
      "at abcdef0",
    ]);
    expect(
      coverageLines(manifest, [{
        suite: "workspace-unit",
        set: { ...workspaceUnit.set, units: ["packages/memory/one.test.ts"] },
      }], [])[0],
    ).toContain("1 unit,");
  });

  it("keeps two sets over one member apart", () => {
    const manifest = sampleManifest({
      coverageBaselines: [
        {
          suite: "workspace-unit",
          member: "packages/memory",
          commit: "abcdef0",
          createdAt: "2026-08-20T00:00:00.000Z",
          uncoveredLines: 41,
        },
        {
          suite: "memory-integration",
          member: "packages/memory",
          commit: "abcdef0",
          createdAt: "2026-08-20T00:00:00.000Z",
          uncoveredLines: 900,
        },
      ],
    });
    const lines = coverageLines(manifest, [
      workspaceUnit,
      { suite: "memory-integration", set: workspaceUnit.set },
    ], []);
    expect(lines[0]).toContain("41 uncovered lines");
    expect(lines[1]).toContain("900 uncovered lines");
  });

  it("says so when a set has no baseline yet", () => {
    const lines = coverageLines(sampleManifest(), [workspaceUnit], []);
    expect(lines).toEqual([
      "workspace-unit/packages/memory  2 units, against no baseline yet",
    ]);
  });

  it("gives the reason for a member that carries no set", () => {
    const member = [...EXCLUDED_FROM_COVERAGE_GATE.keys()][0]!;
    const lines = coverageLines(sampleManifest(), [], [member]);
    expect(lines[0]).toContain("no measured set: ");
    expect(lines[0]).toContain(EXCLUDED_FROM_COVERAGE_GATE.get(member)!);
  });

  it("says a member outside the list has no Deno-only tests", () => {
    const lines = coverageLines(sampleManifest(), [], ["packages/nowhere"]);
    expect(lines[0]).toContain("no measured set: it has no Deno-only tests");
  });

  it("leaves a member that carries a set out of the ungated half", () => {
    const lines = coverageLines(
      sampleManifest(),
      [workspaceUnit],
      ["packages/memory"],
    );
    expect(lines).toHaveLength(1);
  });

  it("reads a manifest that is missing the same as one with no baselines", () => {
    expect(coverageLines(undefined, [workspaceUnit], ["packages/runner"]))
      .toEqual(
        coverageLines(sampleManifest(), [workspaceUnit], ["packages/runner"]),
      );
  });

  it("pads every name to one width, so the column lines up", () => {
    const lines = coverageLines(undefined, [], [
      "packages/a",
      "packages/longer",
    ]);
    const at = lines.map((line) => line.indexOf("no measured set"));
    expect(at[0]).toBe(at[1]);
  });
});

describe("laneArgument()", () => {
  it("is nothing at all when the flag is absent", () => {
    expect(laneArgument(["plan", "--dry-run"])).toBeUndefined();
  });

  it("takes a lane inside the range", () => {
    expect(laneArgument(["plan", "--lane", "1"])).toBe(1);
    expect(laneArgument(["plan", "--lane", String(LANES)])).toBe(LANES);
  });

  it("rejects a lane outside the range, at either end", () => {
    expect(laneArgument(["plan", "--lane", "0"])).toBe("invalid");
    expect(laneArgument(["plan", "--lane", String(LANES + 1)])).toBe("invalid");
  });

  it("rejects what is not a whole number, including a missing value", () => {
    for (const value of ["1.5", "two", "", "-1"]) {
      expect(laneArgument(["plan", "--lane", value])).toBe("invalid");
    }
    expect(laneArgument(["plan", "--lane"])).toBe("invalid");
  });
});

describe("verdictFor()", () => {
  const entry = (name: string, seconds: number) =>
    sampleEntry({ k: "unit", s: "memory", n: name }, { cost: seconds });
  const manifestOf = (...entries: ManifestEntry[]) =>
    sampleManifest({ entries, calibration: freeCalibration() });

  it("reports a test the packer takes, and how often it takes it", () => {
    const manifest = sampleManifest({ entries: [entry("cheap", 0.1)] });
    const verdict = verdictFor(manifest, TOPOLOGY, {
      k: "unit",
      s: "memory",
      n: "cheap",
    });
    expect(verdict.selected).toBe(true);
    expect(verdict.repeats).toBeGreaterThanOrEqual(1);
    expect(verdict.unschedulable).toBeUndefined();
  });

  it("carries the cost the bound was compared against", () => {
    const manifest = sampleManifest({
      entries: [sampleEntry({ k: "unit", s: "memory", n: "heavy" }, {
        cost: 200,
        unit: "packages/memory/test/memory.test.ts",
      })],
      calibration: {
        setupCost: {},
        suites: {
          "workspace-unit": { overhead: 400, correction: 1, unitOverhead: 0 },
        },
        prologue: 0,
      },
    });
    const test = { k: "unit", s: "memory", n: "heavy" };
    const verdict = verdictFor(manifest, TOPOLOGY, test);
    expect(verdict.unschedulable).toBe(true);
    expect(verdict.loneSeconds).toBeCloseTo(600, 5);
    // What `explain` prints is that figure, not the entry's own 200: a
    // reader told "200s is past the bound" would go looking for a bound
    // below 200 that does not exist.
    const said = explainLines(manifest, test, verdict).join("\n");
    expect(said).toContain("600.0s is past the bound");
    expect(said).not.toContain("200.0s is past the bound");
  });

  it("reports a test no lane could hold as unschedulable, not selected", () => {
    const verdict = verdictFor(
      manifestOf(entry("enormous", 100_000)),
      TOPOLOGY,
      {
        k: "unit",
        s: "memory",
        n: "enormous",
      },
    );
    expect(verdict.selected).toBe(false);
    expect(verdict.unschedulable).toBe(true);
  });

  it("reports a test the manifest has never heard of as unselected", () => {
    const manifest = manifestOf(entry("cheap", 0.1));
    const verdict = verdictFor(manifest, TOPOLOGY, {
      k: "unit",
      s: "memory",
      n: "absent",
    });
    expect(verdict.selected).toBe(false);
    expect(verdict.repeats).toBeUndefined();
    expect(verdict.unschedulable).toBeUndefined();
  });

  it("hands back the corpus its verdict was reached over", () => {
    // Whatever explains an identity has to explain it against the set
    // the verdict came from. The published manifest is a different set:
    // it names units this tree has dropped and misses units it has
    // gained, so a reader given that one is told there is no record of a
    // test the verdict beside it says a lane runs.
    const manifest = manifestOf(
      sampleEntry({ k: "unit", s: "memory", n: "gone" }, {
        unit: "packages/memory/test/deleted.test.ts",
      }),
    );
    const verdict = verdictFor(manifest, TOPOLOGY, {
      k: "unit",
      s: "memory",
      n: "gone",
    });
    const units = verdict.corpus.entries.map((e) => e.unit);
    expect(units).not.toContain("packages/memory/test/deleted.test.ts");
    expect(units).toContain("packages/memory/test/memory.test.ts");
  });

  it("tells two configurations of one name apart", () => {
    const manifest = manifestOf(
      sampleEntry({ k: "unit", s: "memory", n: "both", v: "on" }, {
        cost: 0.1,
      }),
    );
    expect(
      verdictFor(manifest, TOPOLOGY, {
        k: "unit",
        s: "memory",
        n: "both",
        v: "on",
      })
        .selected,
    ).toBe(true);
    expect(
      verdictFor(manifest, TOPOLOGY, { k: "unit", s: "memory", n: "both" })
        .selected,
    ).toBe(false);
  });
});

describe("gatedMembers()", () => {
  it("is every package in the workspace, and nothing else", async () => {
    const members = await gatedMembers();
    expect(members.length).toBeGreaterThan(10);
    expect(members.every((member) => member.startsWith("packages/"))).toBe(
      true,
    );
    // The workspace file lists members with a leading "./", and the
    // coverage baselines a manifest carries do not.
    expect(members.some((member) => member.startsWith("./"))).toBe(false);
    expect(members).toContain("packages/test-support");
    expect([...members].sort()).toEqual(members);
  });

  it("names members the gate has an opinion about", async () => {
    // Every excluded member is one of these; an exclusion naming
    // something outside the list would never be printed.
    const members = new Set(await gatedMembers());
    for (const excluded of EXCLUDED_FROM_COVERAGE_GATE.keys()) {
      expect(members.has(excluded)).toBe(true);
    }
  });
});

describe("dispatch()", () => {
  /** Everything the dispatch printed, and the code it gave back. */
  async function ran(
    args: readonly string[],
    sources: Partial<Sources> = {},
  ): Promise<{ code: number; out: string; err: string; stop?: Stop }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const warn = console.error;
    console.log = (...parts: unknown[]) => out.push(parts.join(" "));
    console.error = (...parts: unknown[]) => err.push(parts.join(" "));
    try {
      const code = await dispatch(args, {
        manifest: () => Promise.resolve(sampleManifest()),
        members: () => Promise.resolve(["packages/memory"]),
        aliases: () =>
          Promise.resolve({ resolve: (test: TestIdentity) => test }),
        topology: () => Promise.resolve(TOPOLOGY),
        ...sources,
      } as Sources);
      return { code, out: out.join("\n"), err: err.join("\n") };
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      return { code: error.code, out: out.join("\n"), err: "", stop: error };
    } finally {
      console.log = log;
      console.error = warn;
    }
  }

  it("prints the usage for no mode, and for either help flag", async () => {
    for (const args of [[], ["--help"], ["-h"]]) {
      const result = await ran(args);
      expect(result.code).toBe(0);
      expect(result.out).toContain("usage: test-selection");
    }
  });

  it("stops with the usage code on a mode it does not have", async () => {
    const result = await ran(["wat"]);
    expect(result.code).toBe(2);
    expect(result.stop?.message).toContain("unknown mode wat");
  });

  it("prints every dial without reading anything", async () => {
    const result = await ran(["dials"], {
      manifest: () => {
        throw new Error("dials must not read a manifest");
      },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(DIALS[0]!.name);
  });

  it("names the measured sets, and carries on with no manifest", async () => {
    const result = await ran(["coverage"], {
      manifest: () => Promise.resolve(undefined),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("workspace-unit/packages/memory");
    expect(result.out).toContain("no baseline yet");
  });

  it("names a member that carries no set beside the sets", async () => {
    const result = await ran(["coverage"], {
      members: () => Promise.resolve(["packages/memory", "packages/runner"]),
    });
    expect(result.out).toContain("workspace-unit/packages/memory");
    expect(result.out).toContain("no measured set: Its whole set is past");
  });

  it("stops when explain is given no identity, or a bad one", async () => {
    expect((await ran(["explain"])).code).toBe(2);
    const bad = await ran(["explain", "not a key"]);
    expect(bad.code).toBe(2);
    expect(bad.stop?.message).toContain("not an identity key");
  });

  it("explains one test, through the alias file", async () => {
    const asked: TestIdentity[] = [];
    const result = await ran(["explain", '["unit","memory","old name"]'], {
      manifest: () =>
        Promise.resolve(sampleManifest({
          entries: [sampleEntry({ k: "unit", s: "memory", n: "new name" })],
        })),
      aliases: () =>
        Promise.resolve({
          resolve: (test: TestIdentity) => {
            asked.push(test);
            return { ...test, n: "new name" };
          },
        }),
    });
    expect(result.code).toBe(0);
    expect(asked[0]?.n).toBe("old name");
    expect(result.out).toContain("new name");
    expect(result.out).toContain("the current manifest selects it");
  });

  it(
    "reports a missing manifest as a failure, not as an empty answer",
    async () => {
      // Printing nothing and exiting zero reads as "no test would run".
      for (const args of [["explain", '["unit","memory","a"]'], ["plan"]]) {
        const result = await ran(args, {
          manifest: () => Promise.resolve(undefined),
        });
        expect(result.code).toBe(1);
      }
    },
  );

  it("prints the plan, and only the lane asked for", async () => {
    const manifest = sampleManifest({
      entries: Array.from(
        { length: 12 },
        (_, i) =>
          sampleEntry({ k: "unit", s: "memory", n: `case ${i}` }, {
            unit: `packages/memory/test/case-${i}.test.ts`,
          }),
      ),
    });
    const all = await ran(["plan", "--dry-run"], {
      manifest: () => Promise.resolve(manifest),
    });
    expect(all.code).toBe(0);
    expect(all.out.match(/^ {2}lane \d+:/gm)?.length).toBe(LANES);

    const one = await ran(["plan", "--dry-run", "--lane", "2"], {
      manifest: () => Promise.resolve(manifest),
    });
    expect(one.out.match(/^ {2}lane \d+:/gm)?.length).toBe(1);
    expect(one.out).toContain("  lane 2:");
  });

  it("stops on a lane number no lane has", async () => {
    const result = await ran(["plan", "--lane", "9"]);
    expect(result.code).toBe(2);
    expect(result.stop?.message).toContain("whole number from 1 to");
  });

  it("verifies the manifest against the tree", async () => {
    const result = await ran(["plan", "--verify"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("accounts for every unit");
  });

  it("passes over a unit the configuration declares unavailable", async () => {
    // A manifest holding nothing for a test that does not run is the
    // manifest being right, so it is not something to fail on.
    const suite = suiteHolding([
      "packages/memory/test/memory.test.ts",
      "packages/memory/test/skipped.test.ts",
    ]);
    const result = await ran(["plan", "--verify"], {
      topology: () =>
        Promise.resolve([{
          ...suite,
          unavailable: [{
            unit: "packages/memory/test/skipped.test.ts",
            phase: "phase-2",
            reason: "the server-execution arm cannot run it yet",
          }],
        }]),
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("skipped.test.ts");
  });

  it("reports a manifest entry the tree no longer enumerates", async () => {
    // Nothing can be asked to run it, and the packer drops it without a
    // word, so reporting it is the only place it is ever mentioned. It
    // does not fail: a manifest is hours old, so a unit deleted since it
    // was published is expected to linger in it.
    const result = await ran(["plan", "--verify"], {
      topology: () => Promise.resolve([suiteHolding(["packages/memory/x.ts"])]),
    });
    expect(result.out).toContain(
      "no longer enumerates packages/memory/test/memory.test.ts",
    );
  });

  it("fails --verify on a unit the manifest holds nothing for", async () => {
    // Every lane treats such a unit as unknown and therefore mandatory,
    // so a manifest missing many of them is a run that selects nothing
    // and tests everything.
    const result = await ran(["plan", "--verify"], {
      topology: () =>
        Promise.resolve([
          suiteHolding([
            "packages/memory/test/memory.test.ts",
            "unrun.test.ts",
          ]),
        ]),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("no identity for workspace-unit: unrun");
  });
});
