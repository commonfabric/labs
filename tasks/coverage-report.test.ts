import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  type CoverageFigures,
  coverageFiguresOf,
  readSpool,
} from "@commonfabric/test-support/records";
import {
  collectReports,
  main,
  markedSets,
  measuredSetFigures,
  parseReportArgs,
  report,
  type ReportOptions,
  repositoryFigures,
  summarize,
} from "./coverage-report.ts";
import {
  coverageMetricForGroup,
  measuredSetCoverageMetric,
} from "./ci-check-lib.ts";
import type { CoverageDebtMetric } from "./coverage-metrics.ts";
import {
  COMPILE_CACHE_STATE_FILE,
  COVERAGE_FAILURE_MARKER,
  COVERAGE_REPORT_DIR,
  COVERAGE_REPORT_FILE,
} from "./ci-lane.ts";
import { UNLAUNCHED_MEMBERS_FILE } from "./unlaunched-members.ts";
import { loadTopology } from "./test-topology.ts";
import {
  measuredSetDirectory,
  measuredSets,
} from "./test-selection/coverage.ts";

/** The repository the measured-set tests read the workspace from. */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The workspace member those tests write a set report for. */
const MEMBER = "packages/leb128";

/** The suite whose units measure that member. */
const SUITE = "workspace-unit";

/** A directory holding one file per entry, at a path relative to its root. */
async function directoryOf(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "coverage-report-" });
  for (const [at, content] of Object.entries(files)) {
    const file = path.join(root, at);
    await Deno.mkdir(path.dirname(file), { recursive: true });
    await Deno.writeTextFile(file, content);
  }
  return root;
}

/** The rest of a command line, for a run over `root` reading `reports`. */
function optionsFor(root: string, reports: string): ReportOptions {
  return { reports, root };
}

/**
 * Runs `report()` over `reports` with a fresh spool as the run's, and
 * returns the coverage figures it left there alongside its summary, and how
 * many records hold them.
 */
async function reportInto(
  reports: string,
): Promise<{ summary: string; coverage: CoverageFigures; records: number }> {
  const spool = await Deno.makeTempDir({ prefix: "coverage-spool-" });
  try {
    const summary = await report(
      optionsFor(REPOSITORY, reports),
      (name) => name === "CF_TEST_RECORDS_DIR" ? spool : undefined,
    );
    const { records } = await readSpool(spool);
    return {
      summary,
      coverage: coverageFiguresOf(records),
      records: records.length,
    };
  } finally {
    await Deno.remove(spool, { recursive: true });
  }
}

/**
 * A workspace of two members, each holding one source file of one covered
 * line and one uncovered line, and the absolute path of the first file.
 */
async function workspaceOfTwo(): Promise<{ root: string; alpha: string }> {
  const source = ["export const covered = 1;", "export const uncovered = 2;"]
    .join("\n");
  const root = await directoryOf({
    "packages/alpha/src/mod.ts": source,
    "packages/beta/src/mod.ts": source,
  });
  return { root, alpha: path.join(root, "packages/alpha/src/mod.ts") };
}

/**
 * Where a lane writes `MEMBER`'s set report, under the artifact named.
 *
 * The directory comes from the topology rather than from a name written
 * here, because the topology is where the lane that writes one gets it
 * and a second answer could disagree with the first.
 */
async function reportPathIn(lane: string): Promise<string> {
  const ref = measuredSets(await loadTopology(REPOSITORY))
    .find((candidate) =>
      candidate.suite === SUITE && candidate.set.member === MEMBER
    );
  if (ref === undefined) throw new Error(`no ${SUITE} set for ${MEMBER}`);
  return path.join(
    lane,
    COVERAGE_REPORT_DIR,
    measuredSetDirectory(ref),
    COVERAGE_REPORT_FILE,
  );
}

/**
 * Where a lane marks `MEMBER`'s set as measured through a failing test,
 * under the artifact named. Beside the report rather than inside it, and
 * named from the topology for the same reason the report path is.
 */
async function markerPathIn(lane: string): Promise<string> {
  return path.join(
    path.dirname(await reportPathIn(lane)),
    COVERAGE_FAILURE_MARKER,
  );
}

/** The measured-set figures a reports directory yields. */
function setFiguresFrom(
  reports: string,
  unlaunchedMembers: string[] = [],
): Promise<CoverageDebtMetric[]> {
  return measuredSetFigures(optionsFor(REPOSITORY, reports), {
    lcov: [],
    unlaunchedMembers,
    cold: false,
  });
}

