import {
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  acceptedCoverageDebt,
  acceptsCoverageDebt,
  aggregateCacheStates,
  type Artifact,
  type BaselineSample,
  buildCoverageDebtSuggestionComment,
  buildCoverageDebtUnattributedComment,
  buildCoverageNotGatedComment,
  buildCoverageResolvedComment,
  type CompileCacheStates,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_SUGGESTION_MARKER,
  coverageGroupsForChangedFiles,
  coverageListingNotCurrent,
  coverageMetricForGroup,
  coverageMetricGroupName,
  coverageMetricMeasuredSet,
  coverageNotGatedNotice,
  downloadAndExtractArtifact,
  downloadAndParseCoverageBaseline,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchIssueComments,
  fetchPRBody,
  fetchPRFiles,
  formatOverrideSuggestion,
  githubGet,
  githubPatch,
  githubPost,
  GitHubRateLimitError,
  isBaselineCandidateRun,
  isGitHubRateLimitError,
  isNotFound,
  measuredSetCoverageMetric,
  newestArtifactsByName,
  parseAddedLinesFromPatch,
  parseBaselineOverrides,
  parseCacheStateFiles,
  parseCoverageBaselineDetailed,
  PERF_METRICS_FILE,
  REPO,
  serializeCoverageBaseline,
  shouldGateCoverageDebtMetric,
  unknownAcceptedMetrics,
  WORKFLOW_RUNS_PAGE_SIZE,
  workflowRunsPagePath,
} from "./ci-check-lib.ts";
import { buildZip } from "./zip-testing.ts";

Deno.test("coverage baseline files round-trip stable metric samples", () => {
  const metrics = new Map<string, BaselineSample>([
    ["coverage-debt: packages/runner uncovered lines", {
      runId: 123,
      sha: "abc123",
      createdAt: "2026-01-01T00:00:00Z",
      uncoveredLines: 42,
    }],
    ["coverage-debt: packages/memory uncovered lines", {
      runId: 123,
      sha: "abc123",
      createdAt: "2026-01-01T00:00:00Z",
      uncoveredLines: 60,
    }],
  ]);

  const serialized = serializeCoverageBaseline(metrics);
  assertEquals(
    serialized.metrics.map((metric) => metric.name),
    [
      "coverage-debt: packages/memory uncovered lines",
      "coverage-debt: packages/runner uncovered lines",
    ],
  );

  // The file keeps the keys it has always carried, so a run whose checkout
  // predates the in-memory rename still reads a file this run writes.
  assertEquals(serialized.metrics[0].durationSeconds, 60);
  assertEquals(
    serialized.metrics[0].runUrl,
    `https://github.com/${REPO}/actions/runs/123`,
  );

  assertEquals(
    parseCoverageBaselineDetailed(JSON.stringify(serialized)).metrics,
    metrics,
  );
});

Deno.test("coverage baseline files read a file the performance gate wrote", () => {
  // Written when the artifact also carried CI timing metrics: the file names
  // the run's page, and the uncovered-line count sits under `durationSeconds`.

  const legacy = JSON.stringify({
    version: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    metrics: [
      {
        name: "coverage-debt: packages/runner uncovered lines",
        runId: 7,
        runUrl: "https://example.test/run/7",
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        durationSeconds: 5740,
      },
      {
        name: "job: Check",
        runId: 7,
        runUrl: "https://example.test/run/7",
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        durationSeconds: 61.5,
      },
    ],
  });

  const parsed = parseCoverageBaselineDetailed(legacy);
  assertEquals(
    parsed.metrics.get("coverage-debt: packages/runner uncovered lines"),
    {
      runId: 7,
      sha: "abc123",
      createdAt: "2026-01-01T00:00:00Z",
      uncoveredLines: 5740,
    },
  );
  assertEquals(parsed.compileCacheStates, null);
});

Deno.test("coverage baseline files round-trip compile cache states", () => {
  const metrics = new Map<string, BaselineSample>([
    [
      "job: Check",
      {
        runId: 123,
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        uncoveredLines: 60,
      },
    ],
  ]);
  const states: CompileCacheStates = {
    "generated-patterns": "cold",
    "pattern-unit": "warm",
  };

  const serialized = JSON.stringify(serializeCoverageBaseline(metrics, states));

  const detailed = parseCoverageBaselineDetailed(serialized);
  assertEquals(detailed.metrics, metrics);
  assertEquals(detailed.compileCacheStates, states);
});

Deno.test("parseCoverageBaselineDetailed treats legacy files as untagged", () => {
  const legacy = JSON.stringify(serializeCoverageBaseline(new Map()));
  assertFalse(legacy.includes("compileCacheStates"));

  const detailed = parseCoverageBaselineDetailed(legacy);
  assertEquals(detailed.compileCacheStates, null);
  assertEquals(detailed.metrics.size, 0);

  // Empty states are omitted too, so an all-unknown run stays untagged.
  assertFalse(
    JSON.stringify(serializeCoverageBaseline(new Map(), {}))
      .includes("compileCacheStates"),
  );
});

Deno.test("parseCoverageBaselineDetailed drops invalid compile cache states", () => {
  const file = JSON.stringify({
    version: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    metrics: [],
    compileCacheStates: {
      "generated-patterns": "lukewarm",
      "runner": "cold",
      "pattern-unit": "warm",
    },
  });

  assertEquals(parseCoverageBaselineDetailed(file).compileCacheStates, {
    "pattern-unit": "warm",
  });
});

/** A coverage baseline metric record carrying every field the file needs. */
const BASELINE_RECORD = {
  name: "coverage-debt: packages/runner uncovered lines",
  runId: 7,
  sha: "abc123",
  createdAt: "2026-01-01T00:00:00Z",
  durationSeconds: 42,
};

/** A coverage baseline file holding `metrics`, with `fields` over the rest. */
function baselineFile(
  metrics: unknown,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    metrics,
    ...fields,
  });
}

Deno.test("parseCoverageBaselineDetailed refuses a file in a format it does not know", () => {
  assertEquals(
    parseCoverageBaselineDetailed(baselineFile([BASELINE_RECORD])).metrics
      .get(BASELINE_RECORD.name)?.uncoveredLines,
    42,
  );
  for (
    const file of [
      baselineFile([BASELINE_RECORD], { version: 2 }),
      baselineFile({ [BASELINE_RECORD.name]: BASELINE_RECORD }),
    ]
  ) {
    assertThrows(
      () => parseCoverageBaselineDetailed(file),
      Error,
      "Unsupported coverage baseline file format.",
    );
  }
});

Deno.test("parseCoverageBaselineDetailed refuses a metric record missing a field", () => {
  for (const field of Object.keys(BASELINE_RECORD)) {
    const partial = Object.fromEntries(
      Object.entries(BASELINE_RECORD).filter(([name]) => name !== field),
    );
    assertThrows(
      () => parseCoverageBaselineDetailed(baselineFile([partial])),
      Error,
      "Invalid coverage baseline metric record.",
    );
  }
});

Deno.test("cache state aggregation treats any restore hit as warm", () => {
  const records = parseCacheStateFiles([
    '{"family":"generated-patterns","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
    // A restore-key hit (exactHit false) still implies an unchanged compiler
    // fingerprint, so the family is warm.
    '{"family":"generated-patterns","shard":"2","matchedKey":"compile-abc","exactHit":false}',
    '{"family":"pattern-integration","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
  ]);
  assertExists(records);

  // pattern-unit has no records, so its state stays absent (unknown).
  assertEquals(aggregateCacheStates(records), {
    "generated-patterns": "warm",
    "pattern-integration": "warm",
  });
});

