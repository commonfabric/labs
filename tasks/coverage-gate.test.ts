import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import * as path from "@std/path";
import {
  collectSetReports,
  formatGateReport,
  type GateInput,
  main,
  nearestBaseline,
  nearestOnBranch,
  parseGateArgs,
  publishedBaselines,
  runGate,
} from "./coverage-gate.ts";
import { coverageGateFor } from "./test-selection/coverage.ts";
import type { MeasuredSet, Suite } from "./test-topology/suite.ts";
import type { CoverageBaseline } from "./test-selection/manifest.ts";

/** A suite carrying only what the gate reads. */
function suite(id: string, measured: MeasuredSet[]): Suite {
  return {
    id,
    recordSurfaces: [{ kind: "unit", scope: id }],
    needs: [],
    units: measured.flatMap((set) => set.units),
    unavailable: [],
    whole: [],
    measured,
    locate: () => undefined,
    command: () => Promise.resolve([]),
  };
}

/**
 * A workspace holding one member, whose source is one file of `lines`
 * statements, and the LCOV covering `covered` of them.
 */
async function workspace(
  member: string,
  lines: number,
  covered: number,
): Promise<{ root: string; lcov: string }> {
  const root = await Deno.makeTempDir({ prefix: "coverage-gate-" });
  await Deno.writeTextFile(
    path.join(root, "deno.jsonc"),
    JSON.stringify({ workspace: [`./${member}`] }),
  );
  const dir = path.join(root, member, "src");
  await Deno.mkdir(dir, { recursive: true });
  const file = path.join(dir, "main.ts");
  const body = Array.from(
    { length: lines },
    (_, at) => `const v${at} = ${at};`,
  );
  await Deno.writeTextFile(file, `${body.join("\n")}\n`);
  const records = body.map((_, at) => `DA:${at + 1},${at < covered ? 1 : 0}`);
  const lcov = `SF:${file}\n${records.join("\n")}\nend_of_record\n`;
  return { root, lcov };
}

/** Every field the gate reads, with one report and no acceptance. */
function gateInput(
  over: Partial<GateInput> & Pick<GateInput, "root" | "gate">,
): GateInput {
  return {
    reports: new Map(),
    members: [],
    baselines: [],
    nearest: (commits) => Promise.resolve(commits[0]),
    accepted: new Map(),
    testsFailed: false,
    ...over,
  };
}

/** A set over `member`, and the suites declaring it. */
function bakery(member = "packages/bakery"): {
  suites: Suite[];
  changed: Set<string>;
} {
  return {
    suites: [suite("workspace-unit", [{
      member,
      reachedBy: [`${member}/`],
      units: [`${member}/one.test.ts`],
    }])],
    changed: new Set([`${member}/src/main.ts`]),
  };
}

/** Writes one lane's report for a set, and answers with the reports map. */
async function reportsFor(
  entries: readonly (readonly [string, string])[],
): Promise<{ dir: string; reports: Map<string, string[]> }> {
  const dir = await Deno.makeTempDir({ prefix: "coverage-reports-" });
  for (const [at, lcov] of entries) {
    const full = path.join(dir, at);
    await Deno.mkdir(path.dirname(full), { recursive: true });
    await Deno.writeTextFile(full, lcov);
  }
  return { dir, reports: await collectSetReports(dir) };
}