describe("coverage-report", () => {
  describe("parseReportArgs()", () => {
    it("returns the defaults for the flags a command line omits", () => {
      expect(parseReportArgs([], "/root")).toEqual({
        reports: "coverage-artifacts",
        root: "/root",
      });
      expect(parseReportArgs(["--reports", "at"], "/root")?.reports)
        .toBe("at");
    });

    it("returns `undefined` for a flag with no value", () => {
      expect(parseReportArgs(["--reports"], "/root")).toBeUndefined();
    });

    it("returns `undefined` for a flag nothing reads", () => {
      expect(parseReportArgs(["--nonsense", "1"], "/root")).toBeUndefined();
    });
  });

  describe("collectReports()", () => {
    it("returns every LCOV report under the directory it is given", async () => {
      const root = await directoryOf({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
        "lane-2/lcov/sets/runner-unit/packages_runner/coverage.lcov":
          "SF:/b.ts\nend_of_record\n",
        "lane-2/notes.txt": "not a report",
      });
      try {
        const reports = await collectReports(root);
        expect(reports.lcov.join("\n")).toContain("SF:/a.ts");
        expect(reports.lcov.join("\n")).toContain("SF:/b.ts");
        expect(reports.lcov.join("\n")).not.toContain("not a report");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns the members every lane's record says it never launched", async () => {
      const root = await directoryOf({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
        [`lane-1/lcov/sets/workspace-unit/packages_memory/${UNLAUNCHED_MEMBERS_FILE}`]:
          "./packages/runner\n",
        [`lane-2/lcov/sets/runner-unit/packages_runner/${UNLAUNCHED_MEMBERS_FILE}`]:
          "./packages/shell\n./packages/runner\n",
      });
      try {
        expect((await collectReports(root)).unlaunchedMembers).toEqual([
          "./packages/runner",
          "./packages/shell",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns the cache warm only where every lane found it restored", async () => {
      // The artifact carries the record at its top, beside `sets`.

      const cold = await directoryOf({
        [`lane-1/lcov/${COMPILE_CACHE_STATE_FILE}`]: "warm\n",
        [`lane-2/lcov/${COMPILE_CACHE_STATE_FILE}`]: "cold\n",
        "lane-3/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
      });
      const warm = await directoryOf({
        [`lane-1/lcov/${COMPILE_CACHE_STATE_FILE}`]: "warm\n",
        [`lane-2/lcov/${COMPILE_CACHE_STATE_FILE}`]: "warm\n",
      });
      try {
        expect((await collectReports(cold)).cold).toBe(true);
        expect((await collectReports(warm)).cold).toBe(false);
      } finally {
        await Deno.remove(cold, { recursive: true });
        await Deno.remove(warm, { recursive: true });
      }
    });

    it("returns the cache cold for a record it cannot read", async () => {
      // Withholding a warm run's figure from a trend costs the trend a
      // point; letting a cold run's through moves the line.

      const root = await directoryOf({
        [`lane-1/lcov/${COMPILE_CACHE_STATE_FILE}`]: "warm\n",
        [`lane-2/lcov/${COMPILE_CACHE_STATE_FILE}`]: "tepid\n",
      });
      try {
        expect((await collectReports(root)).cold).toBe(true);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns the cache not cold where no lane opened it", async () => {
      const root = await directoryOf({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
      });
      try {
        expect((await collectReports(root)).cold).toBe(false);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns nothing for a directory nothing was downloaded into", async () => {
      expect(await collectReports("/nonexistent-coverage-artifacts")).toEqual({
        lcov: [],
        unlaunchedMembers: [],
        cold: false,
      });
    });

    it("throws where the path names a file rather than a directory", async () => {
      // An absent directory is a run whose lanes uploaded nothing. A
      // path that is something other than a directory is a caller
      // pointed at the wrong thing, and reading it as an empty artifact
      // would publish that mistake as a measurement.

      const file = await Deno.makeTempFile({ prefix: "coverage-report-" });
      try {
        await expect(collectReports(file)).rejects.toThrow();
      } finally {
        await Deno.remove(file);
      }
    });
  });

  describe("repositoryFigures()", () => {
    it("returns the workspace total and a figure for each source group", async () => {
      const { root, alpha } = await workspaceOfTwo();
      try {
        // Alpha's second line ran nowhere, and beta has no record at all,
        // so both of its lines are charged.

        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [`SF:${alpha}\nDA:1,1\nDA:2,0\nend_of_record\n`],
            unlaunchedMembers: [],
            cold: false,
          }),
        ).toEqual([
          { name: coverageMetricForGroup("workspace"), uncoveredLines: 3 },
          { name: coverageMetricForGroup("packages/alpha"), uncoveredLines: 1 },
          { name: coverageMetricForGroup("packages/beta"), uncoveredLines: 2 },
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no figure at all where every report is empty", async () => {
      // A lane writes a report for a profile directory whatever that
      // directory holds, so an empty one says a lane got as far as
      // converting rather than that it measured.

      const { root } = await workspaceOfTwo();
      try {
        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: ["TN:\nend_of_record\n"],
            unlaunchedMembers: [],
            cold: false,
          }),
        ).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no figure at all where no lane reported", async () => {
      // Scoring an empty report charges every tracked line as uncovered,
      // which states a measurement the run did not make. The dashboard
      // charts this series, so the spike and the recovery after it would
      // both be invented.

      const { root } = await workspaceOfTwo();
      try {
        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [],
            unlaunchedMembers: [],
            cold: false,
          }),
        ).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no workspace total where a member never launched", async () => {
      // A member no lane started has unknown coverage rather than none,
      // so its group goes unscored and the total that would have held it
      // goes with it.

      const { root, alpha } = await workspaceOfTwo();
      try {
        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [`SF:${alpha}\nDA:1,1\nDA:2,0\nend_of_record\n`],
            unlaunchedMembers: ["./packages/beta"],
            cold: false,
          }),
        ).toEqual([
          { name: coverageMetricForGroup("packages/alpha"), uncoveredLines: 1 },
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("markedSets()", () => {
    it("finds a marker the lane wrote no report beside", async () => {
      // A lane that ran a set's unit and saw it fail may have collected
      // no profile for it, so the marker is walked for by the set's own
      // directory. Another lane's report for that set must still not
      // become the baseline.
      const root = await directoryOf({
        [await reportPathIn("lane-1")]: "SF:/a.ts\nend_of_record\n",
        [await markerPathIn("lane-2")]: `${MEMBER}/one.test.ts\n`,
        "lane-2/notes.txt": "not under the layout at all",
      });
      try {
        const marked = await markedSets(root);
        expect(marked.size).toBe(1);
        expect([...marked][0]).toContain(SUITE);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("marks nothing where nothing was downloaded", async () => {
      expect([...await markedSets("/nonexistent-coverage-artifacts")])
        .toEqual([]);
    });

    it("refuses a reports directory it cannot walk", async () => {
      // An absent directory is a run whose lanes uploaded nothing, which
      // is ordinary. Anything else is a failure worth ending on rather
      // than reading as a run that marked nothing.
      const root = await Deno.makeTempDir({ prefix: "coverage-report-" });
      const at = path.join(root, "not-a-directory");
      await Deno.writeTextFile(at, "");
      try {
        await expect(markedSets(at)).rejects.toThrow();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("measuredSetFigures()", () => {
    it("returns a figure for the set a lane reported and for no other", async () => {
      // Every other set the topology declares went unreported, and a set
      // with no report is left out. The gate reads the newest baseline
      // the branch holds, so leaving it out leaves the previous run's
      // figure standing, where publishing one would tell every later
      // pull request that the member's whole source had gone uncovered.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const root = await directoryOf({
        [await reportPathIn("lane-1")]:
          `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
      });
      try {
        expect((await setFiguresFrom(root)).map((figure) => figure.name))
          .toEqual([measuredSetCoverageMetric(`${SUITE}/${MEMBER}`)]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("publishes nothing for a set a lane measured through a failure", async () => {
      // A run that excused a flaky failure stayed green, and the number
      // is short by whatever the failing test would have reached, so
      // publishing it holds every later pull request to a bar this run
      // did not clear either.
      //
      // The same report is scored both ways round, because the absence
      // on its own would also hold for a set the topology has dropped or
      // a report naming no line of the member.
      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const report = `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`;
      const named = async (marked: boolean) => {
        const root = await directoryOf({
          [await reportPathIn("lane-1")]: report,
          ...(marked
            ? { [await markerPathIn("lane-1")]: `${MEMBER}/one.test.ts\n` }
            : {}),
        });
        try {
          return (await setFiguresFrom(root)).map((figure) => figure.name);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      };
      expect(await named(false)).toEqual([
        measuredSetCoverageMetric(`${SUITE}/${MEMBER}`),
      ]);
      expect(await named(true)).toEqual([]);
    });

    it("returns a figure counting every lane that reported the set", async () => {
      // The packer spreads one set's units over as many lanes as it
      // likes, so a figure taken from one lane's report alone would
      // charge whatever the other lanes covered.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const first = `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`;
      const second = `SF:${source}\nDA:1,0\nDA:2,1\nend_of_record\n`;
      const alone = await directoryOf({
        [await reportPathIn("lane-1")]: first,
      });
      const both = await directoryOf({
        [await reportPathIn("lane-1")]: first,
        [await reportPathIn("lane-2")]: second,
      });
      try {
        const [one] = await setFiguresFrom(alone);
        const [joined] = await setFiguresFrom(both);
        expect(one.uncoveredLines).toBeGreaterThan(0);
        expect(joined.uncoveredLines).toBe(one.uncoveredLines - 1);
      } finally {
        await Deno.remove(alone, { recursive: true });
        await Deno.remove(both, { recursive: true });
      }
    });

    it("returns no figure for a set over a member nothing launched", async () => {
      // A set is compared between runs on the understanding that it ran
      // whole. A run that started only part of the member's tests reaches
      // fewer of its lines, so the figure is above what the set measures,
      // and published it becomes a bar the gate cannot catch a rise past.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const root = await directoryOf({
        [await reportPathIn("lane-1")]:
          `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
      });
      try {
        expect(await setFiguresFrom(root, [`./${MEMBER}`])).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no figure where the report reached none of the member's files", async () => {
      // A report with a record for none of the member's files measured
      // nothing, whatever it says about the lines it does carry, and a
      // baseline from it is one no run of the set stands behind.

      const root = await directoryOf({
        [await reportPathIn("lane-1")]:
          "SF:/elsewhere.ts\nDA:1,1\nend_of_record\n",
      });
      try {
        expect(await setFiguresFrom(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("summarize()", () => {
    it("returns a summary naming the workspace figure", () => {
      const figures: CoverageDebtMetric[] = [
        { name: coverageMetricForGroup("workspace"), uncoveredLines: 12 },
        { name: coverageMetricForGroup("packages/memory"), uncoveredLines: 3 },
      ];
      const summary = summarize(figures);
      expect(summary).toContain("12 uncovered lines");
      expect(summary).toContain("2 figures published");
    });

    it("returns a summary naming the member that withheld the total", () => {
      expect(summarize([], ["./packages/beta"])).toContain(
        "Nothing launched ./packages/beta",
      );
    });

    it("returns a summary saying so where no lane reported", () => {
      expect(summarize([])).toContain("No lane reported coverage");
    });
  });

  describe("report()", () => {
    it("publishes every figure as a measurement in the run's spool", async () => {
      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const reports = await directoryOf({
        [await reportPathIn("lane-1")]:
          `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
      });
      try {
        const { summary, coverage } = await reportInto(reports);
        expect([...coverage.sets.keys()]).toEqual([`${SUITE}/${MEMBER}`]);
        expect(coverage.groups.get("workspace")).toBeGreaterThan(0);
        expect(coverage.groups.get(MEMBER)).toBeGreaterThan(0);
        expect(summary).toContain("uncovered lines");
      } finally {
        await Deno.remove(reports, { recursive: true });
      }
    });

    it("publishes whether the compile byte cache was cold", async () => {
      // The dashboard leaves a cold run out of the repository-wide trend,
      // and reads that from here.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      for (const state of ["cold", "warm"] as const) {
        const reports = await directoryOf({
          [await reportPathIn("lane-1")]:
            `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
          [`lane-1/lcov/${COMPILE_CACHE_STATE_FILE}`]: `${state}\n`,
        });
        try {
          const { coverage } = await reportInto(reports);
          expect(coverage.cold).toBe(state === "cold");
        } finally {
          await Deno.remove(reports, { recursive: true });
        }
      }
    });

    it("publishes nothing where no lane reported", async () => {
      expect((await reportInto("/nonexistent-artifacts")).records).toBe(0);
    });
  });

  describe("main()", () => {
    it("returns zero having published nothing where no lane reported", async () => {
      // The run this reports on has already decided whether it passed.
      // Coverage is a trend on the default branch, so however the
      // figures came out, and however few of them there are, this exits
      // zero.

      const summaryFile = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", summaryFile);
      try {
        const status = await main(
          ["--reports", "/nonexistent-artifacts"],
          REPOSITORY,
        );
        expect(status).toBe(0);
        expect(await Deno.readTextFile(summaryFile)).toContain(
          "No lane reported coverage",
        );
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(summaryFile);
      }
    });

    it("returns two for a command line it cannot read", async () => {
      expect(await main(["--nonsense", "1"], REPOSITORY)).toBe(2);
    });
  });
});