Deno.test("cache state aggregation marks a family cold on any full miss", () => {
  const records = parseCacheStateFiles([
    '{"family":"pattern-unit","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
    '{"family":"pattern-unit","shard":"2","matchedKey":"","exactHit":false}',
    // A warm shard after the miss must not flip the family back to warm.
    '{"family":"pattern-unit","shard":"3","matchedKey":"compile-abc-3","exactHit":true}',
  ]);
  assertExists(records);

  assertEquals(aggregateCacheStates(records), { "pattern-unit": "cold" });
});

Deno.test("cache state parsing poisons the collection on any bad record", () => {
  // A record that fails to parse could be the cold shard; surviving records
  // must not tag its family warm, so the whole parse degrades to null
  // (unknown) — same policy as an artifact download failure.

  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    const records = parseCacheStateFiles([
      "not json {",
      '{"family":"pattern-integration","shard":"1"}',
      '{"family":"pattern-integration","shard":"2","matchedKey":"compile-abc","exactHit":false}',
    ]);

    assertEquals(records, null);
    assertEquals(warnings.length, 2);
    assertStringIncludes(warnings[0], "malformed cache-state file");
    assertStringIncludes(warnings[1], "invalid cache-state record");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("cache state parsing keeps valid unknown-family records inert", () => {
  // An unknown family name is forward-compatible data, not corruption: it
  // parses cleanly and aggregation simply never assigns it a state.

  const records = parseCacheStateFiles([
    '{"family":"runner","shard":"1","matchedKey":"","exactHit":false}',
    '{"family":"pattern-integration","shard":"2","matchedKey":"compile-abc","exactHit":false}',
  ]);
  assertExists(records);
  assertEquals(records.length, 2);

  assertEquals(aggregateCacheStates(records), {
    "pattern-integration": "warm",
  });
});

Deno.test("coverage debt metrics format and parse line units", () => {
  const metric = "coverage-debt: workspace uncovered lines";
  assertEquals(formatOverrideSuggestion(12.2), "13 lines");
  assertEquals(formatOverrideSuggestion(1), "1 line");

  const overrides = parseBaselineOverrides(
    "ACCEPT_COVERAGE_DEBT: workspace +7 lines",
  );
  assertEquals(overrides.metrics.get(metric), 7);
  assertEquals(overrides.coverageBaselineReset, false);
});

Deno.test("baseline override parser accepts a group's line increment", () => {
  const overrides = parseBaselineOverrides(
    "ACCEPT_COVERAGE_DEBT: packages/runner  +123 lines",
  );

  assertEquals(
    overrides.metrics.get("coverage-debt: packages/runner uncovered lines"),
    123,
  );
  assertEquals(overrides.coverageBaselineReset, false);
});

Deno.test("baseline override parser reads a one-line increment", () => {
  const overrides = parseBaselineOverrides(
    "ACCEPT_COVERAGE_DEBT: tasks +1 line",
  );

  assertEquals(
    overrides.metrics.get("coverage-debt: tasks uncovered lines"),
    1,
  );
});

Deno.test("baseline override parser rejects a total in place of an increment", () => {
  // An acceptance naming a total says nothing about how much debt the pull
  // request adds, and means something different against every baseline, so it
  // is rejected rather than read as though it were an increment.

  assertThrows(
    () =>
      parseBaselineOverrides(
        "ACCEPT_COVERAGE_DEBT: packages/runner = 123 lines",
      ),
    Error,
    "<source group or workspace member> +N lines",
  );
});

Deno.test("baseline override parser rejects a metric name in place of a group", () => {
  assertThrows(
    () =>
      parseBaselineOverrides(
        "ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines +7 lines",
      ),
    Error,
    "<source group or workspace member> +N lines",
  );
});

Deno.test("baseline override parser rejects a name nothing could measure", () => {
  // Only `packages` splits below its top level, so a path below any other
  // top-level directory names neither a source group nor a member.
  assertThrows(
    () => parseBaselineOverrides("ACCEPT_COVERAGE_DEBT: tasks/foo +7 lines"),
    Error,
    "name a coverage source group",
  );
});

Deno.test("two acceptances of one name are refused", () => {
  // The author meant one number and would be given the other, with
  // nothing saying which.
  assertThrows(
    () =>
      acceptedCoverageDebt(
        "ACCEPT_COVERAGE_DEBT: packages/runner +12 lines\n" +
          "ACCEPT_COVERAGE_DEBT: packages/runner +3 lines",
      ),
    Error,
    "Two ACCEPT_COVERAGE_DEBT acceptances",
  );
  // A merged body cannot be rewritten, so the larger stands there.
  assertEquals(
    acceptedCoverageDebt(
      "ACCEPT_COVERAGE_DEBT: packages/runner +12 lines\n" +
        "ACCEPT_COVERAGE_DEBT: packages/runner +3 lines",
      true,
    ).get("packages/runner"),
    12,
  );
});

Deno.test("a workspace member deeper than a group is not one of this ratchet's", () => {
  // The coverage gate reads it, and this ratchet measures nothing for it,
  // so taking it as a group would fail the run for an acceptance that
  // names no group.
  const overrides = parseBaselineOverrides(
    "ACCEPT_COVERAGE_DEBT: packages/connectors/github +7 lines",
  );
  assertEquals(overrides.metrics.size, 0);
  assertEquals(
    acceptedCoverageDebt(
      "ACCEPT_COVERAGE_DEBT: packages/connectors/github +7 lines",
    )
      .get("packages/connectors/github"),
    7,
  );
});

Deno.test("unknownAcceptedMetrics names an accepted group nothing measured", () => {
  const overrides = parseBaselineOverrides(
    "ACCEPT_COVERAGE_DEBT: packages/nonexistent +7 lines\n" +
      "ACCEPT_COVERAGE_DEBT: tasks +2 lines",
  );
  const measured = new Set([
    "coverage-debt: tasks uncovered lines",
    "coverage-debt: workspace uncovered lines",
  ]);

  // A shape a group could have is not a group this run has: the acceptance
  // would otherwise sit in the description having no effect on anything.
  assertEquals(unknownAcceptedMetrics(overrides, measured), [
    "coverage-debt: packages/nonexistent uncovered lines",
  ]);

  measured.add("coverage-debt: packages/nonexistent uncovered lines");
  assertEquals(unknownAcceptedMetrics(overrides, measured), []);
});

Deno.test("baseline override parser reads only a marker starting a line", () => {
  // A description explaining the mechanism carries no acceptance, and is not a
  // malformed one either.
  const prose =
    "Rebasing changes what an ACCEPT_COVERAGE_DEBT: total means, so it " +
    "accepts a rise instead.";
  assertEquals(parseBaselineOverrides(prose).metrics.size, 0);

  // An indented example of the marker is an example. A description showing the
  // form — as this change's own does — accepts nothing by showing it, and says
  // so, so an author who indented one by mistake can see why it did nothing.
  const warnings: string[] = [];
  const example = parseBaselineOverrides(
    "Accept a rise above the baseline instead:\n\n" +
      "    ACCEPT_COVERAGE_DEBT: packages/runner +12 lines\n",
    false,
    (message) => warnings.push(message),
  );
  assertEquals(example.metrics.size, 0);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "is indented, so it is read as an example");

  // A merged description is read for its acceptances alone, so the examples it
  // carries are passed over without comment.
  const merged: string[] = [];
  parseBaselineOverrides(
    "    ACCEPT_COVERAGE_DEBT: packages/runner +12 lines\n",
    true,
    (message) => merged.push(message),
  );
  assertEquals(merged, []);

  // Flush against the left margin, the same line is an acceptance.
  const accepted = parseBaselineOverrides(
    "Accepting the flapping lines:\n\nACCEPT_COVERAGE_DEBT: tasks +3 lines\n",
  );
  assertEquals(accepted.metrics.get("coverage-debt: tasks uncovered lines"), 3);
});

Deno.test("baseline override parser reads legacy coverage-debt acceptance only when asked", () => {
  const body =
    "NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 123 lines";

  // New PRs must use ACCEPT_COVERAGE_DEBT: the legacy form is ignored by default.
  assertEquals(parseBaselineOverrides(body).metrics.size, 0);

  // Merged baseline PRs from before the rename still count, so their
  // acceptance truncates the baseline timeline.
  const legacy = parseBaselineOverrides(body, true);
  assertEquals(
    legacy.metrics.get("coverage-debt: packages/runner uncovered lines"),
    123,
  );
});

Deno.test("a merged PR's acceptance counts whatever form it was written in", () => {
  const body =
    "ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines = 123 lines\n" +
    "ACCEPT_COVERAGE_DEBT: packages/memory +4 lines";

  const merged = parseBaselineOverrides(body, true);
  assertEquals(
    acceptsCoverageDebt(
      merged,
      "coverage-debt: packages/memory uncovered lines",
    ),
    true,
  );
  // The pre-increment form no longer names an amount the ratchet can use, so
  // the metric it accepted is passed over rather than failing the whole body.
  assertEquals(
    acceptsCoverageDebt(
      merged,
      "coverage-debt: packages/runner uncovered lines",
    ),
    false,
  );
});

Deno.test("legacy override parsing ignores the defunct timing form", () => {
  // NEW_PERF_BASELINE once accepted timing regressions too; those gate nothing
  // now, so a legacy timing line is ignored rather than rejected — a merged PR
  // that carried one must still yield its coverage-debt acceptance.

  const overrides = parseBaselineOverrides(
    "NEW_PERF_BASELINE: job: Check = 7s\n" +
      "NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 9 lines",
    true,
  );
  assertEquals(overrides.metrics.size, 1);
  assertEquals(
    overrides.metrics.get("coverage-debt: packages/runner uncovered lines"),
    9,
  );
});

Deno.test("coverage baseline reset marker parses from PR body", () => {
  const overrides = parseBaselineOverrides(
    `Reset coverage debt for one cycle\n${COVERAGE_BASELINE_RESET_MARKER}\n`,
  );

  assertEquals(overrides.coverageBaselineReset, true);
  assertEquals(overrides.metrics.size, 0);
});

Deno.test("a merged reset accepts coverage-debt metrics only", () => {
  const reset = { metrics: new Map(), coverageBaselineReset: true };

  assertEquals(
    acceptsCoverageDebt(reset, "coverage-debt: workspace uncovered lines"),
    true,
  );
  assertEquals(acceptsCoverageDebt(reset, "job: Check"), false);

  const perMetric = {
    metrics: new Map([["coverage-debt: packages/runner uncovered lines", 12]]),
    coverageBaselineReset: false,
  };
  assertEquals(
    acceptsCoverageDebt(
      perMetric,
      "coverage-debt: packages/runner uncovered lines",
    ),
    true,
  );
  assertEquals(
    acceptsCoverageDebt(
      perMetric,
      "coverage-debt: packages/memory uncovered lines",
    ),
    false,
  );
});

Deno.test("coverage debt gating follows changed source groups", () => {
  const groups = coverageGroupsForChangedFiles([
    "packages/runner/src/cell.ts",
    "packages/patterns/README.md",
    "packages/ui/src/button.test.tsx",
    "tasks/coverage-check.ts",
    "scripts/build.ts",
  ]);

  assertEquals([...groups].sort(), ["packages/runner", "packages/ui", "tasks"]);
  assertEquals(
    coverageMetricGroupName("coverage-debt: packages/runner uncovered lines"),
    "packages/runner",
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/runner uncovered lines",
      groups,
    ),
    true,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/patterns uncovered lines",
      groups,
    ),
    false,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: workspace uncovered lines",
      groups,
    ),
    false,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/patterns uncovered lines",
      undefined,
    ),
    true,
  );
});

