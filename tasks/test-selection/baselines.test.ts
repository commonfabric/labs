import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type CoverageBaseline,
  coverageRecords,
  type RunContext,
  type StoredReportGroup,
} from "@commonfabric/test-support/records";
import { baselinesOf, mergeBaselines, splitMeasuredSet } from "./baselines.ts";
import { LOCAL_COVERAGE_BASELINE_DAYS } from "./policy.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");

/** A day inside or outside the window, as an ISO moment. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The context the relay composes for a push to `main`, with overrides. */
function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01JEXAMPLEULID0000000000",
    repo: "commonfabric/labs",
    commit: "c1",
    dirty: false,
    branch: "main",
    env: "ci",
    ci: {
      workflowRunId: "7",
      runAttempt: 1,
      workflow: "CI",
      job: "Coverage Check",
      event: "push",
      fork: false,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: daysAgo(1),
    ...overrides,
  };
}

/** One report holding the coverage measurements of `sets` and `groups`. */
function report(
  sets: Record<string, number>,
  at: RunContext = context(),
  groups: Record<string, number> = {},
): StoredReportGroup {
  const records = coverageRecords({
    groups: new Map(Object.entries(groups)),
    sets: new Map(Object.entries(sets)),
    cold: false,
  });
  return { context: at, records };
}

/** A baseline of one set, `days` old. */
function baseline(
  commit: string,
  days: number,
  uncoveredLines: number,
  member = "packages/a",
): CoverageBaseline {
  return {
    suite: "workspace-unit",
    member,
    commit,
    createdAt: daysAgo(days),
    uncoveredLines,
  };
}

describe("baselines", () => {
  describe("naming a measured set", () => {
    it("splits at the first slash, however deep the member sits", () => {
      expect(splitMeasuredSet("workspace-unit/packages/connectors/github"))
        .toEqual({
          suite: "workspace-unit",
          member: "packages/connectors/github",
        });
    });

    it("refuses a name with no member or no suite", () => {
      expect(splitMeasuredSet("workspace-unit")).toBeUndefined();
      expect(splitMeasuredSet("/packages/memory")).toBeUndefined();
      expect(splitMeasuredSet("workspace-unit/")).toBeUndefined();
    });
  });

  describe("baselinesOf()", () => {
    it("returns each measured set of a push to main against its commit", () => {
      expect(
        baselinesOf(
          report({
            "workspace-unit/packages/connectors/github": 12,
            "memory-e2e/packages/memory": 800,
          }),
        ),
      ).toEqual([
        {
          suite: "workspace-unit",
          member: "packages/connectors/github",
          commit: "c1",
          createdAt: daysAgo(1),
          uncoveredLines: 12,
        },
        {
          suite: "memory-e2e",
          member: "packages/memory",
          commit: "c1",
          createdAt: daysAgo(1),
          uncoveredLines: 800,
        },
      ]);
    });

    it("returns nothing for a pull request's run", () => {
      const ci = { ...context().ci!, event: "pull_request" };
      expect(
        baselinesOf(
          report({ "workspace-unit/packages/a": 5 }, context({ ci })),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a push to another branch", () => {
      expect(
        baselinesOf(
          report({ "workspace-unit/packages/a": 5 }, context({ branch: "x" })),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a run the fork flag marks", () => {
      const ci = { ...context().ci!, fork: true };
      expect(
        baselinesOf(
          report({ "workspace-unit/packages/a": 5 }, context({ ci })),
        ),
      ).toEqual([]);
    });

    it("returns nothing for a report with no context", () => {
      const { records } = report({ "workspace-unit/packages/a": 5 });
      expect(baselinesOf({ context: undefined, records })).toEqual([]);
    });

    it("never reads a source group as a measured set", () => {
      expect(
        baselinesOf(
          report({}, context(), { "packages/memory": 40 }),
        ),
      ).toEqual([]);
    });

    it("passes over a set name that names no member", () => {
      expect(
        baselinesOf(
          report({ "workspace-unit": 3, "workspace-unit/packages/a": 5 }),
        ).map((base) => base.member),
      ).toEqual(["packages/a"]);
    });
  });

  describe("mergeBaselines()", () => {
    it("carries forward what the previous manifest held", () => {
      expect(
        mergeBaselines(
          [baseline("earlier", 2, 7)],
          [baseline("later", 1, 5)],
          NOW,
        )
          .map((base) => [base.commit, base.uncoveredLines]),
      ).toEqual([["later", 5], ["earlier", 7]]);
    });

    it("drops a baseline that has fallen out of the window", () => {
      expect(
        mergeBaselines(
          [baseline("ancient", LOCAL_COVERAGE_BASELINE_DAYS + 1, 7)],
          [baseline("stale", LOCAL_COVERAGE_BASELINE_DAYS + 2, 3)],
          NOW,
        ),
      ).toEqual([]);
    });

    it("drops a baseline whose date will not read", () => {
      expect(
        mergeBaselines(
          [{ ...baseline("c1", 1, 7), createdAt: "soon" }],
          [],
          NOW,
        ),
      ).toEqual([]);
    });

    it("keeps one baseline of a set at a commit, from the later run", () => {
      // Two baselines at one commit would leave a comparison choosing
      // between them by whichever came first.
      expect(
        mergeBaselines(
          [baseline("shared", 0.75, 9)],
          [baseline("shared", 0.25, 5)],
          NOW,
        ).map((base) => base.uncoveredLines),
      ).toEqual([5]);
      expect(
        mergeBaselines(
          [baseline("shared", 0.25, 5)],
          [baseline("shared", 0.75, 9)],
          NOW,
        ).map((base) => base.uncoveredLines),
      ).toEqual([5]);
    });

    it("keeps the one found later where two runs are stamped with one start", () => {
      // The relay stamps an earlier attempt's object re-shipped under a
      // later day with the later attempt's start, and the fold reads the
      // earlier attempt's object first.
      expect(
        mergeBaselines(
          [],
          [baseline("shared", 1, 7), baseline("shared", 1, 5)],
          NOW,
        ).map((base) => base.uncoveredLines),
      ).toEqual([5]);
    });

    it("keeps two members measured at one commit apart", () => {
      expect(
        mergeBaselines(
          [],
          [
            baseline("shared", 1, 7, "packages/a"),
            baseline("shared", 1, 5, "packages/b"),
          ],
          NOW,
        ).map((base) => [base.member, base.uncoveredLines]),
      ).toEqual([["packages/a", 7], ["packages/b", 5]]);
    });
  });
});