describe("coverage-gate", () => {
  describe("reading the lanes' reports", () => {
    it("joins the reports several lanes wrote for one set", async () => {
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          "a",
        ],
        [
          "lane-3/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          "b",
        ],
      ]);
      expect(reports.get("workspace-unit/packages__bakery")).toHaveLength(2);
    });

    it("keeps two suites' reports over one member apart", async () => {
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          "a",
        ],
        [
          "lane-1/coverage/lcov/sets/bakery-e2e/packages__bakery/coverage.lcov",
          "b",
        ],
      ]);
      expect([...reports.keys()].sort()).toEqual([
        "bakery-e2e/packages__bakery",
        "workspace-unit/packages__bakery",
      ]);
    });

    it("names a report by the directory the suite wrote it under", async () => {
      // The suite that wrote the directory is the one that names it, so
      // nothing here works a member back out of the name.
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/" +
        "packages__connectors__github/coverage.lcov",
        "a",
      ]]);
      expect([...reports.keys()])
        .toEqual(["workspace-unit/packages__connectors__github"]);
    });

    it("scores a set from the directory its own suite names", async () => {
      const { root, lcov } = await workspace(
        "packages/connectors/github",
        4,
        1,
      );
      const suites = [suite("workspace-unit", [{
        member: "packages/connectors/github",
        reachedBy: ["packages/connectors/github/"],
        units: ["packages/connectors/github/one.test.ts"],
      }])];
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/" +
        "packages__connectors__github/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(
          suites,
          new Set(["packages/connectors/github/src/main.ts"]),
        ),
        reports,
        members: ["packages/connectors/github"],
      }));
      expect(report.verdicts[0]?.uncoveredLines).toBe(3);
    });

    it("passes over a report that is not one of a set's", async () => {
      const { reports } = await reportsFor([
        ["lane-1/coverage/lcov/workspace.lcov", "a"],
        ["lane-1/coverage/lcov/sets/deeper/than/expected/coverage.lcov", "b"],
      ]);
      expect([...reports.keys()]).toEqual([]);
    });

    it("refuses a report directory it cannot walk", async () => {
      // An absent directory is a lane that uploaded nothing, which the
      // gate reports. Anything else is a failure worth ending on.
      const dir = await Deno.makeTempDir({ prefix: "coverage-reports-" });
      const file = path.join(dir, "not-a-directory");
      await Deno.writeTextFile(file, "");
      await expect(collectSetReports(file)).rejects.toThrow();
    });

    it("finds nothing where no lane uploaded anything", async () => {
      const dir = await Deno.makeTempDir({ prefix: "coverage-reports-" });
      expect((await collectSetReports(path.join(dir, "gone"))).size).toBe(0);
    });
  });

  describe("the baseline walk", () => {
    const baselines: CoverageBaseline[] = [
      {
        suite: "workspace-unit",
        member: "packages/bakery",
        commit: "newest",
        createdAt: "2026-09-03T00:00:00.000Z",
        uncoveredLines: 5,
      },
      {
        suite: "workspace-unit",
        member: "packages/bakery",
        commit: "older",
        createdAt: "2026-09-01T00:00:00.000Z",
        uncoveredLines: 9,
      },
      {
        suite: "bakery-e2e",
        member: "packages/bakery",
        commit: "newest",
        createdAt: "2026-09-03T00:00:00.000Z",
        uncoveredLines: 900,
      },
    ];

    /** The nearest of `held`, in that order, among the ones asked about. */
    const onBranch = (...held: string[]) => (commits: readonly string[]) =>
      Promise.resolve(held.find((commit) => commits.includes(commit)));

    it("takes the one the branch holds most recently", async () => {
      const found = await nearestBaseline(
        baselines,
        "workspace-unit",
        "packages/bakery",
        onBranch("newest", "older"),
      );
      expect(found?.commit).toBe("newest");
    });

    it("takes a commit the branch holds over one it does not", async () => {
      const found = await nearestBaseline(
        baselines,
        "workspace-unit",
        "packages/bakery",
        onBranch("older"),
      );
      expect(found?.uncoveredLines).toBe(9);
    });

    it("goes by the branch's history and not by when a run was made", async () => {
      // A re-run of an older commit is created after the run of a newer
      // one. Taking the newer commit is what the branch's own order
      // says, whatever order the runs arrived in.
      const reversed: CoverageBaseline[] = [
        {
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "older",
          createdAt: "2026-09-09T00:00:00.000Z",
          uncoveredLines: 9,
        },
        {
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "newest",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 5,
        },
      ];
      const found = await nearestBaseline(
        reversed,
        "workspace-unit",
        "packages/bakery",
        onBranch("newest", "older"),
      );
      expect(found?.commit).toBe("newest");
    });

    it("finds nothing where the branch holds none of them", async () => {
      expect(
        await nearestBaseline(
          baselines,
          "workspace-unit",
          "packages/bakery",
          () => Promise.resolve(undefined),
        ),
      ).toBeUndefined();
    });

    it("never takes another suite's baseline over the same member", async () => {
      const found = await nearestBaseline(
        baselines,
        "bakery-e2e",
        "packages/bakery",
        onBranch("newest", "older"),
      );
      expect(found?.uncoveredLines).toBe(900);
    });
  });

  describe("the coverage gate", () => {
    it("passes a set that covers as much as the baseline did", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 4,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("passed");
      expect(report.verdicts[0]?.uncoveredLines).toBe(4);
    });

    it("fails a set that covers less than the baseline did", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("rose");
      const lines = formatGateReport(report).join("\n");
      expect(lines).toContain("coverage failure rather than a test failure");
      expect(lines).toContain("ACCEPT_COVERAGE_DEBT: packages/bakery +3 lines");
    });

    it("accepts a rise the description allows", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        accepted: new Map([["packages/bakery", 3]]),
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("accepted");
    });

    it("fails a rise larger than the description allows", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        accepted: new Map([["packages/bakery", 1]]),
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("rose");
    });

    it("reports rather than fails a set with no baseline", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("no-baseline");
    });

    it("reports rather than fails against a tree the branch lacks", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        nearest: () => Promise.resolve(undefined),
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("no-baseline");
    });

    it("reports rather than fails when the run has a failing test", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        testsFailed: true,
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("not-scored");
    });

    it("fails when the report of a forced set names no line of the member", async () => {
      // An empty report is a lane that measured nothing, so a rise in
      // the set cannot be ruled out.
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        "",
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("nothing-measured");
      expect(formatGateReport(report).join("\n"))
        .toContain("no lane's report measured");
    });

    it("scores a forced set one of whose reports names no line of the member", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          lcov,
        ],
        [
          "lane-2/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          "",
        ],
      ]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 4,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts[0]?.outcome).toBe("passed");
      expect(report.verdicts[0]?.uncoveredLines).toBe(4);
    });

    it("fails a forced set whose report names no line of the member in a run with a failing test", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        "",
      ]]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
        testsFailed: true,
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("nothing-measured");
    });

    it("reports rather than fails when the report of an unforced set names no line of the member", async () => {
      // Over the cap nothing is forced, so nothing asked for the set to
      // be measured.
      const { root } = await workspace("packages/bakery", 10, 6);
      const members = ["packages/bakery", "packages/b", "packages/c"];
      const suites = [suite(
        "workspace-unit",
        members.map((member) => ({
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        })),
      )];
      const changed = new Set(members.map((member) => `${member}/src/main.ts`));
      const gate = coverageGateFor(suites, changed);
      expect(gate.sets).toEqual([]);
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
        "",
      ]]);
      const report = await runGate(gateInput({
        root,
        gate,
        reports,
        members: ["packages/bakery"],
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ok).toBe(true);
      expect(
        report.verdicts
          .find((verdict) => verdict.member === "packages/bakery")?.outcome,
      ).toBe("not-forced");
      expect(formatGateReport(report).join("\n"))
        .not.toContain("no lane's report measured");
    });

    it("fails an acceptance that names neither a member nor a group", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        members: ["packages/bakery"],
        accepted: new Map([["packages/bakery/src/oven", 3]]),
      }));
      expect(report.ok).toBe(false);
      expect(report.unknownAcceptances).toEqual(["packages/bakery/src/oven"]);
      expect(formatGateReport(report).join("\n"))
        .toContain("nothing would ever consult them");
    });

    it("leaves an acceptance the other ratchet reads alone", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        members: ["packages/bakery"],
        accepted: new Map([["tasks", 3], ["packages/runner", 4]]),
      }));
      expect(report.unknownAcceptances).toEqual([]);
    });

    it("fails when no lane wrote the report of a forced set", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        members: ["packages/bakery"],
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("no-report");
      expect(formatGateReport(report).join("\n"))
        .toContain("no lane's report measured");
    });

    it("fails a forced set with no report in a run with a failing test", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        members: ["packages/bakery"],
        testsFailed: true,
      }));
      expect(report.ok).toBe(false);
      expect(report.verdicts[0]?.outcome).toBe("no-report");
    });

    it("says the gate did not run when the change is over the cap", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const members = ["packages/a", "packages/b", "packages/c"];
      const suites = [suite(
        "workspace-unit",
        members.map((member) => ({
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        })),
      )];
      const changed = new Set(members.map((member) => `${member}/src/main.ts`));
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
      }));
      expect(report.ran).toBe(false);
      expect(report.ok).toBe(true);
      expect(report.verdicts.map((verdict) => verdict.outcome))
        .toEqual(["not-forced", "not-forced", "not-forced"]);
      expect(formatGateReport(report).join("\n"))
        .toContain("No measured set was forced to run");
    });

    it("scores a set the cap left unforced that a run measured anyway", async () => {
      // A full run measures every set. The cap bounds what a change is
      // made to run, not what a complete measurement may be compared
      // against, so a number already paid for is not thrown away.
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const members = ["packages/bakery", "packages/b", "packages/c"];
      const suites = [suite(
        "workspace-unit",
        members.map((member) => ({
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        })),
      )];
      const changed = new Set(members.map((member) => `${member}/src/main.ts`));
      const gate = coverageGateFor(suites, changed);
      expect(gate.sets).toEqual([]);
      const { reports } = await reportsFor([[
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/" +
        "coverage.lcov",
        lcov,
      ]]);
      const report = await runGate(gateInput({
        root,
        gate,
        reports,
        members: ["packages/bakery"],
        baselines: [{
          suite: "workspace-unit",
          member: "packages/bakery",
          commit: "abc",
          createdAt: "2026-09-01T00:00:00.000Z",
          uncoveredLines: 1,
        }],
      }));
      expect(report.ran).toBe(true);
      expect(report.ok).toBe(false);
      const bakery = report.verdicts
        .find((verdict) => verdict.member === "packages/bakery");
      expect(bakery?.outcome).toBe("rose");
      expect(
        report.verdicts.filter((verdict) => verdict.outcome === "not-forced"),
      ).toHaveLength(2);
    });

    it("scores only the sets the change reached", async () => {
      // A lane may write a report for a member it sampled a few tests
      // from. The gate scores from the declarations, so such a report is
      // not one of its numbers.
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/" +
          "coverage.lcov",
          lcov,
        ],
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__cellar/" +
          "coverage.lcov",
          lcov,
        ],
      ]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
      }));
      expect(report.verdicts.map((verdict) => verdict.set))
        .toEqual(["workspace-unit/packages/bakery"]);
    });

    it("says there is nothing to compare when the change reaches no set", async () => {
      const { root } = await workspace("packages/bakery", 10, 6);
      const { suites } = bakery();
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, new Set(["docs/README.md"])),
      }));
      expect(report.ran).toBe(false);
      expect(formatGateReport(report).join("\n"))
        .toContain("reaches no measured set");
    });

    it("adds up what several lanes measured for one set", async () => {
      const { root } = await workspace("packages/bakery", 4, 0);
      const file = path.join(root, "packages/bakery/src/main.ts");
      // Two lanes ran different halves of the set, so a line either of them
      // covered is covered.
      const first =
        `SF:${file}\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,0\nend_of_record\n`;
      const second =
        `SF:${file}\nDA:1,0\nDA:2,1\nDA:3,0\nDA:4,0\nend_of_record\n`;
      const { suites, changed } = bakery();
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          first,
        ],
        [
          "lane-2/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          second,
        ],
      ]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, changed),
        reports,
        members: ["packages/bakery"],
      }));
      expect(report.verdicts[0]?.uncoveredLines).toBe(2);
    });
  });

  describe("asking git what the branch contains", () => {
    const roots: string[] = [];

    // Each fixture here builds a repository of its own, and the largest of
    // them is a megabyte of git objects.
    afterEach(async () => {
      for (const root of roots.splice(0)) {
        await Deno.remove(root, { recursive: true });
      }
    });

    /** A directory for a repository, removed once the case has run. */
    async function temporaryRoot(prefix: string): Promise<string> {
      const root = await Deno.makeTempDir({ prefix });
      roots.push(root);
      return root;
    }

    /**
     * Runs git in `root` under `env`, returning what it wrote to its output
     * stream. The variables given are added to the ones this process holds.
     */
    function gitIn(
      root: string,
      env: Record<string, string> = {},
    ): (...args: string[]) => Promise<string> {
      return async (...args: string[]) => {
        const result = await new Deno.Command("git", {
          args,
          cwd: root,
          env,
          stdout: "piped",
          stderr: "piped",
        }).output();
        return new TextDecoder().decode(result.stdout).trim();
      };
    }

    /** A repository with two commits on one branch and one beside it. */
    async function repository(): Promise<
      { root: string; contained: string; newer: string; apart: string }
    > {
      const root = await temporaryRoot("coverage-gate-git-");
      const git = gitIn(root);
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "tests@example.com");
      await git("config", "user.name", "Tests");
      await Deno.writeTextFile(path.join(root, "one.txt"), "one");
      await git("add", "-A");
      await git("commit", "-qm", "one");
      const contained = await git("rev-parse", "HEAD");
      await Deno.writeTextFile(path.join(root, "two.txt"), "two");
      await git("add", "-A");
      await git("commit", "-qm", "two");
      const newer = await git("rev-parse", "HEAD");
      await git("checkout", "-q", "-b", "apart");
      await Deno.writeTextFile(path.join(root, "three.txt"), "three");
      await git("add", "-A");
      await git("commit", "-qm", "three");
      const apart = await git("rev-parse", "HEAD");
      await git("checkout", "-q", "main");
      return { root, contained, newer, apart };
    }

    /**
     * A repository whose history is longer than one read of `git rev-list`,
     * with the commits at either end of it. `git fast-import` builds the whole
     * of it in one pass.
     */
    async function longHistory(): Promise<
      { root: string; tip: string; oldest: string }
    > {
      // A commit identifier and the newline after it take 41 bytes, and a
      // pipe holds at most 64 KiB. Four times that leaves the history longer
      // than the read the walk takes plus whatever git buffers behind it.
      const commits = Math.ceil((4 * 64 * 1024) / 41);
      const root = await temporaryRoot("coverage-gate-long-");
      const git = gitIn(root);
      await git("init", "-q", "-b", "main");
      const stream: string[] = [];
      for (let index = 0; index < commits; index++) {
        const message = `commit ${index}`;
        stream.push(
          "commit refs/heads/main",
          `committer Tests <tests@example.com> ${index} +0000`,
          `data ${message.length}`,
          message,
        );
      }
      stream.push("done", "");
      const child = new Deno.Command("git", {
        args: ["fast-import", "--quiet", "--done"],
        cwd: root,
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const complaints = new Response(child.stderr).text();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stream.join("\n")));
      await writer.close();
      const built = await child.status;
      if (!built.success) {
        throw new Error(`git fast-import: ${await complaints}`);
      }
      const length = await git("rev-list", "--count", "HEAD");
      if (length !== String(commits)) {
        throw new Error(`history is ${length} commits, not ${commits}`);
      }
      return {
        root,
        tip: await git("rev-parse", "HEAD"),
        oldest: await git("rev-list", "--max-parents=0", "HEAD"),
      };
    }

    /**
     * A repository holding a commit whose own descendant carries an older
     * date, reachable through a merge, and both of those commits.
     */
    async function datedHistory(): Promise<
      { root: string; ancestor: string; descendant: string }
    > {
      const root = await temporaryRoot("coverage-gate-dates-");
      const git = gitIn(root);
      const at = (when: number) => ({
        GIT_AUTHOR_DATE: `@${when} +0000`,
        GIT_COMMITTER_DATE: `@${when} +0000`,
      });
      const commit = async (name: string, when: number) => {
        await Deno.writeTextFile(path.join(root, `${name}.txt`), name);
        await git("add", "-A");
        await gitIn(root, at(when))("commit", "-qm", name);
        return await git("rev-parse", "HEAD");
      };
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "tests@example.com");
      await git("config", "user.name", "Tests");
      const ancestor = await commit("one", 500);
      await git("checkout", "-q", "-b", "beside");
      const descendant = await commit("two", 300);
      await git("checkout", "-q", "main");
      await commit("three", 900);
      await gitIn(root, at(1500))(
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "four",
        "beside",
      );
      return { root, ancestor, descendant };
    }

    it("names a commit the tree under test descends from", async () => {
      const { root, contained } = await repository();
      expect(await nearestOnBranch(root)([contained])).toBe(contained);
    });

    it("takes the commit further down the branch's own history", async () => {
      // Both are on the branch, and the newer one is the answer whatever
      // order they are offered in.
      const { root, contained, newer } = await repository();
      expect(await nearestOnBranch(root)([contained, newer])).toBe(newer);
      expect(await nearestOnBranch(root)([newer, contained])).toBe(newer);
    });

    it("takes the commit further down the branch when its date is older", async () => {
      // A merge puts a commit and its own descendant in the list at once,
      // and the descendant here is the older of the two by date.

      const { root, ancestor, descendant } = await datedHistory();
      expect(await nearestOnBranch(root)([ancestor, descendant]))
        .toBe(descendant);
    });

    it("passes over a commit on a branch beside it", async () => {
      const { root, apart, contained } = await repository();
      expect(await nearestOnBranch(root)([apart])).toBeUndefined();
      expect(await nearestOnBranch(root)([apart, contained]))
        .toBe(contained);
    });

    it("names nothing for a commit the checkout does not hold", async () => {
      // A checkout too shallow to answer reports every set as having no
      // baseline rather than failing anything.
      const { root } = await repository();
      expect(await nearestOnBranch(root)(["0".repeat(40)])).toBeUndefined();
    });

    it("names nothing when asked about no commits at all", async () => {
      const { root } = await repository();
      expect(await nearestOnBranch(root)([])).toBeUndefined();
    });

    it("names a commit at the tip of a history longer than one read", async () => {
      // The answer is the first line git writes, and the rest of a history
      // this long is still to come when the walk stops reading. Closing the
      // read is what ends git.

      const { root, tip } = await longHistory();
      expect(await nearestOnBranch(root)([tip])).toBe(tip);
    });

    it("names a commit at the root of a history longer than one read", async () => {
      // The answer is the last identifier git writes, so the walk has to
      // read the list out across every chunk it arrives in.

      const { root, oldest } = await longHistory();
      expect(await nearestOnBranch(root)([oldest])).toBe(oldest);
    });
  });

  describe("running the gate the way the job runs it", () => {
    /**
     * A repository holding one member whose source is `lines` statements,
     * a commit on the branch, and a report covering `covered` of them.
     */
    async function job(lines: number, covered: number): Promise<
      { root: string; commit: string; reports: string; suites: Suite[] }
    > {
      const root = await Deno.makeTempDir({ prefix: "coverage-gate-job-" });
      const member = "packages/bakery";
      await Deno.writeTextFile(
        path.join(root, "deno.jsonc"),
        JSON.stringify({ workspace: [`./${member}`] }),
      );
      const dir = path.join(root, member, "src");
      await Deno.mkdir(dir, { recursive: true });
      const file = path.join(dir, "main.ts");
      const body = Array.from(
        { length: lines },
        (_, at) => `const v${at} = ${at};`,
      );
      await Deno.writeTextFile(file, `${body.join("\n")}\n`);
      const git = async (...args: string[]) => {
        const result = await new Deno.Command("git", {
          args,
          cwd: root,
          stdout: "piped",
          stderr: "piped",
        }).output();
        return new TextDecoder().decode(result.stdout).trim();
      };
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "tests@example.com");
      await git("config", "user.name", "Tests");
      await git("add", "-A");
      await git("commit", "-qm", "one");
      const commit = await git("rev-parse", "HEAD");
      // The change the gate measures: a second commit touching the
      // member's tree, which is what reaches its set. A test file, so
      // that what the member is scored over does not move with it.
      await Deno.writeTextFile(
        path.join(root, member, "one.test.ts"),
        "// the change under test\n",
      );
      await git("add", "-A");
      await git("commit", "-qm", "two");

      const records = body.map((_, at) =>
        `DA:${at + 1},${at < covered ? 1 : 0}`
      );
      const reports = path.join(root, "artifacts");
      const at = path.join(
        reports,
        "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery",
      );
      await Deno.mkdir(at, { recursive: true });
      await Deno.writeTextFile(
        path.join(at, "coverage.lcov"),
        `SF:${file}\n${records.join("\n")}\nend_of_record\n`,
      );
      return {
        root,
        commit,
        reports,
        suites: [suite("workspace-unit", [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        }])],
      };
    }

    it("passes, and says what it compared", async () => {
      const { root, commit, reports, suites } = await job(10, 6);
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      let status: number;
      try {
        status = await main(
          ["--base", "HEAD~1", "--reports", reports],
          root,
          {
            topology: () => Promise.resolve(suites),
            baselines: () =>
              Promise.resolve([{
                suite: "workspace-unit",
                member: "packages/bakery",
                commit,
                createdAt: "2026-09-01T00:00:00.000Z",
                uncoveredLines: 4,
              }]),
          },
        );
      } finally {
        console.log = log;
      }
      expect(status).toBe(0);
      const said = lines.join("\n");
      expect(said).toContain("workspace-unit/packages/bakery");
      expect(said).toContain("no rise");
    });

    it("fails a rise, and prints the marker that accepts it", async () => {
      const { root, commit, reports, suites } = await job(10, 6);
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      let status: number;
      try {
        status = await main(
          ["--base", "HEAD~1", "--reports", reports],
          root,
          {
            topology: () => Promise.resolve(suites),
            baselines: () =>
              Promise.resolve([{
                suite: "workspace-unit",
                member: "packages/bakery",
                commit,
                createdAt: "2026-09-01T00:00:00.000Z",
                uncoveredLines: 1,
              }]),
          },
        );
      } finally {
        console.log = log;
      }
      expect(status).toBe(1);
      expect(lines.join("\n"))
        .toContain("ACCEPT_COVERAGE_DEBT: packages/bakery +3 lines");
    });

    it("takes the acceptance from the description", async () => {
      const { root, commit, reports, suites } = await job(10, 6);
      const log = console.log;
      console.log = () => {};
      let status: number;
      try {
        status = await main(
          [
            "--base",
            "HEAD~1",
            "--reports",
            reports,
            "--body",
            "ACCEPT_COVERAGE_DEBT: packages/bakery +3 lines",
          ],
          root,
          {
            topology: () => Promise.resolve(suites),
            baselines: () =>
              Promise.resolve([{
                suite: "workspace-unit",
                member: "packages/bakery",
                commit,
                createdAt: "2026-09-01T00:00:00.000Z",
                uncoveredLines: 1,
              }]),
          },
        );
      } finally {
        console.log = log;
      }
      expect(status).toBe(0);
    });

    it("stops on a marker it cannot read", async () => {
      const { root, reports, suites } = await job(10, 6);
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      let status: number;
      try {
        status = await main(
          [
            "--base",
            "HEAD~1",
            "--reports",
            reports,
            "--body",
            "ACCEPT_COVERAGE_DEBT: packages/bakery 3 lines",
          ],
          root,
          {
            topology: () => Promise.resolve(suites),
            baselines: () => Promise.resolve([]),
          },
        );
      } finally {
        console.log = log;
      }
      expect(status).toBe(1);
      expect(lines.join("\n")).toContain("ACCEPT_COVERAGE_DEBT");
    });

    it("writes what it says into the job's summary", async () => {
      const { root, reports, suites } = await job(10, 6);
      const summary = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", summary);
      const log = console.log;
      console.log = () => {};
      try {
        await main(["--base", "HEAD~1", "--reports", reports], root, {
          topology: () => Promise.resolve(suites),
          baselines: () => Promise.resolve([]),
        });
      } finally {
        console.log = log;
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
      }
      expect(await Deno.readTextFile(summary))
        .toContain("workspace-unit/packages/bakery");
      await Deno.remove(summary);
    });

    it("refuses a command line it cannot read", async () => {
      const { root } = await job(10, 6);
      const error = console.error;
      console.error = () => {};
      try {
        expect(await main([], root, {})).toBe(2);
      } finally {
        console.error = error;
      }
    });
  });

  describe("the baselines a manifest carries", () => {
    it("reads none where there is no manifest to read", async () => {
      // A set with no baseline is reported rather than failed, so a
      // store that cannot be reached costs the gate its opinion alone.
      const empty: typeof globalThis.fetch = () =>
        Promise.resolve(
          new Response(
            '<?xml version="1.0"?><ListBucketResult></ListBucketResult>',
            { status: 200 },
          ),
        );
      expect(await publishedBaselines("2026-09-10T00:00:00.000Z", empty))
        .toEqual([]);
    });
  });

  describe("the gate's command line", () => {
    it("refuses a command line with no base to measure against", () => {
      // With no diff the gate reaches no set and passes, which reads the
      // same as a change that touched nothing, so a workflow that lost the
      // flag would pass every pull request in silence.
      expect(parseGateArgs([], "/tmp/root")).toBeUndefined();
    });

    it("defaults to the artifact directory and a passing run", () => {
      const options = parseGateArgs(["--base", "origin/main"], "/tmp/root");
      expect(options?.reports).toBe("coverage-artifacts");
      expect(options?.testsFailed).toBe(false);
      expect(options?.body).toBe("");
    });

    it("takes the base, the reports, the body, and the failure flag", () => {
      const options = parseGateArgs([
        "--base",
        "origin/main",
        "--reports",
        "downloaded",
        "--body",
        "ACCEPT_COVERAGE_DEBT: packages/bakery +3 lines",
        "--tests-failed",
      ], "/tmp/root");
      expect(options?.base).toBe("origin/main");
      expect(options?.reports).toBe("downloaded");
      expect(options?.body).toContain("ACCEPT_COVERAGE_DEBT");
      expect(options?.testsFailed).toBe(true);
    });

    it("refuses a flag it does not know, and one with no value", () => {
      expect(parseGateArgs(["--nonsense", "x"], "/tmp/root")).toBeUndefined();
      expect(parseGateArgs(["--base"], "/tmp/root")).toBeUndefined();
    });
  });

  describe("what the summary offers to paste", () => {
    it("offers one acceptance per member, at the larger of its rises", async () => {
      // The marker names the member, so two sets over one member that both
      // rose take one line, and the line has to cover the larger rise.
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const member = "packages/bakery";
      const suites = [
        suite("workspace-unit", [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        }]),
        suite("bakery-e2e", [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/two.test.ts`],
        }]),
      ];
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          lcov,
        ],
        [
          "lane-1/coverage/lcov/sets/bakery-e2e/packages__bakery/coverage.lcov",
          lcov,
        ],
      ]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, new Set([`${member}/src/main.ts`])),
        reports,
        members: [member],
        baselines: [
          {
            suite: "workspace-unit",
            member,
            commit: "abc",
            createdAt: "2026-09-01T00:00:00.000Z",
            uncoveredLines: 3,
          },
          {
            suite: "bakery-e2e",
            member,
            commit: "abc",
            createdAt: "2026-09-01T00:00:00.000Z",
            uncoveredLines: 1,
          },
        ],
      }));
      expect(report.ok).toBe(false);
      const offered = formatGateReport(report)
        .filter((line) => line.startsWith("ACCEPT_COVERAGE_DEBT:"));
      expect(offered).toEqual([
        "ACCEPT_COVERAGE_DEBT: packages/bakery +3 lines",
      ]);
    });

    it("accepts both sets over one member from one marker", async () => {
      const { root, lcov } = await workspace("packages/bakery", 10, 6);
      const member = "packages/bakery";
      const suites = [
        suite("workspace-unit", [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        }]),
        suite("bakery-e2e", [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/two.test.ts`],
        }]),
      ];
      const { reports } = await reportsFor([
        [
          "lane-1/coverage/lcov/sets/workspace-unit/packages__bakery/coverage.lcov",
          lcov,
        ],
        [
          "lane-1/coverage/lcov/sets/bakery-e2e/packages__bakery/coverage.lcov",
          lcov,
        ],
      ]);
      const report = await runGate(gateInput({
        root,
        gate: coverageGateFor(suites, new Set([`${member}/src/main.ts`])),
        reports,
        members: [member],
        accepted: new Map([[member, 3]]),
        baselines: [
          {
            suite: "workspace-unit",
            member,
            commit: "abc",
            createdAt: "2026-09-01T00:00:00.000Z",
            uncoveredLines: 3,
          },
          {
            suite: "bakery-e2e",
            member,
            commit: "abc",
            createdAt: "2026-09-01T00:00:00.000Z",
            uncoveredLines: 1,
          },
        ],
      }));
      expect(report.ok).toBe(true);
      expect(report.verdicts.map((verdict) => verdict.outcome))
        .toEqual(["accepted", "accepted"]);
    });
  });
});