Deno.test("parseAddedLinesFromPatch maps added lines to their new line numbers", () => {
  const patch = [
    "@@ -1,3 +1,5 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 20;",
    "+const c = 3;",
    " const d = 4;",
    "+const e = 5;",
    "\\ No newline at end of file",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [
    [2, "const b = 20;"],
    [3, "const c = 3;"],
    [5, "const e = 5;"],
  ]);
});

Deno.test("parseAddedLinesFromPatch tracks line numbers across multiple hunks", () => {
  const patch = [
    "@@ -10,2 +10,3 @@",
    " keep;",
    "+added at 11;",
    " keep;",
    "@@ -40,1 +41,2 @@",
    " keep;",
    "+added at 42;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals(added.get(11), "added at 11;");
  assertEquals(added.get(42), "added at 42;");
  assertEquals(added.size, 2);
});

Deno.test("parseAddedLinesFromPatch keeps added lines whose content starts with +", () => {
  const patch = [
    "@@ -1,1 +1,4 @@",
    " context;",
    "+++count;", // added source line "++count;"
    "+ leading-space kept;",
    "+normal;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [
    [2, "++count;"],
    [3, " leading-space kept;"],
    [4, "normal;"],
  ]);
});

Deno.test("parseAddedLinesFromPatch ignores file headers before the first hunk", () => {
  const patch = [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,1 +1,2 @@",
    " keep;",
    "+added;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [[2, "added;"]]);
});

Deno.test("buildCoverageDebtSuggestionComment lists files (not lines), command, and targets", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "packages/runner", target: 12, current: 15 },
    ],
    files: [
      {
        relativePath: "packages/runner/src/cell.ts",
        group: "packages/runner",
        uncoveredCount: 2,
      },
    ],
  });

  // Marker so a later run can detect and update it.
  assertStringIncludes(comment, COVERAGE_SUGGESTION_MARKER);
  // The body is wrapped in an open <details> summarizing the over-by total
  // (15 - 12 = 3 lines), with no standalone header.
  assertStringIncludes(comment, "<details open>");
  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 3 lines</h3></summary>",
  );
  assertStringIncludes(comment, "</details>");
  assertFalse(comment.includes("## 🧪 Test coverage regressed"));
  // The regressed group with its target and current value.
  assertStringIncludes(comment, "`packages/runner`");
  assertStringIncludes(comment, "| 12 | 15 | +3 |");
  // The affected file with its uncovered-line count, but no per-line code dump.
  assertStringIncludes(comment, "`packages/runner/src/cell.ts` — 2 lines");
  // The prompt block still carries the command and the metric target.
  assertStringIncludes(comment, "tasks/coverage-metrics.ts");
  assertStringIncludes(
    comment,
    "coverage-debt: packages/runner uncovered lines  <=  12",
  );
  // A failed workspace run yields a partial coverage profile. The agent is
  // told to get a passing run, with temporary skips allowed only while
  // collecting local coverage.
  assertStringIncludes(
    comment,
    "make it pass or temporarily skip it for\nthe coverage run",
  );
  assertStringIncludes(
    comment,
    "Do not\ninclude temporary test skips in the PR",
  );
  assertStringIncludes(
    comment,
    "code in packages it never\nruns is counted as fully uncovered",
  );
  // The comment ends at the prompt block — no verify/footer sections.
  assertFalse(comment.includes("### Verify locally"));
});

Deno.test("buildCoverageDebtSuggestionComment handles a regression with no pinned lines", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "tasks", target: 0, current: 4 },
    ],
    files: [],
  });

  assertStringIncludes(comment, COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(comment, "Could not tie the regression");
  assertStringIncludes(
    comment,
    "coverage-debt: tasks uncovered lines  <=  0",
  );
});

Deno.test("buildCoverageDebtSuggestionComment sums Over by across groups in the summary", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "packages/runner", target: 12, current: 15 },
      { group: "tasks", target: 4, current: 8 },
    ],
    files: [],
  });

  // 3 + 4 = 7 over baseline.
  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 7 lines</h3></summary>",
  );
});

Deno.test("buildCoverageDebtSuggestionComment uses the singular for a one-line regression", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "tasks", target: 4, current: 5 },
    ],
    files: [],
  });

  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 1 line</h3></summary>",
  );
});

Deno.test("buildCoverageResolvedComment collapses the details and summarizes the reduction", () => {
  const resolved = buildCoverageResolvedComment(5, [
    { group: "packages/runner", baseline: 15, current: 12 },
  ]);

  // The disclosure stays collapsed (no `open`) and the summary celebrates the
  // reduction; none of the stale regression copy survives.
  assertFalse(resolved.includes("<details open>"));
  assertStringIncludes(resolved, "<details>");
  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt reduced by 5 lines!</strong></summary>",
  );
  assertFalse(resolved.includes("Test coverage regressed by"));
  assertFalse(resolved.includes("Prompt for an AI coding agent"));
  // The body keeps the marker and summarizes the per-group before-and-after.
  assertStringIncludes(resolved, COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(
    resolved,
    "| Source group | Baseline (`main`) | This PR | Change |",
  );
  assertStringIncludes(
    resolved,
    "| `packages/runner` | 15 | 12 | 3 lines fewer |",
  );
});

Deno.test("buildCoverageResolvedComment notes resolution when there is no net reduction", () => {
  const resolved = buildCoverageResolvedComment(0, [
    { group: "tasks", baseline: 8, current: 8 },
  ]);

  assertFalse(resolved.includes("<details open>"));
  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt is within the ratchet.</strong></summary>",
  );
  assertStringIncludes(resolved, "| `tasks` | 8 | 8 | no change |");
});

Deno.test("buildCoverageNotGatedComment names each ungated group and why", () => {
  const baseSha = "c4a5de3346126594d6b9f1ea5cdace119a302a52";
  const comment = buildCoverageNotGatedComment({
    groups: [
      { group: "packages/shell", reason: "no-baseline" },
      {
        group: "tasks",
        reason: "base-branch-moved",
        baselineSha: "ec849c4c00000000000000000000000000000000",
      },
    ],
    measurement: {
      runUrl: "https://github.com/commonfabric/labs/actions/runs/7",
      baseSha,
    },
  });

  // The one coverage comment, left open so the state is read without a click.
  assertEquals(comment.split("\n")[0], COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(comment, "<details open>");
  assertStringIncludes(comment, "Test coverage was NOT gated on this run");
  assertStringIncludes(
    comment,
    "did not hold `packages/shell`, `tasks` against a baseline",
  );
  assertStringIncludes(
    comment,
    "| `packages/shell` | No successful `main` run within reach measured " +
      "base-branch commit `c4a5de33` or an ancestor of it. |",
  );
  assertStringIncludes(
    comment,
    "| `tasks` | `main` changed this group between the nearest measured " +
      "ancestor (`ec849c4c`) and base-branch commit `c4a5de33`. |",
  );
  assertStringIncludes(comment, "A later run of this pull request gates");
  assertStringIncludes(
    comment,
    "Measured by https://github.com/commonfabric/labs/actions/runs/7.",
  );
});

Deno.test("buildCoverageNotGatedComment says a listing that is not current failed the job", () => {
  const comment = buildCoverageNotGatedComment({
    groups: [{ group: "tasks", reason: "listing-not-current" }],
  });

  assertStringIncludes(
    comment,
    "The **Coverage Check** job failed because it could not find a baseline " +
      "to hold `tasks` against.",
  );
  assertStringIncludes(
    comment,
    "| `tasks` | GitHub's listing of this workflow's runs left out this run",
  );
  assertStringIncludes(comment, "Re-run the **Coverage Check** job");
  assertFalse(comment.includes("Measured by"));
});

Deno.test("buildCoverageNotGatedComment sends a rate-limited run back to GitHub", () => {
  const comment = buildCoverageNotGatedComment({
    groups: [{ group: "tasks", reason: "rate-limited" }],
  });

  // The job passed, so the comment reads as the ungated-but-passing one, and
  // the remedy waits on the limit rather than on a `main` run.
  assertStringIncludes(
    comment,
    "The **Coverage Check** job did not hold `tasks` against a baseline",
  );
  assertStringIncludes(
    comment,
    "| `tasks` | GitHub's API rate limit stopped this run reading the " +
      "baseline data, so nothing was compared. |",
  );
  assertStringIncludes(
    comment,
    "Re-run the **Coverage Check** job once GitHub's API rate limit has reset.",
  );
  assertFalse(comment.includes("A later run of this pull request gates"));
});

Deno.test("coverageNotGatedNotice names no commit for a checkout that had none", () => {
  const notice = coverageNotGatedNotice({
    groups: [
      { group: "packages/runner", reason: "no-base-commit" },
      { group: "packages/ui", reason: "no-baseline" },
    ],
  }).join("\n");

  assertStringIncludes(
    notice,
    "| `packages/runner` | The base-branch commit this run merges into could " +
      "not be read from the checkout. |",
  );
  assertStringIncludes(
    notice,
    "| `packages/ui` | No successful `main` run within reach measured the " +
      "base-branch commit or an ancestor of it. |",
  );
});

Deno.test("coverageNotGatedNotice does not say how the job ended unless the listing decided it", () => {
  // A group with no baseline passes on its own, and fails beside a regression
  // in another group, so the notice claims neither.
  const notice = coverageNotGatedNotice({
    groups: [{ group: "tasks", reason: "base-branch-moved" }],
  }).join("\n");

  assertFalse(notice.includes("passed"));
  assertFalse(notice.includes("failed"));
  assertStringIncludes(
    notice,
    "The **Coverage Check** job did not hold `tasks` against a baseline",
  );
});

Deno.test("coverageListingNotCurrent is true only of a listing that was not current", () => {
  assertEquals(
    coverageListingNotCurrent([
      { group: "tasks", reason: "listing-not-current" },
    ]),
    true,
  );
  assertEquals(
    coverageListingNotCurrent([
      { group: "tasks", reason: "no-baseline" },
      { group: "packages/ui", reason: "base-branch-moved" },
    ]),
    false,
  );
  assertEquals(coverageListingNotCurrent([]), false);
});

Deno.test("buildCoverageResolvedComment claims no comparison for a reset that compared nothing", () => {
  const resolved = buildCoverageResolvedComment(0, [], true);

  assertStringIncludes(
    resolved,
    "Code coverage debt accepted with an override.",
  );
  assertStringIncludes(
    resolved,
    "This run compared no source group against a baseline",
  );
  assertFalse(resolved.includes("at or below its `main` baseline"));
});

Deno.test("workflowRunsPagePath asks for one unfiltered page of the workflow's runs", () => {
  const path = workflowRunsPagePath(3);
  const query = new URLSearchParams(path.split("?")[1]);

  assertStringIncludes(path, "/actions/workflows/deno.yml/runs?");
  assertEquals(query.get("page"), "3");
  assertEquals(query.get("per_page"), String(WORKFLOW_RUNS_PAGE_SIZE));
  // Any of these sends the request to the search index that returns old runs.
  for (const filter of ["branch", "status", "event", "created", "head_sha"]) {
    assertEquals(query.get(filter), null);
  }
});

Deno.test("isBaselineCandidateRun admits only a successful push to main", () => {
  const push = { event: "push", head_branch: "main", conclusion: "success" };

  assertEquals(isBaselineCandidateRun(push), true);
  assertEquals(
    isBaselineCandidateRun({ ...push, event: "pull_request" }),
    false,
  );
  assertEquals(isBaselineCandidateRun({ ...push, head_branch: "fix" }), false);
  assertEquals(
    isBaselineCandidateRun({ ...push, conclusion: "failure" }),
    false,
  );
  assertEquals(
    isBaselineCandidateRun({ ...push, head_branch: undefined }),
    false,
  );
});

Deno.test("buildCoverageResolvedComment uses a single line of one uncovered line", () => {
  const resolved = buildCoverageResolvedComment(1, [
    { group: "tasks", baseline: 5, current: 4 },
  ]);

  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt reduced by 1 line!</strong></summary>",
  );
  assertStringIncludes(resolved, "| `tasks` | 5 | 4 | 1 line fewer |");
});

Deno.test("buildCoverageResolvedComment reports a group that gained uncovered lines", () => {
  // A changed group can reach the resolved comment with more uncovered lines
  // than `main` when the regression was accepted with a per-group acceptance or
  // the coverage reset marker. The table reports the increase rather than
  // hiding it.

  const resolved = buildCoverageResolvedComment(0, [
    { group: "packages/runner", baseline: 12, current: 15 },
  ]);

  assertStringIncludes(
    resolved,
    "| `packages/runner` | 12 | 15 | 3 lines more |",
  );
});

Deno.test("buildCoverageResolvedComment says the debt was overridden, not improved", () => {
  // The gate passed because the debt was accepted, so the summary must not
  // imply the new code is covered, even when a group also improved.

  const resolved = buildCoverageResolvedComment(
    4,
    [{ group: "packages/runner", baseline: 12, current: 15 }],
    true,
  );

  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt accepted with an override.</strong></summary>",
  );
  assertStringIncludes(
    resolved,
    "accepted with an override rather than covered by new tests",
  );
  assertFalse(resolved.includes("Code coverage debt reduced by"));
  assertFalse(resolved.includes("no test reached on"));
  // The table still shows the real per-group numbers.
  assertStringIncludes(
    resolved,
    "| `packages/runner` | 12 | 15 | 3 lines more |",
  );
  // Nothing was named, so the section that names files is left out entirely.
  assertFalse(resolved.includes("### Files with new uncovered lines"));
});

Deno.test("buildCoverageResolvedComment names the files an accepted debt stands in for", () => {
  const resolved = buildCoverageResolvedComment(
    0,
    [{ group: "tasks", baseline: 1846, current: 1857 }],
    true,
    [
      { relativePath: "tasks/one.ts", group: "tasks", uncoveredCount: 11 },
      { relativePath: "tasks/two.ts", group: "tasks", uncoveredCount: 1 },
    ],
  );

  assertStringIncludes(resolved, "### Files with new uncovered lines");
  assertStringIncludes(resolved, "- `tasks/one.ts` — 11 lines");
  // A single line reads as a line, the same as it does in the regression body.
  assertStringIncludes(resolved, "- `tasks/two.ts` — 1 line");
});

Deno.test("buildCoverageResolvedComment names no files when the debt was covered", () => {
  // Coverage that improved has no acceptance to account for, so a file list
  // would be describing debt that is not there.

  const resolved = buildCoverageResolvedComment(
    5,
    [{ group: "tasks", baseline: 1857, current: 1852 }],
    false,
    [{ relativePath: "tasks/one.ts", group: "tasks", uncoveredCount: 11 }],
  );

  assertFalse(resolved.includes("### Files with new uncovered lines"));
  assertFalse(resolved.includes("tasks/one.ts"));
});

Deno.test("buildCoverageResolvedComment falls back to a sentence with no groups", () => {
  const resolved = buildCoverageResolvedComment(3, []);

  assertStringIncludes(resolved, "<details>");
  assertFalse(resolved.includes("| Source group |"));
  assertStringIncludes(
    resolved,
    "Every changed source group is at or below its `main` baseline",
  );
});

Deno.test("fetchPRBody reads the live pull request body from the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  try {
    globalThis.fetch = ((input, _init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ body: "LIVE PR BODY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    assertEquals(await fetchPRBody(3427), "LIVE PR BODY");
    assertEquals(
      requestedUrl,
      "https://api.github.com/repos/commonfabric/labs/pulls/3427",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchIssueComments reads every page of a pull request's comments", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  try {
    // A full page means there may be another, so the reader asks for one more.
    // The second page comes back short and ends the walk. The comment with a
    // null body is what the GitHub API returns for a comment whose text was
    // deleted, and it reads back as empty rather than as null.
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index + 1}`,
    }));
    const secondPage = [{ id: 101, body: null }];

    globalThis.fetch = ((input, _init) => {
      const url = input instanceof Request ? input.url : String(input);
      requestedUrls.push(url);
      // Read the page from the query rather than by searching the whole URL:
      // `per_page=100` carries `page=1` inside it.
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(
        new Response(
          JSON.stringify(page === "1" ? firstPage : secondPage),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const comments = await fetchIssueComments(5727);

    assertEquals(comments.length, 101);
    assertEquals(comments[0], { id: 1, body: "comment 1" });
    assertEquals(comments[100], { id: 101, body: "" });
    assertEquals(requestedUrls, [
      "https://api.github.com/repos/commonfabric/labs/issues/5727/comments?per_page=100&page=1",
      "https://api.github.com/repos/commonfabric/labs/issues/5727/comments?per_page=100&page=2",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchCurrentPRBody prefers the live pull request body over stale event payloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ body: "LIVE PR BODY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;

    const result = await fetchCurrentPRBody(3427, {
      pull_request: { body: "STALE EVENT BODY" },
    });

    assertEquals(result, { body: "LIVE PR BODY", source: "live" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchCurrentPRBody falls back to the event body if the live request fails", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(
        new Response("rate limited", { status: 429 }),
      )) as typeof fetch;

    const result = await fetchCurrentPRBody(3427, {
      pull_request: { body: "EVENT BODY" },
    });

    assertEquals(result.body, "EVENT BODY");
    assertEquals(result.source, "event-fallback");
    assertEquals(
      result.errorMessage,
      "GitHub API GET 429 (rate limit): /repos/commonfabric/labs/pulls/3427",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("githubGet retries transient GitHub responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((input, _init) => {
      calls++;
      if (calls < 3) {
        return Promise.resolve(
          new Response("temporary GitHub timeout", {
            status: 504,
            headers: { "retry-after": "0" },
          }),
        );
      }

      const requestedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: requestedUrl }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    assertEquals(
      await githubGet<{ ok: string }>("/repos/commonfabric/labs/actions"),
      { ok: "https://api.github.com/repos/commonfabric/labs/actions" },
    );
    assertEquals(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("githubGet does not retry non-transient GitHub responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((_input, _init) => {
      calls++;
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    let rejected = false;
    try {
      await githubGet("/repos/commonfabric/labs/missing");
    } catch {
      rejected = true;
    }

    assertEquals(rejected, true);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Runs `callback` against a `fetch` answering every request with `response()`,
 * and reports how many requests it made.
 */
async function withFetchAnswering(
  response: () => Response,
  callback: () => Promise<void>,
): Promise<number> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_input, _init) => {
    calls++;
    return Promise.resolve(response());
  }) as typeof fetch;
  try {
    await callback();
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** GitHub's answer when the token has spent its hourly request window. */
function primaryRateLimitResponse(): Response {
  return new Response('{"message":"API rate limit exceeded for user"}', {
    status: 403,
    statusText: "Forbidden",
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1789856877",
    },
  });
}

Deno.test("githubGet reports a spent request window as a rate limit, not a refusal", async () => {
  // The refusal is worded in the response body, which is cancelled unread, so
  // the headers are the only thing that can tell this from a permission error.
  const calls = await withFetchAnswering(primaryRateLimitResponse, async () => {
    const error = await assertRejects(
      () => githubGet("/repos/commonfabric/labs/actions/runs"),
      GitHubRateLimitError,
    );
    assertEquals(
      error.message,
      "GitHub API GET 403 Forbidden (rate limit): /repos/commonfabric/labs/actions/runs",
    );
  });

  // A window that is spent does not refill inside one job, so it is not retried.
  assertEquals(calls, 1);
});

Deno.test("githubGet reports a secondary rate limit once its retries are spent", async () => {
  const calls = await withFetchAnswering(
    () =>
      new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "0", "x-ratelimit-remaining": "42" },
      }),
    async () => {
      await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
    },
  );

  // A secondary limit often clears within the job, so the whole attempt budget
  // is spent before it is called one.
  assertEquals(calls, 4);
});

Deno.test("githubGet stops retrying a spent window answered as a busy signal", async () => {
  // 429 is the status a slow-down is retried for, and the spent window is the
  // one case behind it that no retry inside this job can clear.
  const calls = await withFetchAnswering(
    () =>
      new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "0", "x-ratelimit-remaining": "0" },
      }),
    async () => {
      await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
    },
  );

  assertEquals(calls, 1);
});

Deno.test("githubGet reads a busy signal carrying no headers as a rate limit", async () => {
  // GitHub documents the rate-limit headers as optional, and 429 means too
  // many requests whatever it sends beside it. Read as an ordinary failure it
  // would reach the coverage walk as a run that measured nothing.
  const calls = await withFetchAnswering(
    () =>
      new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
      }),
    async () => {
      await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
    },
  );

  assertEquals(calls, 4);
});

Deno.test("githubGet waits out a secondary limit that arrives as a refusal", async () => {
  // The same condition spelled 403 rather than 429. Retrying is what can still
  // hold the pull request to its baseline, so the status it arrives under must
  // not decide whether the wait is observed.
  const calls = await withFetchAnswering(
    () =>
      new Response("slow down", {
        status: 403,
        statusText: "Forbidden",
        headers: { "retry-after": "0", "x-ratelimit-remaining": "42" },
      }),
    async () => {
      await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
    },
  );

  assertEquals(calls, 4);
});

Deno.test("githubGet reads a secondary limit out of a refusal that sends no headers", async () => {
  // GitHub documents a secondary limit as arriving with neither rate-limit
  // header, and its message as what tells it from a permission failure. Read
  // as a permission failure it would reach the coverage walk as absent data.
  const calls = await withFetchAnswering(
    () =>
      new Response(
        '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
        { status: 403, statusText: "Forbidden" },
      ),
    async () => {
      const error = await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
      // The body classified the refusal and stayed out of what is reported.
      assertEquals(
        error.message,
        "GitHub API GET 403 Forbidden (rate limit): /repos/commonfabric/labs/actions/runs",
      );
    },
  );

  // A wait to observe, so the attempts are spent before it is called a limit.
  assertEquals(calls, 4);
});

Deno.test("githubGet classifies a refusal that carries no body from its headers", async () => {
  // Nothing to read, so the headers are the whole of the evidence — and they
  // are enough here.
  const calls = await withFetchAnswering(
    () =>
      new Response(null, {
        status: 403,
        statusText: "Forbidden",
        headers: { "x-ratelimit-remaining": "0" },
      }),
    async () => {
      await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        GitHubRateLimitError,
      );
    },
  );

  assertEquals(calls, 1);
});

Deno.test("githubGet reports the status when a refusal's body fails mid-read", async () => {
  // Reading the body is how a refusal is classified, never how it is
  // reported, so a body that breaks costs the classification its evidence and
  // the failure nothing.
  await withFetchAnswering(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("the body failed"));
          },
        }),
        { status: 404, statusText: "Not Found" },
      ),
    async () => {
      const error = await assertRejects(
        () => githubGet("/repos/commonfabric/labs/missing"),
        Error,
      );
      assertEquals(
        error.message,
        "GitHub API GET 404 Not Found: /repos/commonfabric/labs/missing",
      );
    },
  );
});

Deno.test("githubGet does not call an ordinary refusal a rate limit", async () => {
  await withFetchAnswering(
    () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    async () => {
      const error = await assertRejects(
        () => githubGet("/repos/commonfabric/labs/actions/runs"),
        Error,
      );
      assertFalse(error instanceof GitHubRateLimitError);
      assertFalse(isGitHubRateLimitError(error));
    },
  );
});

Deno.test("downloadAndExtractArtifact raises a rate limit rather than reporting no artifact", async () => {
  // Reported as `null` the limit would read as a run that measured nothing,
  // which is a verdict about coverage rather than about GitHub.
  const calls = await withFetchAnswering(primaryRateLimitResponse, async () => {
    await assertRejects(
      () => downloadAndExtractArtifact(123, "rate-limited-artifact-"),
      GitHubRateLimitError,
      "GitHub artifact download 403 Forbidden",
    );
  });

  assertEquals(calls, 1);
});

Deno.test("GitHub REST errors include status text and omit response bodies", async (t) => {
  const responseBody =
    "upstream request: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const cases: {
    name: string;
    status: number;
    statusText: string;
    expectedMessage: string;
    request: () => Promise<unknown>;
  }[] = [
    {
      name: "GET 503",
      status: 503,
      statusText: "Service Unavailable",
      expectedMessage:
        "GitHub API GET 503 Service Unavailable: /repos/commonfabric/labs/actions/runs/123/jobs",
      request: () =>
        githubGet("/repos/commonfabric/labs/actions/runs/123/jobs"),
    },
    {
      name: "POST 422",
      status: 422,
      statusText: "Unprocessable Content",
      expectedMessage:
        "GitHub API POST 422 Unprocessable Content: /repos/commonfabric/labs/issues/123/comments",
      request: () =>
        githubPost("/repos/commonfabric/labs/issues/123/comments", {
          body: "comment",
        }),
    },
    {
      name: "PATCH 500",
      status: 500,
      statusText: "Internal Server Error",
      expectedMessage:
        "GitHub API PATCH 500 Internal Server Error: /repos/commonfabric/labs/issues/comments/456",
      request: () =>
        githubPatch("/repos/commonfabric/labs/issues/comments/456", {
          body: "updated comment",
        }),
    },
  ];

  for (const testCase of cases) {
    await t.step(testCase.name, async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = ((_input, _init) =>
          Promise.resolve(
            new Response(responseBody, {
              status: testCase.status,
              statusText: testCase.statusText,
              headers: { "retry-after": "0" },
            }),
          )) as typeof fetch;

        const error = await assertRejects(testCase.request, Error);
        assertEquals(error.message, testCase.expectedMessage);
        assertFalse(error.message.includes(responseBody));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

Deno.test("GitHub REST errors do not wait for response cancellation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              return new Promise(() => {});
            },
          }),
          { status: 404, statusText: "Not Found" },
        ),
      )) as typeof fetch;

    const error = await assertRejects(
      () => githubGet("/repos/commonfabric/labs/missing"),
      Error,
    );
    assertEquals(
      error.message,
      "GitHub API GET 404 Not Found: /repos/commonfabric/labs/missing",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchArtifactsForRun reads every artifact page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  const artifact = (id: number, name: string): Artifact => ({
    id,
    name,
    size_in_bytes: 1,
    expired: false,
  });
  try {
    globalThis.fetch = ((input, _init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPages.push(
        `${url.searchParams.get("per_page")}:${url.searchParams.get("page")}`,
      );
      const page = Number(url.searchParams.get("page"));
      const artifacts = page === 1
        ? [artifact(1, "coverage-profile-workspace")]
        : [artifact(2, "coverage-profile-generated-patterns-1")];

      return Promise.resolve(
        new Response(JSON.stringify({ total_count: 2, artifacts }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const artifacts = await fetchArtifactsForRun(123);
    assertEquals(
      artifacts.map((artifact) => artifact.name),
      [
        "coverage-profile-workspace",
        "coverage-profile-generated-patterns-1",
      ],
    );
    assertEquals(requestedPages, ["100:1", "100:2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchPRFiles reads every changed-file page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  try {
    globalThis.fetch = ((input, _init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPages.push(
        `${url.searchParams.get("per_page")}:${url.searchParams.get("page")}`,
      );
      const page = Number(url.searchParams.get("page"));
      const files = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
          filename: `packages/runner/src/file-${index}.ts`,
        }))
        : [{ filename: "packages/ui/src/card.ts" }];

      return Promise.resolve(
        new Response(JSON.stringify(files), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const files = await fetchPRFiles(123);
    assertEquals(files.length, 101);
    assertEquals(files.at(-1)?.filename, "packages/ui/src/card.ts");
    assertEquals(requestedPages, ["100:1", "100:2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("isNotFound tells a thing that is not there from an interface that could not answer", () => {
  assertEquals(
    isNotFound(new Error("GitHub API GET 404 Not Found: /repos/o/r/pulls/1")),
    true,
  );
  assertEquals(
    isNotFound(
      new Error("GitHub API GET 500 Server Error: /repos/o/r/pulls/1"),
    ),
    false,
  );
  // A path may hold the digits of a status, and a message about
  // something else may hold the word.
  assertEquals(
    isNotFound(new Error("GitHub API GET 500 Error: /repos/o/r/runs/404")),
    false,
  );
  assertEquals(isNotFound("404"), false);
});

Deno.test("a measured set's metric is not one of its member's source groups", () => {
  const metric = measuredSetCoverageMetric("workspace-unit/packages/memory");
  assertEquals(
    coverageMetricMeasuredSet(metric),
    "workspace-unit/packages/memory",
  );
  // The two carry the same package name, and reading one as the other
  // would ratchet a figure the gate has no opinion about.
  assertEquals(coverageMetricGroupName(metric), null);
  assertEquals(
    coverageMetricMeasuredSet(coverageMetricForGroup("packages/memory")),
    null,
  );
  assertEquals(
    coverageMetricGroupName(coverageMetricForGroup("packages/memory")),
    "packages/memory",
  );
});

Deno.test("two suites over one member are two metrics", () => {
  const unit = measuredSetCoverageMetric("workspace-unit/packages/memory");
  const integration = measuredSetCoverageMetric(
    "memory-integration/packages/memory",
  );
  assertEquals(unit === integration, false);
  assertEquals(
    coverageMetricMeasuredSet(integration),
    "memory-integration/packages/memory",
  );
});

Deno.test("downloadAndExtractArtifact retries transient artifact downloads", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let calls = 0;
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    globalThis.fetch = ((_input, _init) => {
      calls++;
      if (calls < 4) {
        return Promise.resolve(
          new Response("temporary artifact backend error", {
            status: 503,
            headers: { "retry-after": "0" },
          }),
        );
      }
      return Promise.resolve(new Response("gone", { status: 410 }));
    }) as typeof fetch;

    assertEquals(await downloadAndExtractArtifact(123, "artifact-test-"), null);
    assertEquals(calls, 4);
    assertEquals(
      warnings.some((warning) =>
        warning.includes("GitHub artifact download 410")
      ),
      true,
    );
    assertEquals(
      warnings.some((warning) =>
        warning.includes("attempt 1: GitHub artifact download 503") &&
        warning.includes("attempt 4: GitHub artifact download 410")
      ),
      true,
    );
    assertEquals(
      warnings.some((warning) =>
        warning.includes("temporary artifact backend error") ||
        warning.includes("gone")
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

/** Runs `read` with every artifact download answering with `zip`. */
async function withArtifactZip<T>(
  zip: Uint8Array,
  read: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(zip as BodyInit, { status: 200 }),
    )) as typeof fetch;
  try {
    return await read();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("downloadAndParseCoverageBaseline reads the baseline file an artifact holds", async () => {
  const metrics = new Map<string, BaselineSample>([
    [coverageMetricForGroup("tasks"), {
      runId: 5,
      sha: "abc",
      createdAt: "2026-01-01T00:00:00Z",
      uncoveredLines: 42,
    }],
  ]);
  const zip = await buildZip(
    PERF_METRICS_FILE,
    new TextEncoder().encode(
      JSON.stringify(
        serializeCoverageBaseline(metrics, { "pattern-unit": "cold" }),
      ),
    ),
    0,
  );
  const parsed = await withArtifactZip(
    zip,
    () => downloadAndParseCoverageBaseline(7),
  );
  assertEquals(parsed?.metrics, metrics);
  assertEquals(parsed?.compileCacheStates, { "pattern-unit": "cold" });
});

Deno.test("downloadAndParseCoverageBaseline returns null for an artifact holding no baseline file", async () => {
  const zip = await buildZip(
    "something-else.json",
    new TextEncoder().encode("{}"),
    0,
  );
  assertEquals(
    await withArtifactZip(zip, () => downloadAndParseCoverageBaseline(7)),
    null,
  );
});

Deno.test("newestArtifactsByName keeps the latest re-run upload per name", () => {
  const artifact = (id: number, name: string): Artifact => ({
    id,
    name,
    size_in_bytes: 1,
    expired: false,
  });
  // API order is newest-first; a naive last-write-wins iteration would let
  // the stale attempt-1 artifact shadow the re-run's upload.
  const result = newestArtifactsByName([
    artifact(200, "test-timing-pattern-unit-4"),
    artifact(150, "test-timing-pattern-unit-1"),
    artifact(100, "test-timing-pattern-unit-4"),
  ]);
  assertEquals(
    result.map((a) => [a.name, a.id]).sort(),
    [
      ["test-timing-pattern-unit-1", 150],
      ["test-timing-pattern-unit-4", 200],
    ],
  );
});

Deno.test("buildCoverageDebtUnattributedComment names the lines and how to skip the check", () => {
  const comment = buildCoverageDebtUnattributedComment({
    groups: [{
      group: "packages/runner",
      target: 4612,
      current: 4614,
      baseline: {
        runUrl: "https://github.com/commonfabric/labs/actions/runs/900",
        sha: "b".repeat(40),
      },
    }],
    files: [
      {
        relativePath: "packages/runner/src/scheduler/diagnosis.ts",
        lines: [333, 334],
      },
    ],
    measurement: {
      runUrl: "https://github.com/commonfabric/labs/actions/runs/901",
      baseSha: "a".repeat(40),
    },
  });

  // Same marker as the other coverage comments, so the poster keeps updating
  // the one comment rather than adding a second.
  assertStringIncludes(comment, COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 2 lines</h3></summary>",
  );
  assertStringIncludes(comment, "not introduced by this PR");
  assertStringIncludes(comment, "inconsistently covered");
  assertStringIncludes(comment, "The following lines are affected:");
  assertStringIncludes(
    comment,
    "`packages/runner/src/scheduler/diagnosis.ts`: 333, 334",
  );
  // The line to paste into the description, with the rise this PR measured
  // rather than the total it reached, so a rebase leaves it saying the same.
  assertStringIncludes(
    comment,
    "ACCEPT_COVERAGE_DEBT: packages/runner +2 lines",
  );
  // The agent prompt is about the flapping lines, not about this PR.
  assertStringIncludes(comment, "### Prompt for an AI coding agent");
  assertStringIncludes(comment, "covered on some runs");
  assertStringIncludes(
    comment,
    "  packages/runner/src/scheduler/diagnosis.ts: 333, 334",
  );
  // The prompt says which run measured the lines, at which commit, and which
  // baseline run each group was held against, so a fresh session can open the
  // measurement rather than guess at how old the report is.
  assertStringIncludes(comment, "Where this measurement came from:");
  assertStringIncludes(
    comment,
    "  Measuring run: https://github.com/commonfabric/labs/actions/runs/901",
  );
  assertStringIncludes(comment, `  Base commit measured: ${"a".repeat(40)}`);
  // The reader is handed the command that says what landed since.
  assertStringIncludes(
    comment,
    `  git log ${"a".repeat(40)}.. -- <one of the files above>`,
  );
  assertStringIncludes(
    comment,
    `  Baseline for packages/runner: run https://github.com/commonfabric/labs/actions/runs/900, commit ${
      "b".repeat(40)
    }`,
  );
  assertStringIncludes(comment, "merged into that base commit");
  assertStringIncludes(comment, "docs/development/COVERAGE.md");
  // Repetition is not offered as evidence: the prompt asks for the new test to
  // be measured on its own instead.
  assertStringIncludes(comment, "Do not try to establish that a line is fixed");
  assertStringIncludes(comment, "deno coverage --lcov coverage/raw/line-check");
  assertStringIncludes(comment, "DA:<line>,<hits>");
  assertFalse(comment.includes("twice from a clean profile directory"));
  // None of the "this PR adds uncovered lines" copy survives.
  assertFalse(comment.includes("This PR adds source lines"));
  assertFalse(comment.includes("Could not tie the regression"));
});

Deno.test("buildCoverageDebtUnattributedComment omits run identity it does not have", () => {
  // A local run of the checker has no workflow run behind it, and a group can
  // reach the comment without a baseline run to name.

  const local = buildCoverageDebtUnattributedComment({
    groups: [{ group: "tasks", target: 0, current: 1 }],
    files: [{ relativePath: "tasks/test-records.ts", lines: [90] }],
  });

  assertFalse(local.includes("Where this measurement came from:"));
  assertFalse(local.includes("Measuring run:"));
  assertFalse(local.includes("Baseline for tasks:"));
  // The reader is still told to check that the report has not been overtaken,
  // in the wording that names no commit.
  assertStringIncludes(local, "it may no longer describe the");
  assertStringIncludes(local, "read");
  assertFalse(local.includes("merged into that base commit"));
  assertFalse(local.includes("git log "));
  assertStringIncludes(local, "since the measurement was taken");
  assertStringIncludes(local, "Affected lines:");

  // Half an identity is reported as far as it goes: the run page is named and
  // no commit is invented for it.
  const runOnly = buildCoverageDebtUnattributedComment({
    groups: [{
      group: "tasks",
      target: 0,
      current: 1,
      baseline: {
        runUrl: "https://github.com/commonfabric/labs/actions/runs/900",
      },
    }],
    files: [{ relativePath: "tasks/test-records.ts", lines: [90] }],
    measurement: {
      runUrl: "https://github.com/commonfabric/labs/actions/runs/901",
    },
  });

  assertStringIncludes(runOnly, "Where this measurement came from:");
  assertStringIncludes(
    runOnly,
    "  Measuring run: https://github.com/commonfabric/labs/actions/runs/901",
  );
  assertStringIncludes(
    runOnly,
    "  Baseline for tasks: run https://github.com/commonfabric/labs/actions/runs/900\n",
  );
  assertFalse(runOnly.includes("Base commit measured:"));
  assertFalse(runOnly.includes("merged into that base commit"));
  assertStringIncludes(runOnly, "since the measurement was taken");
});

Deno.test("buildCoverageDebtUnattributedComment counts files and lines past the cap", () => {
  const comment = buildCoverageDebtUnattributedComment({
    groups: [{ group: "tasks", target: 0, current: 40 }],
    files: Array.from({ length: 25 }, (_, index) => ({
      relativePath: `tasks/file-${String(index).padStart(2, "0")}.ts`,
      lines: Array.from({ length: 30 }, (_, line) => line + 1),
    })),
  });

  // 20 files listed, 5 counted; 20 lines listed per file, 10 counted.
  assertStringIncludes(comment, "`tasks/file-19.ts`");
  assertFalse(comment.includes("`tasks/file-20.ts`"));
  assertStringIncludes(comment, "…and 5 more file(s)._");
  assertStringIncludes(comment, "…and 10 more");
});
