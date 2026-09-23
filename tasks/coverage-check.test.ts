import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import * as path from "@std/path";
import {
  type Artifact,
  type BaselineSample,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
  GitHubRateLimitError,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_FILE,
  type PRInfo,
  type WorkflowRun,
} from "./ci-check-lib.ts";
import {
  appendJobSummary,
  baselineLcovForRun,
  type BaselineRunContext,
  type BaselineRunListing,
  type BaselineRunReading,
  buildBaselineRunContext,
  buildCoverageJobSummary,
  buildCoverageRows,
  buildUnattributedRegressionBody,
  collectCurrentCacheStates,
  combinedLcovFromArtifacts,
  copyCoverageArtifactFiles,
  coverageOutcomeLine,
  type CoverageRatchetInput,
  CoverageRateLimitedError,
  currentWorkflowRunFromEvent,
  EXPECTED_COVERAGE_ARTIFACT_NAMES,
  fetchAncestorRanks,
  fetchArtifactsForRunBestEffort,
  fetchCurrentRunArtifacts,
  fetchGroupsChangedOnBase,
  fetchLatestBaselineRunSha,
  fetchPRForCommitWithError,
  formatCompileCacheStates,
  formatErrorForLog,
  formatMetricDelta,
  formatMetricValueForTable,
  guardRateLimit,
  isComparableBaseline,
  main,
  metricTableRows,
  newestArtifactNamed,
  parseCoverageBaselineFromArtifacts,
  parseMergedBaselineOverrides,
  printMetricTable,
  readBaseBranchSha,
  readBaselineRunListing,
  readHeadCommitObject,
  reportBaselineContextResults,
  reportBaselineDistance,
  reportBaselineRunListing,
  reportNotGated,
  reportUngatedGroups,
  type Row,
  runCoverageRatchet,
  selectBaselines,
  selectMergedPRForCommit,
  unscoredGroupsReport,
  walkBaselineRuns,
  workflowAnnotation,
  writeCoverageComment,
  writeCoverageDebtSuggestion,
  writeCoverageNotGated,
  writeCoverageResolved,
} from "./coverage-check.ts";
import { writeUnlaunchedMembers } from "./unlaunched-members.ts";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

function makeRun(
  id: number,
  headSha = SHA_A,
  createdAt = "2026-06-18T10:00:00Z",
): WorkflowRun {
  return {
    id,
    html_url: `https://github.com/commonfabric/labs/actions/runs/${id}`,
    head_sha: headSha,
    head_branch: "main",
    created_at: createdAt,
    conclusion: "success",
    event: "push",
  };
}

function makeArtifact(
  id: number,
  name: string,
  expired = false,
): Artifact {
  return {
    id,
    name,
    size_in_bytes: 12,
    expired,
  };
}

function makeSample(run = makeRun(1)): BaselineSample {
  return {
    runId: run.id,
    sha: run.head_sha,
    createdAt: run.created_at,
    uncoveredLines: 2,
  };
}

Deno.test("copyCoverageArtifactFiles reads a pre-downloaded artifact in place", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-artifact-" });
  const artifact = makeArtifact(17, "coverage-profile-workspace-1");
  const artifactsDir = path.join(root, "artifacts");
  const sourceDir = path.join(artifactsDir, artifact.name);
  const nestedSourceDir = path.join(sourceDir, "pattern-runtime");
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");

  try {
    await Promise.all([
      Deno.mkdir(nestedSourceDir, { recursive: true }),
      Deno.mkdir(profileDir),
      Deno.mkdir(lcovDir),
    ]);
    await Promise.all([
      Deno.writeTextFile(path.join(sourceDir, "runtime.lcov"), "runtime"),
      Deno.writeTextFile(
        path.join(nestedSourceDir, "pattern.pattern-coverage.lcov"),
        "pattern",
      ),
      Deno.writeTextFile(path.join(sourceDir, "profile.json"), "profile"),
      Deno.writeTextFile(path.join(sourceDir, "ignored.txt"), "ignored"),
    ]);

    assertEquals(
      await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
        artifactsDir,
      ),
      { profileFiles: 1, lcovFiles: 2, unlaunchedMembers: [] },
    );

    const copiedLcov: string[] = [];
    for await (const entry of Deno.readDir(lcovDir)) {
      copiedLcov.push(await Deno.readTextFile(path.join(lcovDir, entry.name)));
    }
    assertEquals(copiedLcov.sort(), ["pattern", "runtime"]);
    assertEquals(
      await Deno.readTextFile(
        path.join(profileDir, "coverage-profile-workspace-1-0-profile.json"),
      ),
      "profile",
    );
    assert((await Deno.stat(sourceDir)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyCoverageArtifactFiles reads the artifact's unlaunched-member record", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-unlaunched-" });
  const artifact = makeArtifact(21, "coverage-profile-workspace-3");
  const artifactsDir = path.join(root, "artifacts");
  const sourceDir = path.join(artifactsDir, artifact.name);
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");

  try {
    await Promise.all([
      Deno.mkdir(sourceDir, { recursive: true }),
      Deno.mkdir(profileDir),
      Deno.mkdir(lcovDir),
    ]);
    await Promise.all([
      Deno.writeTextFile(path.join(sourceDir, "workspace-3.lcov"), "workspace"),
      writeUnlaunchedMembers(sourceDir, ["./packages/shell", "./tasks"]),
    ]);

    assertEquals(
      await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
        artifactsDir,
      ),
      {
        profileFiles: 0,
        lcovFiles: 1,
        unlaunchedMembers: ["./packages/shell", "./tasks"],
      },
    );

    // The record is read rather than copied: a file `deno coverage` cannot
    // parse among the profiles would fail the whole conversion.
    assertEquals([...Deno.readDirSync(profileDir)], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyCoverageArtifactFiles rejects a missing pre-downloaded artifact", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-missing-" });
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");
  await Promise.all([Deno.mkdir(profileDir), Deno.mkdir(lcovDir)]);

  try {
    await assertRejects(
      () =>
        copyCoverageArtifactFiles(
          makeArtifact(18, "coverage-profile-workspace-2"),
          profileDir,
          lcovDir,
          path.join(root, "artifacts"),
        ),
      Error,
      "Pre-downloaded coverage profile artifact coverage-profile-workspace-2 (18) was not found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyCoverageArtifactFiles rejects an empty pre-downloaded artifact", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-empty-" });
  const artifact = makeArtifact(19, "coverage-profile-workspace-3");
  const artifactsDir = path.join(root, "artifacts");
  const sourceDir = path.join(artifactsDir, artifact.name);
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");
  await Promise.all([
    Deno.mkdir(sourceDir, { recursive: true }),
    Deno.mkdir(profileDir),
    Deno.mkdir(lcovDir),
  ]);

  try {
    await assertRejects(
      () =>
        copyCoverageArtifactFiles(
          artifact,
          profileDir,
          lcovDir,
          artifactsDir,
        ),
      Error,
      "contained no profile or LCOV files",
    );
    assert((await Deno.stat(sourceDir)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("coverage check pre-downloads coverage with strict integrity checks", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deno.yml", import.meta.url),
  );
  const start = workflow.indexOf("  coverage-check:\n");
  const end = workflow.indexOf("\n  attest-binaries:", start);
  assert(start >= 0 && end > start, "Coverage Check job not found");

  const job = workflow.slice(start, end);
  const downloadStart = job.indexOf("- name: 📥 Download coverage reports");
  const checkStart = job.indexOf("- name: 📊 Run coverage check");
  assert(
    downloadStart >= 0 && checkStart > downloadStart,
    "coverage reports must be downloaded before Coverage Check runs",
  );

  const downloadStep = job.slice(downloadStart, checkStart);
  assertStringIncludes(downloadStep, "uses: actions/download-artifact@");
  assertStringIncludes(downloadStep, "pattern: coverage-profile-*");
  assertStringIncludes(downloadStep, "path: coverage-artifacts");
  assertStringIncludes(downloadStep, "merge-multiple: false");
  assertStringIncludes(downloadStep, "skip-decompress: false");
  assertStringIncludes(downloadStep, "digest-mismatch: error");
  assertEquals(downloadStep.includes("continue-on-error"), false);
  assertStringIncludes(
    job.slice(checkStart),
    "COVERAGE_ARTIFACTS_DIR: coverage-artifacts",
  );
});

function makePR(number: number, mergedAt: string | null = null): PRInfo {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/commonfabric/labs/pull/${number}`,
    body: null,
    merged_at: mergedAt,
  };
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

async function withMockFetch<T>(
  handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: FetchInput, init?: FetchInit) =>
      Promise.resolve(handler(input, init))) as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function captureConsole<T>(
  callback: () => T,
): { result: T; logs: string[]; warnings: string[]; errors: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(" "));
  try {
    return { result: callback(), logs, warnings, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function captureConsoleAsync<T>(
  callback: () => Promise<T>,
): Promise<
  { result: T; logs: string[]; warnings: string[]; errors: string[] }
> {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(" "));
  try {
    return { result: await callback(), logs, warnings, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, Deno.env.get(key));
    const value = values[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`Deno.exit(${code})`);
  }
}

async function withMockExit(
  callback: () => Promise<void>,
): Promise<number | null> {
  const originalExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as typeof Deno.exit;
  try {
    await callback();
    return null;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  } finally {
    Deno.exit = originalExit;
  }
}

/**
 * Runs `callback`, then removes the perf-metrics artifact a run that gave up on
 * a rate limit writes into the working directory.
 */
async function withPerfArtifact<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } finally {
    await Deno.remove(PERF_METRICS_FILE).catch(() => {});
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

Deno.test("invalid merged PR baseline override metadata is ignored", () => {
  const warnings: string[] = [];
  const overrides = parseMergedBaselineOverrides(
    {
      number: 123,
      // Only `packages` splits below its top level, so a directory under
      // any other one names neither a source group nor a workspace
      // member, and accepting it throws.
      body: "ACCEPT_COVERAGE_DEBT: tasks/runner +7 lines",
    },
    (message) => warnings.push(message),
  );

  assertEquals(overrides, null);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "merged PR #123");
  assertStringIncludes(warnings[0], "name a coverage source group");
});

Deno.test("a merged PR's acceptance of a workspace member is not this ratchet's", () => {
  // It names a member deeper than any source group, which the coverage
  // gate reads and this ratchet measures nothing for.
  const overrides = parseMergedBaselineOverrides({
    number: 125,
    body: "ACCEPT_COVERAGE_DEBT: packages/connectors/github +7 lines",
  });

  assertEquals(overrides?.metrics.size, 0);
});

Deno.test("valid merged PR baseline override metadata is parsed", () => {
  const overrides = parseMergedBaselineOverrides({
    number: 124,
    body: "ACCEPT_COVERAGE_DEBT: packages/runner +7 lines",
  });

  assertEquals(
    overrides?.metrics.get("coverage-debt: packages/runner uncovered lines"),
    7,
  );
});

Deno.test("a merged PR's unreadable acceptance leaves the rest of it standing", () => {
  // A description that merged before the acceptance form changed cannot be
  // rewritten to suit this parser, so the marker it carries is passed over and
  // the reset marker beside it is still read.

  const warnings: string[] = [];
  const overrides = parseMergedBaselineOverrides(
    {
      number: 126,
      body:
        "ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines = 7 lines\n" +
        "NEW_COVERAGE_BASELINE",
    },
    (message) => warnings.push(message),
  );

  assertEquals(overrides?.metrics.size, 0);
  assertEquals(overrides?.coverageBaselineReset, true);
  assertEquals(warnings, []);
});

Deno.test("merged PR legacy coverage-debt acceptance is honored", () => {
  // A baseline PR merged before the marker rename accepted debt with
  // NEW_PERF_BASELINE; its acceptance must still register so it truncates the
  // baseline timeline.

  const overrides = parseMergedBaselineOverrides({
    number: 125,
    body:
      "NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 7 lines",
  });

  assertEquals(
    overrides?.metrics.get("coverage-debt: packages/runner uncovered lines"),
    7,
  );
});

function coverageRow(
  metric: string,
  current: number,
  baseline?: number,
  status: Row["status"] = baseline === undefined ? "n/a" : "OK",
): Row {
  return { metric, status, current, baseline };
}

/**
 * Run a writer with the coverage-comment output redirected to a temp file, then
 * return the parsed payload (or null when the writer produced no file).
 */
async function payloadFrom(
  write: () => Promise<void>,
): Promise<CoverageCommentPayload | null> {
  const dir = await Deno.makeTempDir({ prefix: "coverage-check-comment-" });
  const file = path.join(dir, "coverage-comment.json");
  Deno.env.set("COVERAGE_COMMENT_FILE", file);
  try {
    await write();
    try {
      return JSON.parse(await Deno.readTextFile(file));
    } catch {
      return null;
    }
  } finally {
    Deno.env.delete("COVERAGE_COMMENT_FILE");
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("writeCoverageComment writes a regression payload when coverage fails", async () => {
  const failures = [
    coverageRow("coverage-debt: tasks uncovered lines", 8, 4),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageComment(4211, failures, failures, [], "")
  );

  assertEquals(payload?.state, "regressed");
  assertStringIncludes(payload?.body ?? "", COVERAGE_SUGGESTION_MARKER);
  // Over by 8 - 4 = 4 lines.
  assertStringIncludes(
    payload?.body ?? "",
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 4 lines</h3></summary>",
  );
});

Deno.test("writeCoverageComment writes an ungated payload when a changed group had no baseline", async () => {
  const payload = await payloadFrom(() =>
    writeCoverageComment(
      42,
      [],
      [coverageRow(
        "coverage-debt: tasks uncovered lines",
        9,
        undefined,
        "excl",
      )],
      [],
      "",
      {
        groups: [{ group: "tasks", reason: "no-baseline" }],
        measurement: { baseSha: SHA_C },
      },
    )
  );

  assertEquals(payload?.prNumber, 42);
  assertEquals(payload?.state, "ungated");
  assertStringIncludes(payload?.body ?? "", COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(
    payload?.body ?? "",
    "Test coverage was NOT gated on this run",
  );
  assertStringIncludes(payload?.body ?? "", "base-branch commit `cccccccc`");
});

Deno.test("writeCoverageComment reports a regression ahead of an ungated group", async () => {
  const payload = await payloadFrom(() =>
    writeCoverageComment(
      42,
      [coverageRow("coverage-debt: tasks uncovered lines", 9, 5, "OVER")],
      [coverageRow("coverage-debt: tasks uncovered lines", 9, 5, "OVER")],
      [],
      "",
      {
        groups: [{ group: "packages/ui", reason: "no-baseline" }],
      },
    )
  );

  assertEquals(payload?.state, "regressed");
});

Deno.test("writeCoverageComment writes a resolved payload when every changed group was gated", async () => {
  const payload = await payloadFrom(() =>
    writeCoverageComment(
      42,
      [],
      [coverageRow("coverage-debt: tasks uncovered lines", 5, 5)],
      [],
      "",
      { groups: [] },
    )
  );

  assertEquals(payload?.state, "resolved");
});

Deno.test("writeCoverageNotGated swallows a payload it cannot write", async () => {
  const { warnings } = await captureConsoleAsync(() =>
    withEnv(
      { COVERAGE_COMMENT_FILE: "/nonexistent-directory/coverage-comment.json" },
      () =>
        writeCoverageNotGated(42, {
          groups: [{ group: "tasks", reason: "no-baseline" }],
        }),
    )
  );

  assertStringIncludes(
    warnings.join("\n"),
    "could not write the not-gated coverage comment for PR #42",
  );
});

Deno.test("writeCoverageComment writes a resolved payload reporting the gated reduction", async () => {
  const rows = [
    // The workspace aggregate is never gated (status "excl"), so its large
    // delta must not count toward the PR's reported reduction.
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    // A gated group the PR touched, now 5 lines below its baseline.
    coverageRow("coverage-debt: tasks uncovered lines", 4, 9),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageComment(4211, [], rows, [{ filename: "tasks/foo.ts" }], "")
  );

  assertEquals(payload?.state, "resolved");
  // Only the gated group counts: 9 - 4 = 5 lines; the workspace delta is excluded.
  assertEquals(payload?.improvedLines, 5);
  // The changed `tasks` group is summarized; workspace stays out of it.
  assertEquals(payload?.groups, [
    { group: "tasks", baseline: 9, current: 4 },
  ]);
});

Deno.test("writeCoverageResolved omits groups the PR did not change", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    coverageRow("coverage-debt: tasks uncovered lines", 4, 6),
  ];
  // No changed files map to a coverage group, so there is no per-group summary.
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{ filename: "README.md" }], "")
  );

  assertEquals(payload?.state, "resolved");
  // Only the gated `tasks` group counts: 6 - 4 = 2 lines.
  assertEquals(payload?.improvedLines, 2);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageResolved flags a changed group whose debt was overridden", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    // The PR changed `tasks` and accepted its regression with an override.
    coverageRow("coverage-debt: tasks uncovered lines", 15, 12, "ovrd"),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{ filename: "tasks/foo.ts" }], "")
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.overridden, true);
  // An override contributes no reduction, but the group still appears.
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, [
    { group: "tasks", baseline: 12, current: 15 },
  ]);
  // The changed file carries no patch, so no line can be attributed to it.
  assertEquals(payload?.files, []);
});

Deno.test("writeCoverageResolved names the files an accepted debt stands in for", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    coverageRow("coverage-debt: tasks uncovered lines", 15, 12, "ovrd"),
  ];
  // Lines 10 and 11 are uncovered and added; 12 is added but covered, and 20 is
  // uncovered but not added. Only the overlap is the PR's new uncovered debt.
  const lcov = [
    `SF:${path.join(Deno.cwd(), "tasks/foo.ts")}`,
    "DA:10,0",
    "DA:11,0",
    "DA:12,4",
    "DA:20,0",
    "end_of_record",
  ].join("\n");
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{
      filename: "tasks/foo.ts",
      patch: ["@@ -9,0 +10,3 @@", "+one", "+two", "+three"].join("\n"),
    }], lcov)
  );

  assertEquals(payload?.overridden, true);
  assertEquals(payload?.files, [
    { relativePath: "tasks/foo.ts", group: "tasks", uncoveredCount: 2 },
  ]);
});

Deno.test("writeCoverageResolved preserves an accepted unchanged-file attribution", async () => {
  await withFlakyLineCheckout(async ({ rootDir, lcov, baselineLcov }) => {
    const rows: Row[] = [{ ...unattributedFailure(), status: "ovrd" }];
    const payload = await payloadFrom(() =>
      writeCoverageResolved(
        4211,
        rows,
        // The PR changed this coverage group, but not the file whose coverage
        // moved between otherwise comparable runs.
        [{ filename: "packages/example/src/changed.ts" }],
        lcov,
        {
          rootDir,
          readBaselineLcov: (runId) => {
            assertEquals(runId, 900);
            return Promise.resolve(baselineLcov);
          },
        },
      )
    );

    assertEquals(payload?.overridden, true);
    // The resolved payload replaces the detailed failing comment, so it must
    // carry the unchanged-file diagnosis forward rather than erase it.
    assertEquals(payload?.files, [{
      relativePath: "packages/example/src/racy.ts",
      group: "packages/example",
      uncoveredCount: 1,
    }]);
  });
});

Deno.test("writeCoverageResolved leaves the file list empty when nothing was overridden", async () => {
  const rows = [
    coverageRow("coverage-debt: tasks uncovered lines", 4, 9),
  ];
  const lcov = [
    `SF:${path.join(Deno.cwd(), "tasks/foo.ts")}`,
    "DA:10,0",
    "end_of_record",
  ].join("\n");
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{
      filename: "tasks/foo.ts",
      patch: ["@@ -9,0 +10,1 @@", "+one"].join("\n"),
    }], lcov)
  );

  // The group passed on its own, so there is no acceptance to account for.
  assertEquals(payload?.overridden, false);
  assertEquals(payload?.files, []);
});

Deno.test("writeCoverageResolved sums gated groups and ignores workspace and overrides", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 1000, 2000, "excl"),
    coverageRow("coverage-debt: memory uncovered lines", 1680, 1686), // -6
    coverageRow("coverage-debt: runner uncovered lines", 8860, 8868), // -8
    // An overridden group accepted its debt, so it does not count as a reduction.
    coverageRow("coverage-debt: identity uncovered lines", 50, 60, "ovrd"),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [], "")
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 14); // 6 + 8
  assertEquals(payload?.groups, []);
  // The overridden group is not one this PR changed, so it is not flagged.
  assertEquals(payload?.overridden, false);
});

Deno.test("writeCoverageResolved reports zero improvement when gated groups sit at baseline", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    coverageRow("coverage-debt: tasks uncovered lines", 4, 4),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [], "")
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageResolved reports zero improvement without a workspace baseline", async () => {
  const rows = [coverageRow("coverage-debt: workspace uncovered lines", 100)];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [], "")
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageDebtSuggestion writes nothing when no coverage group resolves", async () => {
  const failures: Row[] = [
    { metric: "job: Check", status: "OVER", current: 5, baseline: 3 },
  ];
  const payload = await payloadFrom(() =>
    writeCoverageDebtSuggestion(4211, failures, [], "")
  );

  assertEquals(payload, null);
});

Deno.test("fetchLatestBaselineRunSha reads the newest baseline run's head", async () => {
  // The newest page holds a pull request run and a failed push ahead of the
  // newest run a baseline could come from.
  const result = await withMockFetch(
    (input) => {
      const query = new URL(String(input)).searchParams;
      assertStringIncludes(String(input), "/actions/workflows/deno.yml/runs?");
      assertEquals(query.get("page"), "1");
      assertEquals(query.get("status"), null);
      return jsonResponse({
        workflow_runs: [
          { ...makeRun(4, SHA_C), event: "pull_request", head_branch: "fix" },
          { ...makeRun(3, SHA_B), conclusion: "failure" },
          makeRun(2, SHA_A),
          makeRun(1, SHA_B),
        ],
      });
    },
    () => fetchLatestBaselineRunSha(),
  );

  assertEquals(result, SHA_A);
});

Deno.test("fetchLatestBaselineRunSha reads past a page that holds no baseline run", async () => {
  // A stretch of failing `main` runs fills the newest page.
  const asked: number[] = [];
  const pages = [listingPage(1300), listingPage(1200, [1150, 1120])];
  const result = await fetchLatestBaselineRunSha((page) => {
    asked.push(page);
    return Promise.resolve(
      pages[page - 1].map((run) =>
        run.id === 1150 ? { ...run, head_sha: SHA_B } : run
      ),
    );
  });

  assertEquals(result, SHA_B);
  assertEquals(asked, [1, 2]);
});

Deno.test("fetchLatestBaselineRunSha gives up at the listing's page budget", async () => {
  const asked: number[] = [];
  const result = await fetchLatestBaselineRunSha((page) => {
    asked.push(page);
    return Promise.resolve(listingPage(5000 - page * 100));
  });

  assertEquals(result, undefined);
  assertEquals(asked.length, 10);
});

Deno.test("fetchLatestBaselineRunSha is undefined when no baseline run exists", async () => {
  const result = await withMockFetch(
    () => new Response(JSON.stringify({ workflow_runs: [] })),
    () => fetchLatestBaselineRunSha(),
  );

  assertEquals(result, undefined);
});

/** When a run with this id was created: a larger id is a later run. */
function createdAtFor(id: number): string {
  return new Date(Date.UTC(2026, 8, 17) + id * 1000).toISOString();
}

/**
 * A full page of the run listing: pull request runs with ids descending from
 * `newestId`, except the ids in `mainPushes`, which are successful pushes to
 * `main`.
 */
function listingPage(
  newestId: number,
  mainPushes: number[] = [],
  length = 100,
): WorkflowRun[] {
  return Array.from({ length }, (_, index) => {
    const id = newestId - index;
    const run = makeRun(id, SHA_A, createdAtFor(id));
    return mainPushes.includes(id)
      ? run
      : { ...run, event: "pull_request", head_branch: "fix" };
  });
}

/** Reads a listing made of `pages`, recording the pages asked for. */
async function readListing(
  pages: WorkflowRun[][] | ((attempt: number) => WorkflowRun[][]),
  currentRunId: number,
  options: { maxPages?: number } = {},
) {
  const asked: number[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let attempt = 0;
  const listing = await readBaselineRunListing({
    currentRunId,
    fetchPage: (page) => {
      if (page === 1) attempt++;
      asked.push(page);
      const source = typeof pages === "function" ? pages(attempt) : pages;
      return Promise.resolve(source[page - 1] ?? []);
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    ...options,
  });
  return { listing, asked, waits, logs, warnings };
}

Deno.test("readBaselineRunListing finds the run asking on the newest page", async () => {
  const { listing, asked, waits } = await readListing(
    [listingPage(1100, [1090, 1042, 1007])],
    1050,
  );

  assertEquals(listing.current, true);
  assertEquals(listing.reachedCurrentRun, true);
  assertEquals(listing.pagesRead, 1);
  assertEquals(listing.newest?.id, 1100);
  // Only the successful pushes to `main`, newest first, the ones created after
  // the run asking among them: the ancestry decides which can be a baseline.
  assertEquals(listing.candidates.map((run) => run.id), [1090, 1042, 1007]);
  assertEquals(asked, [1]);
  assertEquals(waits, []);
});

Deno.test("readBaselineRunListing reads further back for a run created long ago", async () => {
  const { listing, asked } = await readListing(
    [
      listingPage(1300, [1250]),
      listingPage(1200, [1150]),
      listingPage(1100, [1090, 1020]),
    ],
    1050,
  );

  assertEquals(listing.current, true);
  assertEquals(listing.reachedCurrentRun, true);
  assertEquals(listing.pagesRead, 3);
  assertEquals(listing.candidates.map((run) => run.id), [
    1250,
    1150,
    1090,
    1020,
  ]);
  assertEquals(asked, [1, 2, 3]);
});

Deno.test("readBaselineRunListing judges a listing of older runs not current", async () => {
  // A window of runs that ended long before the run asking was created, which
  // is what a listing served from an index that stopped updating looks like.
  const { listing, asked, waits, warnings } = await readListing(
    [listingPage(500, [500, 480]), listingPage(400, [390])],
    1050,
  );

  assertEquals(listing.current, false);
  assertEquals(listing.reachedCurrentRun, false);
  assertEquals(listing.newest?.id, 500);
  // Each reading takes the page of grace, and the listing is read three times.
  assertEquals(asked, [1, 2, 1, 2, 1, 2]);
  assertEquals(waits, [2_000, 4_000]);
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], "left out this run, 1050");
  assertStringIncludes(warnings[0], "run 500");
  assertStringIncludes(warnings[0], "attempt 2 of 3");
});

Deno.test("readBaselineRunListing takes a later reading that shows the run", async () => {
  const { listing, asked, waits, warnings } = await readListing(
    (attempt) =>
      attempt === 1
        ? [listingPage(500, [500]), listingPage(400)]
        : [listingPage(1100, [1042])],
    1050,
  );

  assertEquals(listing.current, true);
  assertEquals(listing.newest?.id, 1100);
  // Nothing the first reading named survives into the second.
  assertEquals(listing.candidates.map((run) => run.id), [1042]);
  assertEquals(asked, [1, 2, 1]);
  assertEquals(waits, [2_000]);
  assertEquals(warnings.length, 1);
});

Deno.test("readBaselineRunListing lets the run asking open the page after an older run", async () => {
  // Two runs created together, in an order that puts the older one last on its
  // page and the run asking first on the next.
  const first = [...listingPage(1150, [], 99), listingPage(1049, [], 1)[0]];
  const { listing, asked, waits } = await readListing(
    [first, listingPage(1050, [1042])],
    1050,
  );

  assertEquals(listing.current, true);
  assertEquals(listing.reachedCurrentRun, true);
  // Run 1049 is on both pages and is read once.
  assertEquals(listing.pagesRead, 2);
  assertEquals(asked, [1, 2]);
  assertEquals(waits, []);
});

Deno.test("readBaselineRunListing judges a listing that ends without the run not current", async () => {
  const { listing, asked } = await readListing(
    [listingPage(1300, [1250], 40)],
    1050,
  );

  assertEquals(listing.current, false);
  assertEquals(asked, [1, 1, 1]);
});

Deno.test("readBaselineRunListing leaves a run beyond its reach unjudged", async () => {
  // Every run on the pages read was created after the run asking, so nothing
  // says the listing skipped it.
  const { listing, asked, waits } = await readListing(
    [listingPage(1400, [1390]), listingPage(1300, [1250]), listingPage(1200)],
    1050,
    { maxPages: 2 },
  );

  assertEquals(listing.current, true);
  assertEquals(listing.reachedCurrentRun, false);
  assertEquals(listing.candidates.map((run) => run.id), [1390, 1250]);
  assertEquals(asked, [1, 2]);
  assertEquals(waits, []);
  // The page budget is spent, so there is no older page to hand the walk.
  assertEquals(await listing.older(), null);
});

Deno.test("readBaselineRunListing hands over older pages one at a time", async () => {
  // A run created between two reads pushes run 1001 onto the second page too.
  const second = [...listingPage(1001, [1001, 960], 100)];
  const { listing, asked, logs } = await readListing(
    [listingPage(1100, [1042, 1001]), second, listingPage(901, [880], 30)],
    1050,
  );

  assertEquals(listing.candidates.map((run) => run.id), [1042, 1001]);
  assertEquals((await listing.older())?.map((run) => run.id), [960]);
  assertEquals((await listing.older())?.map((run) => run.id), [880]);
  // The third page was short, so the listing has ended.
  assertEquals(await listing.older(), null);
  assertEquals(asked, [1, 2, 3]);
  assertStringIncludes(logs.join("\n"), "Reading page 2");
});

Deno.test("readBaselineRunListing accounts for a commit whose push run it has shown", async () => {
  // A run still going and one that failed are runs the ratchet cannot use, and
  // having shown them is what says there is nothing further back to find.
  const page = listingPage(1100, [1090, 1080, 1070]).map((run) =>
    run.id === 1090
      ? { ...run, head_sha: SHA_C, conclusion: null as unknown as string }
      : run.id === 1080
      ? { ...run, head_sha: SHA_B, conclusion: "failure" }
      : run
  );
  const { listing } = await readListing([page], 1050);

  assertEquals(listing.candidates.map((run) => run.id), [1070]);
  assertEquals(listing.accountsFor(SHA_C), true);
  assertEquals(listing.accountsFor(SHA_B), true);
  assertEquals(listing.accountsFor("d".repeat(40)), false);
});

Deno.test("readBaselineRunListing accounts for no commit whose push run it has not shown", async () => {
  // However far back the pages reach, a commit with no run on them may have
  // one further back, until a page shows it.
  const late = "d".repeat(40);
  const second = listingPage(1000, [950]).map((run) =>
    run.id === 950 ? { ...run, head_sha: late } : run
  );
  const { listing } = await readListing([listingPage(1100), second], 1050);

  assertEquals(listing.accountsFor(late), false);
  await listing.older();
  assertEquals(listing.accountsFor(late), true);
  assertEquals(listing.accountsFor("e".repeat(40)), false);
});

Deno.test("reportBaselineRunListing says what a current listing held", () => {
  const logs: string[] = [];
  const warnings: string[] = [];
  reportBaselineRunListing(
    {
      current: true,
      reachedCurrentRun: true,
      candidates: [makeRun(1042), makeRun(1007)],
      newest: makeRun(1100, SHA_B, "2026-09-17T20:41:15Z"),
      pagesRead: 1,
      older: () => Promise.resolve(null),
      accountsFor: () => true,
    },
    1050,
    (message) => logs.push(message),
    (message) => warnings.push(message),
  );

  assertEquals(warnings, []);
  assertStringIncludes(logs[0], "Read 1 page of the workflow's run listing");
  assertStringIncludes(
    logs[0],
    "run 1100 (2026-09-17T20:41:15Z) for bbbbbbbb",
  );
  assertStringIncludes(logs[0], "2 successful `main` push runs");
});

Deno.test("reportBaselineRunListing warns about a run the listing did not reach", () => {
  const warnings: string[] = [];
  reportBaselineRunListing(
    {
      current: true,
      reachedCurrentRun: false,
      candidates: [],
      newest: makeRun(1400),
      pagesRead: 10,
      older: () => Promise.resolve(null),
      accountsFor: () => true,
    },
    1050,
    () => {},
    (message) => warnings.push(message),
  );

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "created longer ago than 10 pages");
  assertStringIncludes(warnings[0], "out of reach");
});

Deno.test("reportBaselineRunListing names the newest run of a listing that is not current", () => {
  const logs: string[] = [];
  const warnings: string[] = [];
  reportBaselineRunListing(
    {
      current: false,
      reachedCurrentRun: false,
      candidates: [],
      newest: makeRun(32577018558, SHA_A, "2026-08-22T13:52:12Z"),
      pagesRead: 2,
      older: () => Promise.resolve(null),
      accountsFor: () => true,
    },
    35254926993,
    (message) => logs.push(message),
    (message) => warnings.push(message),
  );

  assertEquals(logs, []);
  assertStringIncludes(warnings[0], "is not current");
  assertStringIncludes(warnings[0], "never showed this run, 35254926993");
  assertStringIncludes(
    warnings[0],
    "run 32577018558 (2026-08-22T13:52:12Z) for aaaaaaaa",
  );
});

Deno.test("reportBaselineRunListing says when a listing named no run at all", () => {
  const warnings: string[] = [];
  reportBaselineRunListing(
    {
      current: false,
      reachedCurrentRun: false,
      candidates: [],
      newest: undefined,
      pagesRead: 1,
      older: () => Promise.resolve(null),
      accountsFor: () => true,
    },
    1050,
    () => {},
    (message) => warnings.push(message),
  );

  assertStringIncludes(warnings[0], "the newest run it named is nothing");
});

Deno.test("fetchPRForCommitWithError returns selected PR metadata", async () => {
  const pr = makePR(42, "2026-06-18T00:00:00Z");
  const result = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/commits/${SHA_A}/pulls`);
      return new Response(JSON.stringify([pr]));
    },
    () => fetchPRForCommitWithError(SHA_A),
  );

  assertEquals(result, { pr, error: null });
});

Deno.test("fetchPRForCommitWithError captures lookup errors", async () => {
  const result = await withMockFetch(
    () => new Response("missing", { status: 404 }),
    () => fetchPRForCommitWithError(SHA_A),
  );

  assertEquals(result.pr, null);
  assertStringIncludes(String(result.error), "GitHub API GET 404");
});

Deno.test("newestArtifactNamed filters expired artifacts and keeps newest id", () => {
  assertEquals(
    newestArtifactNamed(
      [
        makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(3, PERF_METRICS_ARTIFACT_NAME, true),
        makeArtifact(2, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(4, "other"),
      ],
      PERF_METRICS_ARTIFACT_NAME,
    )?.id,
    2,
  );
  assertEquals(newestArtifactNamed([], PERF_METRICS_ARTIFACT_NAME), null);
});

Deno.test("formatErrorForLog keeps the first line only", () => {
  assertEquals(formatErrorForLog(new Error("first\nsecond")), "first");
  assertEquals(formatErrorForLog("plain\nsecond"), "plain");
});

Deno.test("guardRateLimit writes the stamped artifact and throws on rate limits", async () => {
  const metrics = new Map<string, BaselineSample>([
    ["job: Check", makeSample()],
  ]);

  await withPerfArtifact(async () => {
    const captured = await captureConsoleAsync(() =>
      assertRejects(
        () =>
          guardRateLimit(
            "collecting test data",
            () => Promise.reject(new Error("rate limit exceeded")),
            { metrics, compileCacheStates: { "pattern-unit": "cold" } },
          ),
        CoverageRateLimitedError,
      )
    );

    // The caller that ends the check reads what the limit stopped off the
    // message, so it names the read rather than the error it arrived as.
    assertStringIncludes(captured.result.message, "collecting test data");
    assertStringIncludes(captured.warnings.join("\n"), "rate limit");
    assertStringIncludes(
      captured.logs.join("\n"),
      `Wrote ${PERF_METRICS_FILE}`,
    );
    const file = JSON.parse(await Deno.readTextFile(PERF_METRICS_FILE));
    assertEquals(file.metrics[0].name, "job: Check");
    // A run the rate limit ends still carries the compile cache stamp, so a
    // later run reading this artifact still sees that this run was cold.
    assertEquals(file.compileCacheStates, { "pattern-unit": "cold" });
  });
});

Deno.test("guardRateLimit rethrows non-rate-limit errors", async () => {
  await assertRejects(
    () =>
      guardRateLimit(
        "collecting test data",
        () => Promise.reject(new Error("plain failure")),
        { metrics: new Map() },
      ),
    Error,
    "plain failure",
  );
});

Deno.test("metric table helpers name the group and its change", () => {
  const row: Row = {
    metric: "coverage-debt: tasks uncovered lines",
    status: "OK",
    current: 12.4,
    baseline: 10,
    pctIncrease: 24,
  };
  const pendingRow: Row = {
    metric: "coverage-debt: tasks uncovered lines",
    status: "n/a",
    current: 9,
  };

  assertEquals(formatMetricValueForTable(row.current), "12");
  assertEquals(formatMetricValueForTable(undefined), "-");
  assertEquals(formatMetricDelta(pendingRow), "-");
  assertEquals(formatMetricDelta(row), "+2 (+24%)");
  assertEquals(metricTableRows([row], true)[0], [
    "OK",
    "10",
    "12",
    "+2 (+24%)",
    "tasks",
  ]);
  assertEquals(metricTableRows([row], false)[0][0], "10");
});

Deno.test("printMetricTable renders status and non-status tables", () => {
  const row: Row = {
    metric: "coverage-debt: tasks uncovered lines",
    status: "OK",
    current: 9,
    baseline: 8,
    pctIncrease: 12.5,
  };

  const withStatus = captureConsole(() => printMetricTable([row], true));
  assertStringIncludes(withStatus.logs.join("\n"), "Status");
  assertStringIncludes(withStatus.logs.join("\n"), "OK");

  const withoutStatus = captureConsole(() => printMetricTable([row], false));
  assertStringIncludes(withoutStatus.logs.join("\n"), "Baseline");
  assertEquals(withoutStatus.logs.join("\n").includes("Status"), false);
});

Deno.test("currentWorkflowRunFromEvent reads event and environment metadata", () => {
  const previousSha = Deno.env.get("GITHUB_SHA");
  const previousEventName = Deno.env.get("GITHUB_EVENT_NAME");
  try {
    Deno.env.set("GITHUB_SHA", SHA_B);
    Deno.env.set("GITHUB_EVENT_NAME", "push");
    assertEquals(
      currentWorkflowRunFromEvent(
        { pull_request: { head: { sha: SHA_A } } },
        7,
      ).head_sha,
      SHA_A,
    );
    const fallback = currentWorkflowRunFromEvent(undefined, 8);
    assertEquals(fallback.head_sha, SHA_B);
    assertEquals(fallback.event, "push");
    Deno.env.delete("GITHUB_EVENT_NAME");
    assertEquals(currentWorkflowRunFromEvent(undefined, 9).event, "");
  } finally {
    if (previousSha === undefined) Deno.env.delete("GITHUB_SHA");
    else Deno.env.set("GITHUB_SHA", previousSha);
    if (previousEventName === undefined) Deno.env.delete("GITHUB_EVENT_NAME");
    else Deno.env.set("GITHUB_EVENT_NAME", previousEventName);
  }
});

Deno.test("reportBaselineContextResults lists each run's PR and artifact", () => {
  const contexts: BaselineRunContext[] = [
    {
      run: makeRun(1, SHA_A, "2026-06-18T10:00:00Z"),
      artifacts: [
        makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(3, PERF_METRICS_ARTIFACT_NAME, true),
        makeArtifact(2, PERF_METRICS_ARTIFACT_NAME),
      ],
      pr: makePR(10, "2026-06-18T00:00:00Z"),
      prLookupError: null,
    },
    {
      run: makeRun(2, SHA_B, "2026-06-18T11:00:00Z"),
      artifacts: [],
      pr: null,
      prLookupError: null,
    },
  ];

  const captured = captureConsole(() => reportBaselineContextResults(contexts));
  const output = captured.logs.join("\n");

  assertStringIncludes(output, "Baseline source runs:");
  assertStringIncludes(
    output,
    `2026-06-18T10:00:00Z run 1 ${
      SHA_A.slice(0, 8)
    } PR #10; perf-metrics artifact 2`,
  );
  assertStringIncludes(
    output,
    `2026-06-18T11:00:00Z run 2 ${
      SHA_B.slice(0, 8)
    } no PR found; no perf-metrics artifact`,
  );
  assertEquals(captured.warnings, []);
});

Deno.test("reportBaselineContextResults names each failed PR lookup", () => {
  const contexts: BaselineRunContext[] = [
    {
      run: makeRun(1, SHA_A),
      artifacts: [],
      pr: makePR(10, "2026-06-18T00:00:00Z"),
      prLookupError: null,
    },
    {
      run: makeRun(2, SHA_B),
      artifacts: [],
      pr: null,
      prLookupError: new Error("lookup failed\nsecond line"),
    },
  ];

  const captured = captureConsole(() => reportBaselineContextResults(contexts));

  assertStringIncludes(captured.logs.join("\n"), "PR lookup failed;");
  assertEquals(captured.warnings, [
    `  Warning: run 2 (${SHA_B.slice(0, 8)}) PR lookup failed: lookup failed`,
  ]);
});

Deno.test("fetchArtifactsForRunBestEffort returns artifacts or an empty fallback", async () => {
  const run = makeRun(99);
  const artifact = makeArtifact(1, PERF_METRICS_ARTIFACT_NAME);
  const warnings: string[] = [];

  assertEquals(
    await fetchArtifactsForRunBestEffort(run, (runId) => {
      assertEquals(runId, 99);
      return Promise.resolve([artifact]);
    }, (message) => warnings.push(message)),
    [artifact],
  );
  assertEquals(warnings, []);

  assertEquals(
    await fetchArtifactsForRunBestEffort(
      run,
      () => {
        throw new Error("artifact API failed");
      },
      (message) => warnings.push(message),
    ),
    [],
  );
  assertStringIncludes(warnings.join("\n"), "artifact API failed");
});

Deno.test("buildBaselineRunContext collects artifacts and PRs", async () => {
  const run = makeRun(11, SHA_A);
  const artifact = makeArtifact(5, PERF_METRICS_ARTIFACT_NAME);
  const pr = makePR(11, "2026-06-18T00:00:00Z");

  const context = await buildBaselineRunContext({
    run,
    fetchArtifactsForRun: (requestedRun) => {
      assertEquals(requestedRun, run);
      return Promise.resolve([artifact]);
    },
    fetchPRForCommit: (sha) => {
      assertEquals(sha, SHA_A);
      return Promise.resolve({ pr, error: null });
    },
  });

  assertEquals(context, {
    run,
    artifacts: [artifact],
    pr,
    prLookupError: null,
  });
});

Deno.test("parseCoverageBaselineFromArtifacts uses newest coverage baseline artifact", async () => {
  const parsed = {
    metrics: new Map<string, BaselineSample>([["job: Check", makeSample()]]),
    compileCacheStates: { "pattern-unit": "warm" as const },
  };
  let parsedArtifactId = 0;

  const result = await parseCoverageBaselineFromArtifacts(
    [
      makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
      makeArtifact(3, PERF_METRICS_ARTIFACT_NAME),
      makeArtifact(4, PERF_METRICS_ARTIFACT_NAME, true),
    ],
    (artifactId) => {
      parsedArtifactId = artifactId;
      return Promise.resolve(parsed);
    },
  );

  assertEquals(result, parsed);
  assertEquals(parsedArtifactId, 3);
  assertEquals(
    await parseCoverageBaselineFromArtifacts([], () => {
      throw new Error("should not parse without an artifact");
    }),
    null,
  );
});

function cacheStateJson(
  family: string,
  shard: string,
  matchedKey: string,
): string {
  return JSON.stringify({
    family,
    shard,
    matchedKey,
    exactHit: matchedKey !== "",
  });
}

Deno.test("collectCurrentCacheStates aggregates shard records per family", async () => {
  const contentsById: Record<number, string[]> = {
    1: [cacheStateJson("generated-patterns", "1", "")],
    2: [cacheStateJson("generated-patterns", "2", "compile-abc")],
    3: [cacheStateJson("pattern-integration", "1", "compile-abc")],
  };
  const downloaded: number[] = [];

  const states = await collectCurrentCacheStates(
    [
      makeArtifact(1, "cache-state-generated-patterns-1"),
      makeArtifact(2, "cache-state-generated-patterns-2"),
      makeArtifact(3, "cache-state-pattern-integration-1"),
      // Not cache-state artifacts, or expired — never downloaded.
      makeArtifact(4, "test-timing-pattern-unit-1"),
      makeArtifact(5, "cache-state-pattern-unit-1", true),
    ],
    (artifactId) => {
      downloaded.push(artifactId);
      return Promise.resolve(contentsById[artifactId] ?? []);
    },
  );

  // One full-miss shard makes generated-patterns cold; pattern-integration is
  // warm; pattern-unit has no usable records and stays unknown.
  assertEquals(states, {
    "generated-patterns": "cold",
    "pattern-integration": "warm",
  });
  assertEquals(downloaded.sort((a, b) => a - b), [1, 2, 3]);
});

Deno.test("collectCurrentCacheStates keeps only the newest re-run duplicate", async () => {
  const downloaded: number[] = [];

  const states = await collectCurrentCacheStates(
    [
      // A re-run uploads a same-named artifact; the newest one wins, and a
      // re-run is genuinely warm (the cold first attempt saved the cache).
      makeArtifact(1, "cache-state-pattern-unit-1"),
      makeArtifact(9, "cache-state-pattern-unit-1"),
    ],
    (artifactId) => {
      downloaded.push(artifactId);
      return Promise.resolve([
        cacheStateJson(
          "pattern-unit",
          "1",
          artifactId === 9 ? "compile-abc" : "",
        ),
      ]);
    },
  );

  assertEquals(states, { "pattern-unit": "warm" });
  assertEquals(downloaded, [9]);
});

Deno.test("collectCurrentCacheStates degrades to unknown on download failure", async () => {
  const captured = await captureConsoleAsync(() =>
    collectCurrentCacheStates(
      [
        makeArtifact(1, "cache-state-generated-patterns-1"),
        makeArtifact(2, "cache-state-pattern-integration-1"),
      ],
      (artifactId) =>
        Promise.resolve(
          artifactId === 1
            ? [cacheStateJson("generated-patterns", "1", "compile-abc")]
            : null,
        ),
    )
  );

  // Partial data could mislabel a family, so any failure drops everything.
  assertEquals(captured.result, {});
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not collect compile cache states",
  );
});

Deno.test("collectCurrentCacheStates degrades to unknown on a malformed record", async () => {
  const captured = await captureConsoleAsync(() =>
    collectCurrentCacheStates(
      [
        makeArtifact(1, "cache-state-generated-patterns-1"),
        makeArtifact(2, "cache-state-generated-patterns-2"),
      ],
      (artifactId) =>
        Promise.resolve(
          artifactId === 1
            ? [cacheStateJson("generated-patterns", "1", "compile-abc")]
            : ["not json {"],
        ),
    )
  );

  // The unreadable record could be the cold shard; the surviving warm record
  // must not tag the family warm, so everything degrades to unknown.
  assertEquals(captured.result, {});
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not collect compile cache states",
  );
});

Deno.test("formatCompileCacheStates shows every family, absent as unknown", () => {
  assertEquals(
    formatCompileCacheStates({ "generated-patterns": "cold" }),
    "generated-patterns=cold, pattern-integration=unknown, pattern-unit=unknown",
  );
});

Deno.test("main reports no coverage data and exits cleanly without coverage artifacts", async () => {
  const eventPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(eventPath, JSON.stringify({ after: SHA_C }));

  const currentRunId = 123;
  // The newest main-push run seeds the compile-fingerprint fallback; its head
  // differs from this run's SHA, so the classifier compares them.
  const latestBaselineRun = makeRun(201, SHA_A, "2026-06-18T10:00:00Z");
  const jobsForRun = (runId: number) => ({
    jobs: [
      {
        id: runId * 10,
        name: "Check",
        started_at: "2026-06-18T12:00:00Z",
        completed_at: "2026-06-18T12:00:10Z",
        steps: [
          {
            name: "Run checks",
            started_at: "2026-06-18T12:00:01Z",
            completed_at: "2026-06-18T12:00:09Z",
          },
        ],
      },
    ],
  });

  try {
    const captured = await captureConsoleAsync(() =>
      withEnv(
        {
          GITHUB_TOKEN: "test-token",
          GITHUB_RUN_ID: String(currentRunId),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "workflow_run",
          GITHUB_SHA: SHA_C,
          PR_NUMBER: "",
        },
        () =>
          withMockFetch(
            (input) => {
              const url = String(input);
              if (url.includes("/actions/workflows/deno.yml/runs?")) {
                return jsonResponse({ workflow_runs: [latestBaselineRun] });
              }
              if (url.includes(`/actions/runs/${currentRunId}/jobs`)) {
                return jsonResponse(jobsForRun(currentRunId));
              }
              // No coverage-profile artifacts were uploaded for this run.
              if (url.includes("/artifacts?")) {
                return jsonResponse({ total_count: 0, artifacts: [] });
              }
              if (url.includes("/compare/")) {
                return jsonResponse({ ahead_by: 1 });
              }
              return new Response(`unexpected request: ${url}`, {
                status: 404,
              });
            },
            () => withMockExit(() => main()),
          ),
      )
    );
    const output = captured.logs.join("\n");

    // With no coverage-profile artifacts, extraction fails and the run has no
    // coverage metrics to gate, so the informational run exits cleanly.
    assertEquals(captured.result, 0);
    assertStringIncludes(
      output,
      "Compile cache states: generated-patterns=unknown, pattern-integration=unknown, pattern-unit=unknown",
    );
    assertStringIncludes(
      captured.errors.join("\n"),
      "could not extract coverage debt metrics for current run",
    );
    assertStringIncludes(
      output,
      "No coverage metrics extracted from current run. Nothing to check.",
    );
  } finally {
    await Deno.remove(eventPath).catch(() => {});
    await Deno.remove("perf-metrics.json").catch(() => {});
  }
});

/** GitHub's answer when the token has spent its hourly request window. */
function spentRateLimitWindow(): Response {
  return new Response('{"message":"API rate limit exceeded for user"}', {
    status: 403,
    statusText: "Forbidden",
    headers: { "x-ratelimit-remaining": "0" },
  });
}

Deno.test("fetchCurrentRunArtifacts reads the downloaded artifacts when a rate limit refuses the listing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coverage-artifacts-" });
  try {
    await Deno.mkdir(path.join(dir, "coverage-profile-workspace-1"));
    await Deno.mkdir(path.join(dir, "coverage-profile-runner-1"));
    await Deno.writeTextFile(path.join(dir, "stray.txt"), "not an artifact");

    const captured = await captureConsoleAsync(() =>
      withMockFetch(
        spentRateLimitWindow,
        () => fetchCurrentRunArtifacts(123, dir),
      )
    );

    assertEquals(
      captured.result.sort((a, b) => a.name.localeCompare(b.name)),
      [
        makeArtifact(0, "coverage-profile-runner-1"),
        makeArtifact(0, "coverage-profile-workspace-1"),
      ].map((artifact) => ({ ...artifact, size_in_bytes: 0 })),
    );
    const warnings = captured.warnings.join("\n");
    assertStringIncludes(
      warnings,
      "GitHub API rate limit while listing this run's artifacts; reading " +
        `the ones downloaded to \`${dir}\` instead`,
    );
    assertStringIncludes(warnings, "403 Forbidden (rate limit)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the downloaded artifacts a rate-limited listing falls back to keep every shard's coverage", async () => {
  // Shards upload files of the same name, and the artifacts read from their
  // directories all carry the same id, so only the name tells them apart.
  const dir = await Deno.makeTempDir({ prefix: "coverage-artifacts-" });
  try {
    for (
      const [index, name] of [
        "coverage-profile-runner-1",
        "coverage-profile-runner-2",
      ].entries()
    ) {
      await Deno.mkdir(path.join(dir, name));
      await Deno.writeTextFile(
        path.join(dir, name, "coverage.lcov"),
        [
          `SF:/home/runner/work/labs/labs/packages/example/src/shard-${index}.ts`,
          "DA:1,1",
          "end_of_record",
        ].join("\n"),
      );
    }

    const { lcov, sourceDescription } = await captureConsoleAsync(async () =>
      combinedLcovFromArtifacts(
        await withMockFetch(
          spentRateLimitWindow,
          () => fetchCurrentRunArtifacts(123, dir),
        ),
        dir,
      )
    ).then((captured) => captured.result);

    assertStringIncludes(lcov, "packages/example/src/shard-0.ts");
    assertStringIncludes(lcov, "packages/example/src/shard-1.ts");
    assertEquals(sourceDescription, "2 LCOV report files");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchCurrentRunArtifacts rethrows a rate limit with no downloaded artifacts to read", async () => {
  await withMockFetch(
    spentRateLimitWindow,
    () =>
      assertRejects(
        () => fetchCurrentRunArtifacts(123, undefined),
        GitHubRateLimitError,
      ),
  );
});

Deno.test("fetchCurrentRunArtifacts rethrows a refusal that is not a rate limit", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coverage-artifacts-" });
  try {
    await Deno.mkdir(path.join(dir, "coverage-profile-workspace-1"));

    // A refusal the token would meet again after any wait is not one the
    // downloaded artifacts should paper over.
    await withMockFetch(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
      () =>
        assertRejects(
          () => fetchCurrentRunArtifacts(123, dir),
          Error,
          "GitHub API GET 403 Forbidden: /repos/",
        ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main measures the downloaded coverage when a rate limit refuses the current run's artifact listing", async () => {
  const eventPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(eventPath, JSON.stringify({ after: SHA_C }));
  // Every expected artifact downloaded, each of them empty.
  const dir = await Deno.makeTempDir({ prefix: "coverage-artifacts-" });
  for (const name of EXPECTED_COVERAGE_ARTIFACT_NAMES) {
    await Deno.mkdir(path.join(dir, name));
  }

  const currentRunId = 123;
  try {
    const captured = await captureConsoleAsync(() =>
      withEnv(
        {
          GITHUB_TOKEN: "test-token",
          GITHUB_RUN_ID: String(currentRunId),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "workflow_run",
          GITHUB_SHA: SHA_C,
          PR_NUMBER: "",
          COVERAGE_ARTIFACTS_DIR: dir,
        },
        () =>
          withMockFetch(
            (input) =>
              String(input).includes(`/actions/runs/${currentRunId}/artifacts`)
                ? spentRateLimitWindow()
                : jsonResponse({ workflow_runs: [] }),
            () => withMockExit(() => main()),
          ),
      )
    );

    // Extraction got as far as reading the downloaded directories, which is
    // what finds them empty; the listing's refusal stopped nothing.
    const errors = captured.errors.join("\n");
    assertStringIncludes(errors, "contained no profile or LCOV files.");
    assertFalse(errors.includes("Could not fetch current run artifacts"));
  } finally {
    await Deno.remove(eventPath).catch(() => {});
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(PERF_METRICS_FILE).catch(() => {});
  }
});

Deno.test("main passes a pull request ungated when a rate limit refuses its artifact listing and then its baselines", async () => {
  // The measurement reads the working directory as the repository root, so
  // the run is given one of its own holding a single `tasks` source file.
  const root = await Deno.makeTempDir({ prefix: "coverage-rate-limited-pr-" });
  const originalCwd = Deno.cwd();
  const source = path.join(root, "tasks", "limited.ts");
  await Deno.mkdir(path.dirname(source));
  await Deno.writeTextFile(source, "export const limited = 1;\n");

  const artifactsDir = path.join(root, "coverage-artifacts");
  for (const name of EXPECTED_COVERAGE_ARTIFACT_NAMES) {
    await Deno.mkdir(path.join(artifactsDir, name), { recursive: true });
    await Deno.writeTextFile(
      path.join(artifactsDir, name, "coverage.lcov"),
      `SF:${source}\nDA:1,0\nend_of_record\n`,
    );
  }

  const eventPath = path.join(root, "event.json");
  await Deno.writeTextFile(
    eventPath,
    JSON.stringify({ pull_request: { head: { sha: SHA_C }, body: "" } }),
  );
  const commentFile = path.join(root, "coverage-comment.json");

  const prNumber = 7;
  const currentRunId = 123;
  try {
    Deno.chdir(root);
    const captured = await captureConsoleAsync(() =>
      withEnv(
        {
          GITHUB_TOKEN: "test-token",
          GITHUB_RUN_ID: String(currentRunId),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_SHA: SHA_C,
          PR_NUMBER: String(prNumber),
          COVERAGE_ARTIFACTS_DIR: artifactsDir,
          COVERAGE_COMMENT_FILE: commentFile,
          GITHUB_STEP_SUMMARY: undefined,
        },
        () =>
          // The description and the changed files are read before the window
          // is spent; every read after them meets the limit.
          withMockFetch(
            (input) => {
              const url = String(input);
              if (url.includes(`/pulls/${prNumber}/files`)) {
                return jsonResponse([{ filename: "tasks/limited.ts" }]);
              }
              if (url.endsWith(`/pulls/${prNumber}`)) {
                return jsonResponse({ body: "" });
              }
              return spentRateLimitWindow();
            },
            () => withMockExit(() => main()),
          ),
      )
    );

    assertEquals(captured.result, 0);
    assertStringIncludes(
      captured.logs.join("\n"),
      "Extracted 2 coverage metrics from current run.",
    );
    const payload = JSON.parse(
      await Deno.readTextFile(commentFile),
    ) as CoverageCommentPayload;
    assertEquals(payload.state, "ungated");
    assertStringIncludes(
      payload.body ?? "",
      "| `tasks` | GitHub's API rate limit stopped this run reading",
    );
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("selectMergedPRForCommit prefers the merged PR", () => {
  const prs = [
    { number: 1, merged_at: null },
    { number: 2, merged_at: "2026-06-18T00:00:00Z" },
  ] as unknown as PRInfo[];

  assertEquals(selectMergedPRForCommit(prs)?.number, 2);
});

Deno.test("selectMergedPRForCommit falls back to the first PR", () => {
  const prs = [
    { number: 1, merged_at: null },
    { number: 2, merged_at: null },
  ] as unknown as PRInfo[];

  assertEquals(selectMergedPRForCommit(prs)?.number, 1);
  assertEquals(selectMergedPRForCommit([]), null);
});

Deno.test("readBaseBranchSha reads the first parent of a merge checkout", async () => {
  const commit = [
    "tree 1111111111111111111111111111111111111111",
    `parent ${SHA_A}`,
    `parent ${SHA_B}`,
    "author CI <ci@example.com> 1780000000 +0000",
    "",
    `parent ${SHA_C} looks like a header but is message text`,
  ].join("\n");

  assertEquals(await readBaseBranchSha(() => Promise.resolve(commit)), SHA_A);
});

Deno.test("readBaseBranchSha reports no base for a non-merge checkout", async () => {
  const commit = [
    "tree 1111111111111111111111111111111111111111",
    `parent ${SHA_A}`,
    "",
    "a push run checks out the commit itself",
  ].join("\n");

  assertEquals(await readBaseBranchSha(() => Promise.resolve(commit)), null);
  assertEquals(await readBaseBranchSha(() => Promise.resolve(null)), null);
});

function makeBaselineSample(
  runId: number,
  sha: string,
  createdAt: string,
  uncoveredLines: number,
): BaselineSample {
  return { runId, sha, createdAt, uncoveredLines };
}

/** Ancestry of base-branch commit `SHA_C`, newest first. */
const RANKS = new Map([[SHA_C, 0], [SHA_B, 1], [SHA_A, 2]]);

const RUNNER_METRIC = "coverage-debt: packages/runner uncovered lines";
const MEMORY_METRIC = "coverage-debt: packages/memory uncovered lines";

/** One baseline run's contribution to the walk. */
function reading(
  run: WorkflowRun,
  samples: Record<string, number>,
  options: { cold?: boolean; accepts?: string[]; reset?: boolean } = {},
): BaselineRunReading {
  const accepts = options.accepts ?? [];
  return {
    samples: new Map(
      Object.entries(samples).map(([metric, uncoveredLines]) => [
        metric,
        makeBaselineSample(
          run.id,
          run.head_sha,
          run.created_at,
          uncoveredLines,
        ),
      ]),
    ),
    overrides: accepts.length > 0 || options.reset
      ? {
        metrics: new Map(accepts.map((metric) => [metric, 0])),
        coverageBaselineReset: options.reset ?? false,
      }
      : null,
    cold: options.cold ?? false,
  };
}

/**
 * Walk `readings` newest first, reporting which runs the walk actually read.
 * Each entry is a run and what reading it would give.
 */
async function walk(
  readings: [WorkflowRun, BaselineRunReading][],
  ancestorRank: Map<string, number> | null,
  metrics: string[] = [RUNNER_METRIC],
): Promise<{ lines: Record<string, number | undefined>; read: number[] }> {
  const read: number[] = [];
  const baselines = await walkBaselineRuns({
    metrics,
    runs: readings.map(([run]) => run),
    ancestorRank,
    readRun: (run) => {
      read.push(run.id);
      const found = readings.find(([candidate]) => candidate.id === run.id);
      return Promise.resolve(found![1]);
    },
  });

  const lines: Record<string, number | undefined> = {};
  for (const metric of metrics) {
    lines[metric] = baselines.get(metric)?.uncoveredLines;
  }
  return { lines, read };
}

/** The newest of three `main` runs along the ancestry `RANKS` describes. */
const RUN_AT_BASE = makeRun(3, SHA_C, "2026-08-04T10:40:00Z");

/** The one before it. */
const RUN_ONE_BACK = makeRun(2, SHA_B, "2026-08-04T10:20:00Z");

/** The one before that. */
const RUN_TWO_BACK = makeRun(1, SHA_A, "2026-08-04T10:00:00Z");

Deno.test("walkBaselineRuns prefers the base-branch commit's own run", async () => {
  const walked = await walk([
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5760 })],
    [RUN_ONE_BACK, reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 })],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5760);
  // The newest run answered every metric, so the older ones are never read.
  assertEquals(walked.read, [3]);
});

Deno.test("walkBaselineRuns falls back to the nearest ancestor with a run", async () => {
  // The base-branch commit's run uploaded no baseline artifact, so its parent
  // stands in rather than the gate giving up.

  const walked = await walk([
    [RUN_AT_BASE, reading(RUN_AT_BASE, {})],
    [RUN_ONE_BACK, reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 })],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5746);
  assertEquals(walked.read, [3, 2]);
});

Deno.test("walkBaselineRuns ranks the ancestry rather than trusting run order", async () => {
  // The nearer ancestor's run arrives second, as a history rewrite or two
  // pushes in one second can leave it. The nearer commit still wins.

  const walked = await walk([
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5760 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5760);
  assertEquals(walked.read, [3]);
});

Deno.test("walkBaselineRuns reads the first of two runs for one commit", async () => {
  const rerun = makeRun(9, SHA_C, "2026-08-04T12:00:00Z");
  const walked = await walk([
    [rerun, reading(rerun, { [RUNNER_METRIC]: 5770 })],
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5760 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5760);
  assertEquals(walked.read, [3]);
});

Deno.test("walkBaselineRuns ignores a run that is not an ancestor", async () => {
  // Landed after this run started, so it measured code the run lacks.

  const sibling = makeRun(4, "dddddddddddddddddddddddddddddddddddddddd");
  const walked = await walk([
    [sibling, reading(sibling, { [RUNNER_METRIC]: 5700 })],
    [RUN_ONE_BACK, reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5746);
});

Deno.test("walkBaselineRuns skips a cold ancestor for a warm one", async () => {
  const walked = await walk([
    [
      RUN_ONE_BACK,
      reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5600 }, { cold: true }),
    ],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5740);
});

Deno.test("walkBaselineRuns takes a cold ancestor when every ancestor is cold", async () => {
  const walked = await walk([
    [
      RUN_ONE_BACK,
      reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5600 }, { cold: true }),
    ],
    [
      RUN_TWO_BACK,
      reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 }, { cold: true }),
    ],
  ], RANKS);

  // The nearest of them, not the oldest.
  assertEquals(walked.lines[RUNNER_METRIC], 5600);
});

Deno.test("walkBaselineRuns ignores an acceptance that is not an ancestor", async () => {
  // A reset that merged after this run's base-branch commit is not in this
  // run's code, so it sets no floor here and the ancestry still gates.

  const later = makeRun(4, "dddddddddddddddddddddddddddddddddddddddd");
  const walked = await walk([
    [later, reading(later, { [RUNNER_METRIC]: 7000 }, { reset: true })],
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5760 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5760);
  // The run that is no baseline is never read either.
  assertEquals(walked.read, [3]);
});

Deno.test("walkBaselineRuns falls back to the latest run without ancestry", async () => {
  const walked = await walk([
    [RUN_ONE_BACK, reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 })],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ], null);

  assertEquals(walked.lines[RUNNER_METRIC], 5746);

  const nothing = await walk([], RANKS);
  assertEquals(nothing.lines[RUNNER_METRIC], undefined);
});

Deno.test("walkBaselineRuns takes the latest cold run without ancestry", async () => {
  const walked = await walk([
    [
      RUN_ONE_BACK,
      reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 }, { cold: true }),
    ],
    [
      RUN_TWO_BACK,
      reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 }, { cold: true }),
    ],
  ], null);

  assertEquals(walked.lines[RUNNER_METRIC], 5746);
});

Deno.test("walkBaselineRuns stops at the run whose PR accepted the debt", async () => {
  // The middle run's merged pull request accepted the runner group's debt, so
  // nothing older may serve as that group's baseline: the accepted level is
  // what later runs are held to. Every run that measured it is cold, so the
  // accepting run stands as the baseline rather than the metric losing one.
  // The memory group was not accepted, so its walk carries on to the warm run.

  const walked = await walk(
    [
      [RUN_AT_BASE, reading(RUN_AT_BASE, {}, { cold: true })],
      [
        RUN_ONE_BACK,
        reading(
          RUN_ONE_BACK,
          { [RUNNER_METRIC]: 5746, [MEMORY_METRIC]: 410 },
          { cold: true, accepts: [RUNNER_METRIC] },
        ),
      ],
      [
        RUN_TWO_BACK,
        reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740, [MEMORY_METRIC]: 400 }),
      ],
    ],
    RANKS,
    [RUNNER_METRIC, MEMORY_METRIC],
  );

  assertEquals(walked.lines[RUNNER_METRIC], 5746);
  assertEquals(walked.lines[MEMORY_METRIC], 400);
});

Deno.test("walkBaselineRuns stops every coverage metric at a merged reset", async () => {
  const walked = await walk(
    [
      [
        RUN_ONE_BACK,
        reading(
          RUN_ONE_BACK,
          { [RUNNER_METRIC]: 5746, [MEMORY_METRIC]: 410 },
          { cold: true, reset: true },
        ),
      ],
      [
        RUN_TWO_BACK,
        reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740, [MEMORY_METRIC]: 400 }),
      ],
    ],
    RANKS,
    [RUNNER_METRIC, MEMORY_METRIC],
  );

  assertEquals(walked.lines[RUNNER_METRIC], 5746);
  assertEquals(walked.lines[MEMORY_METRIC], 410);
});

Deno.test("walkBaselineRuns walks past an acceptance that measured nothing", async () => {
  // The accepting run uploaded no baseline artifact, so it has no level to
  // hold later runs to and the search continues past it.

  const walked = await walk([
    [RUN_ONE_BACK, reading(RUN_ONE_BACK, {}, { accepts: [RUNNER_METRIC] })],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ], RANKS);

  assertEquals(walked.lines[RUNNER_METRIC], 5740);
});

Deno.test("walkBaselineRuns asks for an older page once the runs in hand settle nothing", async () => {
  // A run re-run days later: every run on the newest page is for a commit that
  // landed after the one it merges, and the ancestors' runs are further back.
  const later = makeRun(9, "d".repeat(40), "2026-08-04T12:00:00Z");
  const read: number[] = [];
  const pages = [[RUN_AT_BASE, RUN_ONE_BACK], null];
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [later],
    olderRuns: () => Promise.resolve(pages.shift() ?? null),
    ancestorRank: RANKS,
    readRun: (run) => {
      read.push(run.id);
      return Promise.resolve(reading(run, { [RUNNER_METRIC]: 5700 + run.id }));
    },
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.uncoveredLines, 5703);
  assertEquals(read, [RUN_AT_BASE.id]);
  // The page that settled the metric was the last one asked for.
  assertEquals(pages, [null]);
});

Deno.test("walkBaselineRuns asks for no older page when the runs in hand settle every metric", async () => {
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_AT_BASE],
    olderRuns: () => {
      asked++;
      return Promise.resolve([RUN_ONE_BACK]);
    },
    ancestorRank: RANKS,
    readRun: (run) => Promise.resolve(reading(run, { [RUNNER_METRIC]: 5746 })),
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.uncoveredLines, 5746);
  assertEquals(asked, 0);
});

Deno.test("walkBaselineRuns carries a cold sample across pages until a warm one turns up", async () => {
  const pages = [[RUN_ONE_BACK], [RUN_TWO_BACK]];
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_AT_BASE],
    olderRuns: () => Promise.resolve(pages.shift() ?? null),
    ancestorRank: RANKS,
    readRun: (run) =>
      Promise.resolve(
        reading(run, { [RUNNER_METRIC]: 5700 + run.id }, {
          cold: run.id !== RUN_TWO_BACK.id,
        }),
      ),
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.uncoveredLines, 5701);
});

Deno.test("walkBaselineRuns reads an older page before settling on an ancestor whose nearer commits are unaccounted for", async () => {
  // Two pushes landed together and their runs were created in the other order,
  // with a page boundary between them: the base-branch commit's run is on the
  // older page.
  const read: number[] = [];
  const pages = [[RUN_AT_BASE]];
  const shown = new Set([SHA_B]);
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_ONE_BACK],
    olderRuns: () => {
      const page = pages.shift() ?? null;
      for (const run of page ?? []) shown.add(run.head_sha);
      return Promise.resolve(page);
    },
    accountedFor: (sha) => shown.has(sha),
    ancestorRank: RANKS,
    readRun: (run) => {
      read.push(run.id);
      return Promise.resolve(reading(run, { [RUNNER_METRIC]: 5700 + run.id }));
    },
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.sha, SHA_C);
  assertEquals(read, [RUN_AT_BASE.id]);
});

Deno.test("walkBaselineRuns settles on an ancestor once every nearer commit is accounted for", async () => {
  // The base-branch commit's run is still going: the listing showed it, so no
  // older page can hold a better baseline.
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_ONE_BACK],
    olderRuns: () => {
      asked++;
      return Promise.resolve([RUN_TWO_BACK]);
    },
    accountedFor: (sha) => sha === SHA_C,
    ancestorRank: RANKS,
    readRun: (run) => Promise.resolve(reading(run, { [RUNNER_METRIC]: 5746 })),
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.sha, SHA_B);
  assertEquals(asked, 0);
});

Deno.test("walkBaselineRuns takes the ancestor it has once the listing has no older page", async () => {
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_ONE_BACK],
    olderRuns: () => {
      asked++;
      return Promise.resolve(null);
    },
    accountedFor: () => false,
    ancestorRank: RANKS,
    readRun: (run) => Promise.resolve(reading(run, { [RUNNER_METRIC]: 5746 })),
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.sha, SHA_B);
  assertEquals(asked, 1);
});

Deno.test("walkBaselineRuns counts a commit whose run it read as accounted for", async () => {
  // The base-branch commit's run measured nothing, so the walk moves to the
  // next ancestor without asking the listing about a commit it already read.
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [RUN_AT_BASE, RUN_ONE_BACK],
    olderRuns: () => {
      asked++;
      return Promise.resolve(null);
    },
    accountedFor: () => false,
    ancestorRank: RANKS,
    readRun: (run) =>
      Promise.resolve(
        reading(
          run,
          run.id === RUN_AT_BASE.id ? {} : { [RUNNER_METRIC]: 5746 },
        ),
      ),
  });

  assertEquals(baselines.get(RUNNER_METRIC)?.sha, SHA_B);
  assertEquals(asked, 0);
});

Deno.test("walkBaselineRuns stops reading at its run budget", async () => {
  // No run measured the metric, which is what a group new to `main` looks like.
  const read: number[] = [];
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [MEMORY_METRIC],
    runs: [RUN_AT_BASE, RUN_ONE_BACK, RUN_TWO_BACK],
    olderRuns: () => {
      asked++;
      return Promise.resolve(
        asked === 1 ? [makeRun(7, SHA_A, "2026-08-04T09:00:00Z")] : null,
      );
    },
    maxRunsRead: 2,
    ancestorRank: RANKS,
    readRun: (run) => {
      read.push(run.id);
      return Promise.resolve(reading(run, { [RUNNER_METRIC]: 5746 }));
    },
  });

  assertEquals(baselines.get(MEMORY_METRIC), undefined);
  assertEquals(read, [RUN_AT_BASE.id, RUN_ONE_BACK.id]);
  assertEquals(asked, 0);
});

Deno.test("walkBaselineRuns gives up when the listing has no older page", async () => {
  let asked = 0;
  const baselines = await walkBaselineRuns({
    metrics: [RUNNER_METRIC],
    runs: [],
    olderRuns: () => {
      asked++;
      return Promise.resolve(null);
    },
    ancestorRank: RANKS,
    readRun: (run) => Promise.resolve(reading(run, {})),
  });

  assertEquals(baselines.size, 0);
  assertEquals(asked, 1);
});

Deno.test("fetchAncestorRanks ranks commits by distance from the base", async () => {
  const ranks = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/commits?sha=${SHA_C}`);
      return new Response(
        JSON.stringify([{ sha: SHA_C }, { sha: SHA_B }, { sha: SHA_A }]),
      );
    },
    () => fetchAncestorRanks(SHA_C),
  );

  assertEquals([...ranks], [[SHA_C, 0], [SHA_B, 1], [SHA_A, 2]]);
});

Deno.test("fetchGroupsChangedOnBase reports the groups the base branch moved", async () => {
  const groups = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/compare/${SHA_A}...${SHA_C}`);
      return new Response(JSON.stringify({
        files: [
          { filename: "packages/runner/src/runner.ts" },
          { filename: "packages/runner/test/runner.test.ts" },
          { filename: "docs/development/COVERAGE.md" },
        ],
      }));
    },
    () => fetchGroupsChangedOnBase(SHA_A, SHA_C),
  );

  assertEquals([...groups], ["packages/runner"]);
});

Deno.test("fetchGroupsChangedOnBase compares nothing against the base itself", async () => {
  const groups = await withMockFetch(
    () => {
      throw new Error("must not compare a commit against itself");
    },
    () => fetchGroupsChangedOnBase(SHA_C, SHA_C),
  );

  assertEquals(groups.size, 0);
});

Deno.test("isComparableBaseline withholds only the groups the base branch moved", () => {
  const sample = makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740);
  const moved = new Map([[SHA_A, new Set(["packages/runner"])]]);
  const at = (metric: string, sha: string | null = SHA_C) =>
    isComparableBaseline({
      sample,
      metric,
      baseSha: sha,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    });

  assertEquals(at(RUNNER_METRIC), false);
  assertEquals(at(MEMORY_METRIC), true);

  // No base-branch commit means no ancestry, so the baseline is whatever ran
  // last and nothing may be gated against it.
  assertEquals(at(MEMORY_METRIC, null), false);

  assertEquals(
    isComparableBaseline({
      sample: undefined,
      metric: MEMORY_METRIC,
      baseSha: SHA_C,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    }),
    false,
  );

  // A main push run has no base-branch commit and only reports.
  assertEquals(
    isComparableBaseline({
      sample,
      metric: RUNNER_METRIC,
      baseSha: null,
      groupsChangedByBaseline: moved,
      isPullRequest: false,
    }),
    true,
  );
});

Deno.test("isComparableBaseline reads the moved groups of its own baseline", () => {
  const atBase = makeBaselineSample(2, SHA_C, "2026-08-04T10:40:00Z", 5746);
  const older = makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740);
  // The base branch moved packages/runner since SHA_A but not since SHA_C, so
  // a metric baselined at SHA_C stays gated.
  const moved = new Map([
    [SHA_A, new Set(["packages/runner"])],
    [SHA_C, new Set<string>()],
  ]);
  const at = (sample: BaselineSample) =>
    isComparableBaseline({
      sample,
      metric: RUNNER_METRIC,
      baseSha: SHA_C,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    });

  assertEquals(at(atBase), true);
  assertEquals(at(older), false);
});

Deno.test("selectBaselines picks a baseline and its gating for each metric", async () => {
  const runs: [WorkflowRun, BaselineRunReading][] = [
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 })],
    // Only an older run measured the memory group, and the base branch moved
    // that group since, so it is reported and not gated.
    [
      RUN_TWO_BACK,
      reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740, [MEMORY_METRIC]: 400 }),
    ],
  ];

  const resolved = await selectBaselines({
    metrics: [
      RUNNER_METRIC,
      MEMORY_METRIC,
      "coverage-debt: gone uncovered lines",
    ],
    runs: runs.map(([run]) => run),
    readRun: (run) =>
      Promise.resolve(runs.find(([candidate]) => candidate.id === run.id)![1]),
    isPullRequest: true,
    readBaseSha: () => Promise.resolve(SHA_C),
    fetchRanks: () => Promise.resolve(RANKS),
    fetchChangedGroups: (baselineSha) =>
      Promise.resolve(
        baselineSha === SHA_A
          ? new Set(["packages/memory"])
          : new Set<string>(),
      ),
    log: () => {},
  });

  assertEquals(resolved.size, 3);
  assertEquals(resolved.get(RUNNER_METRIC)?.sample?.uncoveredLines, 5746);
  assertEquals(resolved.get(RUNNER_METRIC)?.comparable, true);
  assertEquals(resolved.get(MEMORY_METRIC)?.sample?.uncoveredLines, 400);
  assertEquals(resolved.get(MEMORY_METRIC)?.comparable, false);

  // A metric no baseline run measured has nothing to be gated against.
  const missing = resolved.get("coverage-debt: gone uncovered lines");
  assertEquals(missing?.sample, undefined);
  assertEquals(missing?.comparable, false);
});

Deno.test("reportBaselineDistance names each baseline and its distance", () => {
  const captured = captureConsole(() =>
    reportBaselineDistance(
      new Set([SHA_C, SHA_A]),
      SHA_C,
      RANKS,
      (message) => console.log(message),
    )
  );

  const logs = captured.logs.join("\n");
  assertStringIncludes(
    logs,
    `measured at the base-branch commit: ${SHA_C.slice(0, 8)}`,
  );
  assertStringIncludes(
    logs,
    `measured 2 commits before the base-branch commit: ${SHA_A.slice(0, 8)}`,
  );
});

Deno.test("reportBaselineDistance reports an ancestry it could not read", () => {
  const unknown = captureConsole(() =>
    reportBaselineDistance(new Set([SHA_A]), SHA_C, null, (m) => console.log(m))
  );
  assertStringIncludes(
    unknown.logs.join("\n"),
    "at an unknown distance from the base-branch commit",
  );

  const none = captureConsole(() =>
    reportBaselineDistance(new Set(), SHA_C, RANKS, (m) => console.log(m))
  );
  assertStringIncludes(
    none.logs.join("\n"),
    `No \`main\` run has measured base-branch commit ${SHA_C.slice(0, 8)}`,
  );
});

/**
 * Two of the three runs in the ancestry above, each carrying one metric.
 * `RUN_ONE_BACK` is deliberately absent: callers derive their run list from
 * these readings, so leaving it out is what makes a commit unmeasured.
 */
function runnerReadings(): [WorkflowRun, BaselineRunReading][] {
  return [
    [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 })],
    [RUN_TWO_BACK, reading(RUN_TWO_BACK, { [RUNNER_METRIC]: 5740 })],
  ];
}

function readerFor(
  readings: [WorkflowRun, BaselineRunReading][],
): (run: WorkflowRun) => Promise<BaselineRunReading> {
  return (run) =>
    Promise.resolve(
      readings.find(([candidate]) => candidate.id === run.id)![1],
    );
}

Deno.test("selectBaselines chooses each metric's baseline against the base commit", async () => {
  const readings = runnerReadings();
  const compared: string[] = [];

  const captured = await captureConsoleAsync(() =>
    selectBaselines({
      metrics: [RUNNER_METRIC],
      runs: readings.map(([run]) => run),
      readRun: readerFor(readings),
      isPullRequest: true,
      readBaseSha: () => Promise.resolve(SHA_C),
      fetchRanks: (baseSha) => {
        assertEquals(baseSha, SHA_C);
        return Promise.resolve(RANKS);
      },
      fetchChangedGroups: (baselineSha, baseSha) => {
        compared.push(`${baselineSha}...${baseSha}`);
        return Promise.resolve(new Set<string>());
      },
    })
  );

  assertEquals(
    captured.result.get(RUNNER_METRIC)?.sample?.uncoveredLines,
    5746,
  );
  assertEquals(captured.result.get(RUNNER_METRIC)?.comparable, true);
  // The commit the comparison was judged against travels with it, so a later
  // comment can say which `main` code this run's numbers describe.
  assertEquals(captured.result.get(RUNNER_METRIC)?.baseSha, SHA_C);
  // Only the baseline actually chosen is compared against the base commit.
  assertEquals(compared, [`${SHA_C}...${SHA_C}`]);
  assertStringIncludes(
    captured.logs.join("\n"),
    `merges the pull request into base-branch commit ${SHA_C.slice(0, 8)}`,
  );
});

Deno.test("selectBaselines gates nothing when the base commit cannot be read", async () => {
  const readings = runnerReadings();

  const captured = await captureConsoleAsync(() =>
    selectBaselines({
      metrics: [RUNNER_METRIC],
      runs: readings.map(([run]) => run),
      readRun: readerFor(readings),
      isPullRequest: true,
      readBaseSha: () => Promise.resolve(null),
      fetchRanks: () => {
        throw new Error("must not rank an ancestry it has no base for");
      },
      fetchChangedGroups: () => {
        throw new Error("must not compare without a base commit");
      },
    })
  );

  // The fallback still names a sample, but nothing may be failed against it.
  assertEquals(
    captured.result.get(RUNNER_METRIC)?.sample?.uncoveredLines,
    5746,
  );
  assertEquals(captured.result.get(RUNNER_METRIC)?.comparable, false);
  assertEquals(captured.result.get(RUNNER_METRIC)?.baseSha, undefined);
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not read the base-branch commit",
  );
});

Deno.test("selectBaselines reports against whatever it has for a push run", async () => {
  const readings = runnerReadings();

  const resolved = await selectBaselines({
    metrics: [RUNNER_METRIC],
    runs: readings.map(([run]) => run),
    readRun: readerFor(readings),
    isPullRequest: false,
    readBaseSha: () => {
      throw new Error("a push run has no base-branch commit to read");
    },
    log: () => {},
    warn: () => {},
  });

  assertEquals(resolved.get(RUNNER_METRIC)?.comparable, true);
});

Deno.test("reportUngatedGroups names the groups it withheld", () => {
  const captured = captureConsole(() =>
    reportUngatedGroups(
      new Set(["packages/runner", "packages/memory"]),
      (message) => console.log(message),
    )
  );
  assertStringIncludes(
    captured.logs.join("\n"),
    "packages/memory, packages/runner",
  );

  const quiet = captureConsole(() =>
    reportUngatedGroups(new Set(), (message) => console.log(message))
  );
  assertEquals(quiet.logs, []);
});

Deno.test("readHeadCommitObject returns the commit object of a checkout", async () => {
  const commit = await readHeadCommitObject();
  assert(commit !== null);
  assertStringIncludes(commit, "tree ");
});

Deno.test("readHeadCommitObject returns null outside a checkout", async () => {
  const outside = await Deno.makeTempDir({ prefix: "coverage-no-repo-" });
  try {
    const captured = await captureConsoleAsync(() =>
      readHeadCommitObject(outside)
    );
    assertEquals(captured.result, null);
    assertStringIncludes(
      captured.warnings.join("\n"),
      "could not read the `HEAD` commit object",
    );
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("fetchGroupsChangedOnBase warns when the compare response is capped", async () => {
  const files = Array.from({ length: 300 }, (_, index) => ({
    filename: `packages/runner/src/file-${index}.ts`,
  }));
  const warnings: string[] = [];

  const groups = await withMockFetch(
    () => new Response(JSON.stringify({ files })),
    () =>
      fetchGroupsChangedOnBase(SHA_A, SHA_C, (message) => {
        warnings.push(message);
      }),
  );

  assertEquals([...groups], ["packages/runner"]);
  assertStringIncludes(warnings.join("\n"), "300-file response cap");
});

Deno.test("isComparableBaseline gates a metric that names no coverage group", () => {
  assertEquals(
    isComparableBaseline({
      sample: makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 1),
      metric: "some-other-metric",
      baseSha: SHA_C,
      groupsChangedByBaseline: new Map(),
      isPullRequest: true,
    }),
    true,
  );
});

Deno.test("readHeadCommitObject returns null when git cannot be run", async () => {
  const captured = await captureConsoleAsync(() =>
    readHeadCommitObject("/coverage-check-no-such-directory")
  );

  assertEquals(captured.result, null);
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not run `git` to read the `HEAD` commit object",
  );
});

Deno.test("selectBaselines routes its GitHub calls through the guard", async () => {
  const guarded: string[] = [];

  const readings = runnerReadings();

  await selectBaselines({
    metrics: [RUNNER_METRIC],
    runs: readings.map(([run]) => run),
    readRun: readerFor(readings),
    isPullRequest: true,
    readBaseSha: () => Promise.resolve(SHA_C),
    fetchRanks: () => Promise.resolve(RANKS),
    fetchChangedGroups: () => Promise.resolve(new Set<string>()),
    guard: (description, operation) => {
      guarded.push(description);
      return operation();
    },
    log: () => {},
  });

  assertEquals(guarded, [
    "listing the base-branch commit's ancestry",
    "comparing the baseline commit against the base-branch commit",
  ]);
});

const NO_OVERRIDES = { metrics: new Map(), coverageBaselineReset: false };

function rowsFor(
  metrics: Record<string, number>,
  baselines: Record<string, { value?: number; comparable: boolean }>,
  extra: Partial<Parameters<typeof buildCoverageRows>[0]> = {},
) {
  const currentMetrics = new Map(
    Object.entries(metrics).map(([metric, value]) => [
      metric,
      makeBaselineSample(9, SHA_C, "2026-08-04T11:00:00Z", value),
    ]),
  );
  const baselineByMetric = new Map(
    Object.entries(baselines).map(([metric, spec]) => [metric, {
      sample: spec.value === undefined
        ? undefined
        : makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", spec.value),
      comparable: spec.comparable,
      baseSha: SHA_B,
    }]),
  );
  return buildCoverageRows({
    currentMetrics,
    baselineByMetric,
    overrides: NO_OVERRIDES,
    changedCoverageGroups: new Set(["packages/runner", "packages/memory"]),
    ...extra,
  });
}

Deno.test("buildCoverageRows stamps every row with where it was measured", () => {
  // The comment for a regression the pull request did not cause reads these
  // back to say which run produced the numbers and which `main` commit that
  // run merged, so every row carries them whatever the gate decides.

  const { rows } = rowsFor(
    { [RUNNER_METRIC]: 5747, [MEMORY_METRIC]: 3 },
    {
      [RUNNER_METRIC]: { value: 5746, comparable: true },
      [MEMORY_METRIC]: { comparable: true },
    },
  );

  assertEquals(rows.map((row) => row.status), ["OVER", "OVER"]);
  for (const row of rows) {
    assertEquals(row.measuredRunId, 9);
    assertEquals(row.baseSha, SHA_B);
  }

  // A metric with no baseline at all knows no base-branch commit to name.
  const ungated = rowsFor(
    { [RUNNER_METRIC]: 1 },
    {},
  );
  assertEquals(ungated.rows[0].measuredRunId, 9);
  assertEquals(ungated.rows[0].baseSha, undefined);
});

Deno.test("buildCoverageRows fails a gated group above its baseline", () => {
  const { rows, failures } = rowsFor(
    { [RUNNER_METRIC]: 5747 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
  );

  assertEquals(rows[0].status, "OVER");
  assertEquals(rows[0].baseline, 5746);
  assertEquals(rows[0].baselineSha, SHA_A);
  assertEquals(failures.length, 1);
});

Deno.test("buildCoverageRows passes a gated group at its baseline", () => {
  const { rows, failures } = rowsFor(
    { [RUNNER_METRIC]: 5746 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
  );

  assertEquals(rows[0].status, "OK");
  assertEquals(failures, []);
});

Deno.test("buildCoverageRows reports an incomparable baseline without failing it", () => {
  const { rows, failures, ungatedGroups } = rowsFor(
    { [RUNNER_METRIC]: 9999 },
    { [RUNNER_METRIC]: { value: 5746, comparable: false } },
  );

  assertEquals(rows[0].status, "excl");
  assertEquals(rows[0].baseline, 5746);
  assertEquals(failures, []);
  assertEquals([...ungatedGroups], ["packages/runner"]);
});

Deno.test("buildCoverageRows names a changed group whose baseline the base branch moved", () => {
  const { notGated } = rowsFor(
    { [RUNNER_METRIC]: 9999 },
    { [RUNNER_METRIC]: { value: 5746, comparable: false } },
  );

  assertEquals(notGated, [{
    group: "packages/runner",
    reason: "base-branch-moved",
    baselineSha: SHA_A,
  }]);
});

Deno.test("buildCoverageRows names a changed group no run measured", () => {
  const { rows, notGated } = rowsFor(
    { [RUNNER_METRIC]: 9999, [MEMORY_METRIC]: 12 },
    {
      [RUNNER_METRIC]: { comparable: false },
      [MEMORY_METRIC]: { value: 12, comparable: true },
    },
  );

  assertEquals(rows.map((row) => row.status), ["excl", "OK"]);
  assertEquals(notGated, [{
    group: "packages/runner",
    reason: "no-baseline",
    baselineSha: undefined,
  }]);
});

Deno.test("buildCoverageRows names a changed group when the base commit was not read", () => {
  const currentMetrics = new Map([
    [RUNNER_METRIC, makeBaselineSample(9, SHA_C, "2026-08-04T11:00:00Z", 7)],
  ]);
  const { notGated } = buildCoverageRows({
    currentMetrics,
    baselineByMetric: new Map([[RUNNER_METRIC, {
      sample: makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 7),
      comparable: false,
    }]]),
    overrides: NO_OVERRIDES,
    changedCoverageGroups: new Set(["packages/runner"]),
  });

  assertEquals(notGated.map((group) => group.reason), ["no-base-commit"]);
});

Deno.test("buildCoverageRows names no group the gate did not apply to", () => {
  // The pull request left `packages/memory` alone, and its description accepts
  // the rise in `packages/runner`, so neither would have been failed.
  const { rows, ungatedGroups, notGated } = rowsFor(
    { [RUNNER_METRIC]: 5750, [MEMORY_METRIC]: 12 },
    {
      [RUNNER_METRIC]: { value: 5746, comparable: false },
      [MEMORY_METRIC]: { comparable: false },
    },
    {
      overrides: {
        metrics: new Map([[RUNNER_METRIC, 4]]),
        coverageBaselineReset: false,
      },
      changedCoverageGroups: new Set(["packages/runner"]),
    },
  );

  assertEquals(rows.map((row) => row.status), ["ovrd", "excl"]);
  assertEquals([...ungatedGroups].sort(), [
    "packages/memory",
    "packages/runner",
  ]);
  assertEquals(notGated, []);
});

Deno.test("buildCoverageRows leaves a group the PR did not change alone", () => {
  const other = "coverage-debt: packages/toolshed uncovered lines";
  const { rows, failures, ungatedGroups } = rowsFor(
    { [other]: 9999 },
    { [other]: { value: 10, comparable: true } },
  );

  assertEquals(rows[0].status, "excl");
  assertEquals(failures, []);
  // Comparable, so nothing is withheld for want of a baseline.
  assertEquals([...ungatedGroups], []);
});

Deno.test("buildCoverageRows honors a per-group acceptance and a reset", () => {
  const accepted = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    {
      overrides: {
        metrics: new Map([[RUNNER_METRIC, 54]]),
        coverageBaselineReset: false,
      },
    },
  );
  assertEquals(accepted.rows[0].status, "ovrd");
  assertEquals(accepted.failures, []);

  const reset = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    {
      overrides: { metrics: new Map(), coverageBaselineReset: true },
    },
  );
  assertEquals(reset.rows[0].status, "ovrd");
  assertEquals(reset.failures, []);
});

Deno.test("buildCoverageRows measures an acceptance from the baseline", () => {
  const overrides = {
    metrics: new Map([[RUNNER_METRIC, 54]]),
    coverageBaselineReset: false,
  };

  // 5746 + 54 is the most the group may reach, and one line more fails.
  const atLimit = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    { overrides },
  );
  assertEquals(atLimit.rows[0].status, "ovrd");

  const overLimit = rowsFor(
    { [RUNNER_METRIC]: 5801 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    { overrides },
  );
  assertEquals(overLimit.rows[0].status, "OVER");
  assertEquals(overLimit.failures.length, 1);
});

Deno.test("buildCoverageRows accepts the same rise after the baseline moves", () => {
  // What a rebase does: the base branch uncovers 30 lines of its own, so both
  // the baseline and this run's count rise by 30. The pull request still adds
  // the 54 lines it accepted, and the same acceptance line still passes it.

  const overrides = {
    metrics: new Map([[RUNNER_METRIC, 54]]),
    coverageBaselineReset: false,
  };

  const rebased = rowsFor(
    { [RUNNER_METRIC]: 5830 },
    { [RUNNER_METRIC]: { value: 5776, comparable: true } },
    { overrides },
  );
  assertEquals(rebased.rows[0].status, "ovrd");
  assertEquals(rebased.failures, []);

  // And a rebase onto a base branch that covered 30 lines of its own does not
  // hand the pull request room to add 84.
  const tightened = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5716, comparable: true } },
    { overrides },
  );
  assertEquals(tightened.rows[0].status, "OVER");
  assertEquals(tightened.failures.length, 1);
});

Deno.test("buildCoverageRows bootstraps a metric with no baseline", () => {
  const fresh = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: true } },
  );
  assertEquals(fresh.rows[0].status, "OVER");
  assertEquals(fresh.rows[0].baseline, 0);
  assertEquals(fresh.failures.length, 1);

  const empty = rowsFor(
    { [RUNNER_METRIC]: 0 },
    { [RUNNER_METRIC]: { comparable: true } },
  );
  assertEquals(empty.rows[0].status, "n/a");
  assertEquals(empty.failures, []);

  // With no baseline and nothing gating it, the metric is only reported.
  const ungated = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: false } },
  );
  assertEquals(ungated.rows[0].status, "excl");
  assertEquals(ungated.failures, []);

  // A reset accepts a metric that has no baseline yet.
  const reset = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: true } },
    { overrides: { metrics: new Map(), coverageBaselineReset: true } },
  );
  assertEquals(reset.rows[0].status, "ovrd");

  // A metric with no baseline is held to zero, so an acceptance is measured
  // from there and the whole of it is available.
  const accepted = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: true } },
    {
      overrides: {
        metrics: new Map([[RUNNER_METRIC, 12]]),
        coverageBaselineReset: false,
      },
    },
  );
  assertEquals(accepted.rows[0].status, "ovrd");

  const short = rowsFor(
    { [RUNNER_METRIC]: 13 },
    { [RUNNER_METRIC]: { comparable: true } },
    {
      overrides: {
        metrics: new Map([[RUNNER_METRIC, 12]]),
        coverageBaselineReset: false,
      },
    },
  );
  assertEquals(short.rows[0].status, "OVER");
});

Deno.test("buildCoverageRows reports a rise from a zero baseline as complete", () => {
  const { rows } = rowsFor(
    { [RUNNER_METRIC]: 4 },
    { [RUNNER_METRIC]: { value: 0, comparable: true } },
  );
  assertEquals(rows[0].status, "OVER");
  assertEquals(rows[0].pctIncrease, 100);

  const held = rowsFor(
    { [RUNNER_METRIC]: 0 },
    { [RUNNER_METRIC]: { value: 0, comparable: true } },
  );
  assertEquals(held.rows[0].status, "OK");
  assertEquals(held.rows[0].pctIncrease, 0);
});

/**
 * A regressed group measured by run 1001, whose baseline came from `main` run
 * 900.
 */
function unattributedFailure(): Row {
  return {
    metric: "coverage-debt: packages/example uncovered lines",
    status: "OVER",
    current: 3,
    baseline: 1,
    baselineRunId: 900,
    baselineSha: SHA_B,
    measuredRunId: 1001,
    baseSha: SHA_C,
  };
}

/** A checkout holding one source file, with reports for two runs of it. */
async function withFlakyLineCheckout(
  run: (context: {
    rootDir: string;
    lcov: string;
    baselineLcov: string;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-unattributed-" });
  try {
    const sourcePath = path.join(rootDir, "packages/example/src/racy.ts");
    await Deno.mkdir(path.dirname(sourcePath), { recursive: true });
    await Deno.writeTextFile(
      sourcePath,
      ["export const a = 1;", "export const b = 2;"].join("\n"),
    );
    const report = (secondLineHits: number) =>
      [
        `SF:${sourcePath}`,
        "DA:1,1",
        `DA:2,${secondLineHits}`,
        "end_of_record",
      ].join("\n");
    await run({
      rootDir,
      lcov: report(0),
      baselineLcov: report(2),
    });
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
}

Deno.test("buildUnattributedRegressionBody names lines the baseline run covered", async () => {
  await withFlakyLineCheckout(async ({ rootDir, lcov, baselineLcov }) => {
    const body = await buildUnattributedRegressionBody({
      rootDir,
      groups: [{ group: "packages/example", target: 1, current: 3 }],
      coverageFailures: [unattributedFailure()],
      // The PR changed a file in another group entirely.
      prFiles: [{ filename: "packages/other/src/mod.ts" }],
      lcov,
      readBaselineLcov: (runId) => {
        assertEquals(runId, 900);
        return Promise.resolve(baselineLcov);
      },
    });

    assertStringIncludes(body ?? "", "`packages/example/src/racy.ts`: 2");
    assertStringIncludes(body ?? "", "not introduced by this PR");
    // The prompt names the run that measured the lines and the run each group
    // was held against, so a session picking it up can find both.
    assertStringIncludes(
      body ?? "",
      "  Measuring run: https://github.com/commonfabric/labs/actions/runs/1001",
    );
    assertStringIncludes(body ?? "", `  Base commit measured: ${SHA_C}`);
    assertStringIncludes(body ?? "", `  git log ${SHA_C}.. -- `);
    assertStringIncludes(
      body ?? "",
      `  Baseline for packages/example: run https://github.com/commonfabric/labs/actions/runs/900, commit ${SHA_B}`,
    );
  });
});

Deno.test("buildUnattributedRegressionBody skips a line in a file the PR changed", async () => {
  await withFlakyLineCheckout(async ({ rootDir, lcov, baselineLcov }) => {
    const body = await buildUnattributedRegressionBody({
      rootDir,
      groups: [{ group: "packages/example", target: 1, current: 3 }],
      coverageFailures: [unattributedFailure()],
      prFiles: [{ filename: "packages/example/src/racy.ts" }],
      lcov,
      readBaselineLcov: () => Promise.resolve(baselineLcov),
    });

    assertEquals(body, null);
  });
});

Deno.test("buildUnattributedRegressionBody gives up without a readable baseline run", async () => {
  await withFlakyLineCheckout(async ({ rootDir, lcov }) => {
    const noRunId = await buildUnattributedRegressionBody({
      rootDir,
      groups: [{ group: "packages/example", target: 1, current: 3 }],
      coverageFailures: [{
        ...unattributedFailure(),
        baselineRunId: undefined,
      }],
      prFiles: [],
      lcov,
      readBaselineLcov: () => {
        throw new Error("must not be read without a baseline run");
      },
    });
    assertEquals(noRunId, null);

    // The run exists but its coverage artifacts have expired or failed to
    // download; the caller falls back to the ordinary comment.
    const unreadable = await buildUnattributedRegressionBody({
      rootDir,
      groups: [{ group: "packages/example", target: 1, current: 3 }],
      coverageFailures: [unattributedFailure()],
      prFiles: [],
      lcov,
      readBaselineLcov: () => Promise.resolve(null),
    });
    assertEquals(unreadable, null);
  });
});

Deno.test("writeCoverageDebtSuggestion falls back to the ordinary comment when the baseline is unreadable", async () => {
  const failures = [unattributedFailure()];
  const payload = await payloadFrom(() =>
    writeCoverageDebtSuggestion(
      4211,
      failures,
      [],
      "",
      () => Promise.resolve(null),
    )
  );

  assertEquals(payload?.state, "regressed");
  assertStringIncludes(payload?.body ?? "", "Could not tie the regression");
});

Deno.test("baselineLcovForRun gives up on a run with no coverage artifacts", async () => {
  const lcov = await baselineLcovForRun(900, () =>
    Promise.resolve([
      { id: 1, name: "perf-metrics", size_in_bytes: 10, expired: false },
    ]));

  assertEquals(lcov, null);
});

Deno.test("baselineLcovForRun gives up when the artifact listing fails", async () => {
  const lcov = await baselineLcovForRun(900, () => {
    throw new Error("artifact listing unavailable");
  });

  assertEquals(lcov, null);
});

Deno.test("combinedLcovFromArtifacts joins every artifact's uploaded report", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coverage-artifacts-" });
  try {
    const artifacts = [
      { id: 11, name: "coverage-profile-runner-1" },
      { id: 12, name: "coverage-profile-workspace-7" },
    ].map((artifact) => ({ ...artifact, size_in_bytes: 64, expired: false }));

    for (const [index, artifact] of artifacts.entries()) {
      const artifactDir = path.join(dir, artifact.name);
      await Deno.mkdir(artifactDir, { recursive: true });
      await Deno.writeTextFile(
        path.join(artifactDir, `${artifact.name}.lcov`),
        [
          `SF:/home/runner/work/labs/labs/packages/example/src/mod-${index}.ts`,
          "DA:1,1",
          "end_of_record",
        ].join("\n"),
      );
    }

    const { lcov, sourceDescription } = await combinedLcovFromArtifacts(
      artifacts,
      dir,
    );

    assertStringIncludes(lcov, "packages/example/src/mod-0.ts");
    assertStringIncludes(lcov, "packages/example/src/mod-1.ts");
    assertEquals(sourceDescription, "2 LCOV report files");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unscoredGroupsReport names the members and the groups they cost", () => {
  assertEquals(
    unscoredGroupsReport(["./tasks", "./packages/shell"]),
    "This run never launched ./packages/shell, ./tasks, so it carries no " +
      "measurement of packages/shell, tasks and does not score them.",
  );
});

Deno.test("unscoredGroupsReport says nothing for a run that launched everything", () => {
  assertEquals(unscoredGroupsReport([]), undefined);
});

Deno.test("combinedLcovFromArtifacts unions the records its artifacts carry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "coverage-unlaunched-union-" });
  try {
    const artifacts = [
      { id: 31, name: "coverage-profile-workspace-2" },
      { id: 32, name: "coverage-profile-workspace-5" },
      { id: 33, name: "coverage-profile-workspace-6" },
    ].map((artifact) => ({ ...artifact, size_in_bytes: 64, expired: false }));
    const records = [["./packages/shell", "./tasks"], ["./packages/shell"], []];

    for (const [index, artifact] of artifacts.entries()) {
      const artifactDir = path.join(dir, artifact.name);
      await Deno.mkdir(artifactDir, { recursive: true });
      await Deno.writeTextFile(
        path.join(artifactDir, `${artifact.name}.lcov`),
        "",
      );
      await writeUnlaunchedMembers(artifactDir, records[index]);
    }

    const { unlaunchedMembers } = await combinedLcovFromArtifacts(
      artifacts,
      dir,
    );

    // Every member any artifact names, each of them once, and nothing from the
    // artifact that carries no record.
    assertEquals([...unlaunchedMembers].sort(), [
      "./packages/shell",
      "./tasks",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("combinedLcovFromArtifacts refuses to report on no artifacts at all", async () => {
  // An empty set is not an empty report: it means the run uploaded nothing,
  // which must be an error rather than a workspace scored as uncovered.

  await assertRejects(
    () => combinedLcovFromArtifacts([]),
    Error,
    "contained no profile or LCOV files",
  );
});

Deno.test("buildUnattributedRegressionBody holds each group against its own baseline run", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-unattributed-" });
  try {
    const alphaPath = path.join(rootDir, "packages/alpha/src/mod.ts");
    const betaPath = path.join(rootDir, "packages/beta/src/mod.ts");
    await Deno.mkdir(path.dirname(alphaPath), { recursive: true });
    await Deno.mkdir(path.dirname(betaPath), { recursive: true });
    await Deno.writeTextFile(alphaPath, "export const alpha = 1;\n");
    await Deno.writeTextFile(betaPath, "export const beta = 1;\n");

    const report = (alphaHits: number, betaHits: number) =>
      [
        `SF:${alphaPath}`,
        `DA:1,${alphaHits}`,
        "end_of_record",
        `SF:${betaPath}`,
        `DA:1,${betaHits}`,
        "end_of_record",
      ].join("\n");

    // Two groups regress, and their baselines resolve to different main runs.
    // Run 901 covered both lines; run 902 covered neither. Only alpha is held
    // against 901, so only alpha regressed — beta's own baseline never covered
    // its line, which makes it existing debt.
    const read = new Map([[901, report(1, 1)], [902, report(0, 0)]]);
    const body = await buildUnattributedRegressionBody({
      rootDir,
      groups: [
        { group: "packages/alpha", target: 1, current: 2 },
        { group: "packages/beta", target: 1, current: 2 },
      ],
      coverageFailures: [
        {
          metric: "coverage-debt: packages/alpha uncovered lines",
          status: "OVER",
          current: 2,
          baseline: 1,
          baselineRunId: 901,
        },
        {
          metric: "coverage-debt: packages/beta uncovered lines",
          status: "OVER",
          current: 2,
          baseline: 1,
          baselineRunId: 902,
        },
      ],
      prFiles: [],
      lcov: report(0, 0),
      readBaselineLcov: (runId) => Promise.resolve(read.get(runId) ?? null),
    });

    assertStringIncludes(body ?? "", "`packages/alpha/src/mod.ts`: 1");
    assertFalse((body ?? "").includes("packages/beta/src/mod.ts"));
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("workflowAnnotation escapes what the runner would read as syntax", () => {
  assertEquals(
    workflowAnnotation("warning", "Coverage: not gated, again", "50%\nof it"),
    "::warning title=Coverage%3A not gated%2C again::50%25%0Aof it",
  );
  assertEquals(
    workflowAnnotation("error", "t", "a\rb"),
    "::error title=t::a%0Db",
  );
});

Deno.test("appendJobSummary appends to the summary file the runner names", async () => {
  const file = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await withEnv({ GITHUB_STEP_SUMMARY: file }, async () => {
      await appendJobSummary("## First");
      await appendJobSummary("## Second");
    });

    assertEquals(await Deno.readTextFile(file), "## First\n## Second\n");
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("appendJobSummary does nothing where no summary file is named", async () => {
  const warnings: string[] = [];
  await withEnv(
    { GITHUB_STEP_SUMMARY: undefined },
    () => appendJobSummary("## Unwritten", (message) => warnings.push(message)),
  );

  assertEquals(warnings, []);
});

Deno.test("appendJobSummary warns about a summary file it cannot write", async () => {
  const warnings: string[] = [];
  await withEnv(
    { GITHUB_STEP_SUMMARY: "/nonexistent-directory/summary.md" },
    () => appendJobSummary("## Lost", (message) => warnings.push(message)),
  );

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "could not write the job summary");
});

Deno.test("reportNotGated says loudly which changed groups were held against nothing", () => {
  const logs: string[] = [];
  reportNotGated(
    {
      groups: [
        { group: "tasks", reason: "no-baseline" },
        { group: "packages/shell", reason: "no-baseline" },
      ],
      measurement: { baseSha: SHA_C },
    },
    (message) => logs.push(message),
  );
  const output = logs.join("\n");

  assertStringIncludes(
    output,
    "!!! COVERAGE WAS NOT GATED for 2 changed source group(s): " +
      "packages/shell, tasks !!!",
  );
  assertStringIncludes(output, "base-branch commit `cccccccc`");
  assertStringIncludes(
    output,
    "::warning title=Test coverage was NOT gated on this run::" +
      "No baseline was held against: packages/shell, tasks.",
  );
});

Deno.test("reportNotGated annotates an ungated run that failed as an error", () => {
  const logs: string[] = [];
  reportNotGated(
    {
      groups: [{ group: "tasks", reason: "listing-not-current" }],
    },
    (message) => logs.push(message),
  );

  assertStringIncludes(logs.join("\n"), "::error title=Test coverage was NOT");
});

Deno.test("reportNotGated says nothing when every changed group was compared", () => {
  const logs: string[] = [];
  reportNotGated(
    { groups: [] },
    (message) => logs.push(message),
  );

  assertEquals(logs, []);
});

Deno.test("coverageOutcomeLine claims the ratchet only for the groups it compared", () => {
  assertEquals(
    coverageOutcomeLine([]),
    "Coverage debt within the ratchet for every changed group.",
  );
  assertEquals(
    coverageOutcomeLine([
      { group: "tasks", reason: "no-baseline" },
      { group: "packages/shell", reason: "base-branch-moved" },
    ]),
    "Coverage debt was NOT gated for packages/shell, tasks; every other " +
      "changed group is within the ratchet.",
  );
});

Deno.test("buildCoverageJobSummary leads with the groups that went ungated", () => {
  const summary = buildCoverageJobSummary({
    rows: [
      coverageRow(RUNNER_METRIC, 5740, 5746),
      coverageRow(MEMORY_METRIC, 12, undefined, "excl"),
    ],
    failures: [],
    notGated: [{ group: "packages/memory", reason: "no-baseline" }],
    measurement: { baseSha: SHA_C },
  });

  assertStringIncludes(summary, "## Coverage Check");
  assertStringIncludes(
    summary,
    "### ⚠️ Test coverage was NOT gated on this run",
  );
  assertStringIncludes(summary, "| `packages/memory` | No successful `main`");
  // The group that was compared is still reported, and the one that was not
  // has no row to mislead with.
  assertStringIncludes(summary, "| OK | 5746 | 5740 |");
  assertStringIncludes(summary, "| packages/runner |");
  assertFalse(summary.includes("within the ratchet for every changed group"));
});

Deno.test("buildCoverageJobSummary says when every changed group is within the ratchet", () => {
  const summary = buildCoverageJobSummary({
    rows: [coverageRow(RUNNER_METRIC, 5740, 5746)],
    failures: [],
    notGated: [],
  });

  assertStringIncludes(
    summary,
    "Coverage debt is within the ratchet for every changed group.",
  );
  assertFalse(summary.includes("NOT gated"));
});

Deno.test("buildCoverageJobSummary counts the groups that regressed", () => {
  const over = coverageRow(RUNNER_METRIC, 5750, 5746, "OVER");
  const summary = buildCoverageJobSummary({
    rows: [over],
    failures: [over],
    notGated: [],
  });

  assertStringIncludes(
    summary,
    "### Coverage debt regressed in 1 source group(s)",
  );
  assertStringIncludes(summary, "| OVER | 5746 | 5750 |");
});

Deno.test("buildCoverageJobSummary draws no table when nothing was compared", () => {
  const summary = buildCoverageJobSummary({
    rows: [],
    failures: [],
    notGated: [{ group: "tasks", reason: "listing-not-current" }],
  });

  assertStringIncludes(summary, "The **Coverage Check** job failed");
  assertFalse(summary.includes("| Status |"));
});

/** A run listing that is current and holds `runs`, with no older page. */
function listingOf(
  runs: WorkflowRun[],
  extra: Partial<BaselineRunListing> = {},
): BaselineRunListing {
  return {
    current: true,
    reachedCurrentRun: true,
    candidates: runs,
    newest: runs[0],
    pagesRead: 1,
    older: () => Promise.resolve(null),
    accountsFor: () => true,
    ...extra,
  };
}

/**
 * Runs the ratchet stage for a pull request that changed `packages/runner`,
 * against a fake run listing and fake baseline runs, and returns the exit code
 * with everything the stage reported.
 */
async function runRatchet(options: {
  listing:
    | BaselineRunListing
    | ((currentRunId: number) => Promise<BaselineRunListing>);
  readings?: [WorkflowRun, BaselineRunReading][];
  current?: number;

  /** Further metrics this run measured, beside the runner's. */
  alsoMeasured?: Record<string, number>;
  prNumber?: number | null;
  changed?: string[];
  overrides?: CoverageRatchetInput["prOverrides"];
  changedOnBase?: string[];

  /** Stands in for GitHub for whatever the stage reads from it. */
  github?: (url: string) => Response;

  /** Reads baseline runs with the stage's own reader, not from `readings`. */
  ownRunReader?: boolean;

  /** Reads the base-branch commit's ancestry from `github`, not from `RANKS`. */
  ownAncestry?: boolean;

  /** Reads the base-branch commit's ancestry, in place of `RANKS`. */
  readRanks?: () => Promise<Map<string, number>>;
}) {
  const dir = await Deno.makeTempDir({ prefix: "coverage-ratchet-" });
  const commentFile = path.join(dir, "coverage-comment.json");
  const summaryFile = path.join(dir, "summary.md");
  const asked: number[] = [];
  const readText = (file: string) =>
    Deno.readTextFile(file).catch(() => undefined);

  try {
    const captured = await captureConsoleAsync(() =>
      withEnv(
        {
          COVERAGE_COMMENT_FILE: commentFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
        () =>
          // A regression asks for the baseline run's coverage artifacts, which
          // these runs do not have.
          withMockFetch(
            (input) =>
              options.github?.(String(input)) ??
                new Response("not found", { status: 404 }),
            () =>
              runCoverageRatchet({
                prNumber: options.prNumber === undefined
                  ? 42
                  : options.prNumber,
                currentRunId: 1050,
                perfArtifact: {
                  metrics: new Map(
                    Object.entries({
                      [RUNNER_METRIC]: options.current ?? 5746,
                      ...options.alsoMeasured,
                    }).map(([metric, uncoveredLines]) => [
                      metric,
                      makeBaselineSample(
                        1050,
                        SHA_C,
                        "2026-08-04T11:00:00Z",
                        uncoveredLines,
                      ),
                    ]),
                  ),
                  compileCacheStates: {},
                },
                prOverrides: options.overrides ?? NO_OVERRIDES,
                changedCoverageGroups: new Set(
                  options.changed ?? ["packages/runner"],
                ),
                prFiles: [],
                coverageLcov: "",
                readListing: (listingOptions) => {
                  asked.push(listingOptions.currentRunId);
                  return typeof options.listing === "function"
                    ? options.listing(listingOptions.currentRunId)
                    : Promise.resolve(options.listing);
                },
                readBaselineRun: options.ownRunReader
                  ? undefined
                  : (run) =>
                    Promise.resolve(
                      (options.readings ?? []).find(([candidate]) =>
                        candidate.id === run.id
                      )?.[1] ?? reading(run, {}),
                    ),
                baselineReads: {
                  readBaseSha: () => Promise.resolve(SHA_C),
                  fetchRanks: options.ownAncestry
                    ? undefined
                    : options.readRanks ?? (() => Promise.resolve(RANKS)),
                  // Nothing lies between a commit and itself, which is what
                  // `fetchGroupsChangedOnBase()` reports too.
                  fetchChangedGroups: (baselineSha, baseSha) =>
                    Promise.resolve(
                      new Set(
                        baselineSha === baseSha
                          ? []
                          : options.changedOnBase ?? [],
                      ),
                    ),
                },
              }),
          ),
      )
    );

    const comment = await readText(commentFile);
    return {
      code: captured.result,
      asked,
      payload: comment === undefined
        ? null
        : JSON.parse(comment) as CoverageCommentPayload,
      summary: await readText(summaryFile),
      logs: captured.logs.join("\n"),
      warnings: captured.warnings.join("\n"),
      errors: captured.errors.join("\n"),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("runCoverageRatchet passes a changed group at its base commit's count", async () => {
  const ran = await runRatchet({
    listing: listingOf([RUN_AT_BASE]),
    readings: [[RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 })]],
  });

  assertEquals(ran.code, 0);
  assertEquals(ran.asked, [1050]);
  assertEquals(ran.payload?.state, "resolved");
  assertStringIncludes(
    ran.logs,
    "Coverage debt within the ratchet for every changed group.",
  );
  assertStringIncludes(ran.logs, "OVER: 0, OK: 1, ovrd: 0, excl: 0, n/a: 0");
  assertFalse(ran.logs.includes("NOT GATED"));
  assertStringIncludes(ran.summary ?? "", "| OK | 5746 | 5746 |");
});

Deno.test("runCoverageRatchet fails a changed group above its base commit's count", async () => {
  const ran = await runRatchet({
    listing: listingOf([RUN_AT_BASE]),
    readings: [[RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 })]],
    current: 5750,
  });

  assertEquals(ran.code, 1);
  assertEquals(ran.payload?.state, "regressed");
  assertStringIncludes(ran.logs, "COVERAGE DEBT REGRESSION in 1 source group");
  assertStringIncludes(ran.logs, "ACCEPT_COVERAGE_DEBT: packages/runner +4");
  assertStringIncludes(
    ran.summary ?? "",
    "### Coverage debt regressed in 1 source group(s)",
  );
});

Deno.test("runCoverageRatchet reports a regression on a main run without failing it", async () => {
  const ran = await runRatchet({
    listing: listingOf([RUN_AT_BASE]),
    readings: [[RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 })]],
    current: 5750,
    prNumber: null,
  });

  assertEquals(ran.code, 0);
  assertEquals(ran.payload, null);
  assertEquals(ran.summary, undefined);
  assertStringIncludes(ran.logs, "This build would fail if it were a PR.");
});

Deno.test("runCoverageRatchet finds the base commit's run on an older page of the listing", async () => {
  // A job re-run days after its run was created: the newest page holds only
  // runs for commits that landed since.
  const later = makeRun(9, "d".repeat(40), "2026-08-04T12:00:00Z");
  const pages = [[RUN_AT_BASE]];
  const ran = await runRatchet({
    listing: listingOf([later], {
      older: () => Promise.resolve(pages.shift() ?? null),
    }),
    readings: [[RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5740 })]],
    current: 5750,
  });

  assertEquals(ran.code, 1);
  assertStringIncludes(
    ran.logs,
    "Ratchet baseline measured at the base-branch commit: cccccccc.",
  );
});

Deno.test("runCoverageRatchet passes a changed group no ancestor's run measured, and says so everywhere", async () => {
  // The listing is current and none of its runs is for the base-branch commit
  // or an ancestor of it.
  const later = makeRun(9, "d".repeat(40), "2026-08-04T12:00:00Z");
  const ran = await runRatchet({ listing: listingOf([later]), current: 9999 });

  assertEquals(ran.code, 0);
  assertStringIncludes(
    ran.logs,
    "No `main` run has measured base-branch commit cccccccc or any of its " +
      "ancestors.",
  );
  assertStringIncludes(ran.logs, "OVER: 0, OK: 0, ovrd: 0, excl: 1, n/a: 0");
  assertStringIncludes(
    ran.logs,
    "!!! COVERAGE WAS NOT GATED for 1 changed source group(s): " +
      "packages/runner !!!",
  );
  assertStringIncludes(ran.logs, "::warning title=Test coverage was NOT gated");
  assertStringIncludes(
    ran.logs,
    "Coverage debt was NOT gated for packages/runner; every other changed " +
      "group is within the ratchet.",
  );
  assertFalse(ran.logs.includes("within the ratchet for every changed group"));

  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "| `packages/runner` | No successful `main` run within reach measured " +
      "base-branch commit `cccccccc` or an ancestor of it. |",
  );
  assertStringIncludes(
    ran.summary ?? "",
    "### ⚠️ Test coverage was NOT gated on this run",
  );
});

Deno.test("runCoverageRatchet says which changed group the base branch moved under it", async () => {
  // The base-branch commit has no run yet, and `main` changed the runner
  // between the nearest ancestor that has one and that commit.
  const ran = await runRatchet({
    listing: listingOf([RUN_ONE_BACK]),
    readings: [[
      RUN_ONE_BACK,
      reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 5746 }),
    ]],
    current: 9999,
    changedOnBase: ["packages/runner"],
  });

  assertEquals(ran.code, 0);
  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "| `packages/runner` | `main` changed this group between the nearest " +
      "measured ancestor (`bbbbbbbb`) and base-branch commit `cccccccc`. |",
  );
});

Deno.test("runCoverageRatchet reads a baseline run's artifacts and merged pull request itself", async () => {
  // The base-branch commit's run uploaded no baseline artifact, and the pull
  // request that merged it accepted debt, so the run is read and measures
  // nothing.
  const requests: string[] = [];
  const ran = await runRatchet({
    listing: listingOf([RUN_AT_BASE]),
    ownRunReader: true,
    github: (url) => {
      requests.push(url);
      if (url.includes(`/actions/runs/${RUN_AT_BASE.id}/artifacts`)) {
        return jsonResponse({ total_count: 0, artifacts: [] });
      }
      if (url.includes(`/commits/${SHA_C}/pulls`)) {
        return jsonResponse([{
          ...makePR(7001, "2026-08-04T10:39:00Z"),
          body: "ACCEPT_COVERAGE_DEBT: packages/runner +3 lines",
        }]);
      }
      return new Response("not found", { status: 404 });
    },
  });

  assertEquals(ran.code, 0);
  assertEquals(requests.length, 2);
  assertStringIncludes(
    ran.logs,
    `run ${RUN_AT_BASE.id} cccccccc PR #7001; no perf-metrics artifact`,
  );
  assertStringIncludes(
    ran.logs,
    "Found 1 coverage baseline override(s) from merged PRs.",
  );
  assertEquals(ran.payload?.state, "ungated");
});

Deno.test("runCoverageRatchet fails a pull request whose run listing is not current", async () => {
  const stale = makeRun(32577018558, SHA_A, "2026-08-22T13:52:12Z");
  const ran = await runRatchet({
    listing: listingOf([stale], { current: false, reachedCurrentRun: false }),
    // A baseline the listing named would have passed this run.
    readings: [[stale, reading(stale, { [RUNNER_METRIC]: 9999 })]],
  });

  assertEquals(ran.code, 1);
  assertStringIncludes(ran.warnings, "run listing is not current");
  assertStringIncludes(
    ran.errors,
    "!!! COVERAGE WAS NOT GATED for 1 changed source group(s): " +
      "packages/runner !!!",
  );
  assertStringIncludes(ran.errors, "::error title=Test coverage was NOT gated");
  assertStringIncludes(
    ran.errors,
    "Failing because the workflow's run listing is not current",
  );
  assertStringIncludes(ran.errors, "run 32577018558 (2026-08-22T13:52:12Z)");
  assertStringIncludes(ran.errors, "Re-run this job");
  // Nothing was compared, so there is no table to read a verdict off.
  assertFalse(ran.logs.includes("## Coverage debt metrics"));

  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "The **Coverage Check** job failed because it could not find a baseline",
  );
  assertStringIncludes(
    ran.payload?.body ?? "",
    "https://github.com/commonfabric/labs/actions/runs/1050",
  );
  assertStringIncludes(
    ran.summary ?? "",
    "Re-run the **Coverage Check** job",
  );
});

Deno.test("runCoverageRatchet passes a main run whose run listing is not current", async () => {
  const ran = await runRatchet({
    listing: listingOf([], { current: false, reachedCurrentRun: false }),
    prNumber: null,
  });

  assertEquals(ran.code, 0);
  assertEquals(ran.payload, null);
  assertStringIncludes(ran.warnings, "run listing is not current");
  assertStringIncludes(ran.warnings, "skipping the baseline comparison");
  assertFalse(ran.logs.includes("## Coverage debt metrics"));
});

Deno.test("runCoverageRatchet resolves an earlier comment for a pull request it gates nothing for over a listing that is not current", async () => {
  const notCurrent = listingOf([], {
    current: false,
    reachedCurrentRun: false,
  });

  // The pull request no longer changes a source group, so an earlier run's
  // regression or listing failure is no longer what the comment should say.
  const docsOnly = await runRatchet({ listing: notCurrent, changed: [] });
  assertEquals(docsOnly.code, 0);
  assertEquals(docsOnly.payload?.state, "resolved");
  assertEquals(docsOnly.payload?.overridden, false);
  assertEquals(docsOnly.payload?.groups, []);

  // A reset is an acceptance, and no group was compared for it to show.
  const reset = await runRatchet({
    listing: notCurrent,
    overrides: { metrics: new Map(), coverageBaselineReset: true },
  });
  assertEquals(reset.code, 0);
  assertEquals(reset.payload?.state, "resolved");
  assertEquals(reset.payload?.overridden, true);
  assertEquals(reset.payload?.groups, []);
});

/** Rejects the way GitHub's API reports a rate limit. */
function rateLimited(): Promise<never> {
  return Promise.reject(new Error("API rate limit exceeded"));
}

Deno.test("runCoverageRatchet passes a rate-limited pull request and says it gated nothing", async () => {
  const ran = await withPerfArtifact(() =>
    runRatchet({ listing: rateLimited })
  );

  assertEquals(ran.code, 0);
  assertStringIncludes(
    ran.warnings,
    "GitHub API rate limit while reading the workflow's run listing",
  );
  assertStringIncludes(
    ran.logs,
    "!!! COVERAGE WAS NOT GATED for 1 changed source group(s): " +
      "packages/runner !!!",
  );
  // A warning rather than an error: the job passed.
  assertStringIncludes(ran.logs, "::warning title=Test coverage was NOT gated");
  assertStringIncludes(
    ran.logs,
    "Passing without a coverage gate: GitHub API rate limits prevented " +
      "reading the workflow's run listing.",
  );
  // Nothing was compared, so there is no table to read a verdict off.
  assertFalse(ran.logs.includes("## Coverage debt metrics"));

  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "| `packages/runner` | GitHub's API rate limit stopped this run reading " +
      "the baseline data, so nothing was compared. |",
  );
  assertStringIncludes(
    ran.payload?.body ?? "",
    "https://github.com/commonfabric/labs/actions/runs/1050",
  );
  assertStringIncludes(
    ran.summary ?? "",
    "### ⚠️ Test coverage was NOT gated on this run",
  );
});

Deno.test("runCoverageRatchet reports a rate limit the baseline walk ran into as one", async () => {
  // The limit is reached after the listing, on a read the walk makes through
  // its guard.
  const ran = await withPerfArtifact(() =>
    runRatchet({
      listing: listingOf([RUN_AT_BASE]),
      readings: [[
        RUN_AT_BASE,
        reading(RUN_AT_BASE, { [RUNNER_METRIC]: 5746 }),
      ]],
      readRanks: rateLimited,
    })
  );

  assertEquals(ran.code, 0);
  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.warnings,
    "GitHub API rate limit while listing the base-branch commit's ancestry",
  );
  assertStringIncludes(
    ran.payload?.body ?? "",
    "GitHub's API rate limit stopped this run reading the baseline data",
  );
  // A run that gave up part way through has read no baseline, which is not the
  // same as having looked for one and found none.
  assertFalse(
    (ran.payload?.body ?? "").includes("No successful `main` run within reach"),
  );
});

Deno.test("runCoverageRatchet reports a rate-limited baseline artifact read as a rate limit", async () => {
  // The listing succeeds and the limit is reached on the baseline run's own
  // artifact listing, which the walk reads best-effort. Swallowed there it
  // would report a run that measured nothing, and the group would read as one
  // no `main` run has covered yet.
  const ran = await withPerfArtifact(() =>
    runRatchet({
      listing: listingOf([RUN_AT_BASE]),
      ownRunReader: true,
      github: (url) =>
        url.includes(`/actions/runs/${RUN_AT_BASE.id}/artifacts`)
          ? new Response('{"message":"API rate limit exceeded for user"}', {
            status: 403,
            statusText: "Forbidden",
            headers: { "x-ratelimit-remaining": "0" },
          })
          : jsonResponse([]),
    })
  );

  assertEquals(ran.code, 0);
  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "GitHub's API rate limit stopped this run reading the baseline data",
  );
  assertFalse(
    (ran.payload?.body ?? "").includes("No successful `main` run within reach"),
  );
});

Deno.test("runCoverageRatchet reports a rate-limited merged-pull-request lookup as a rate limit", async () => {
  // The walk keeps an ordinary lookup failure as a value, which costs that
  // commit's accepted debt and no more. A limit kept the same way would let the
  // run hold a group against a baseline whose acceptance it never read.
  const ran = await withPerfArtifact(() =>
    runRatchet({
      listing: listingOf([RUN_AT_BASE]),
      ownRunReader: true,
      github: (url) =>
        url.includes(`/commits/${SHA_C}/pulls`)
          ? new Response('{"message":"API rate limit exceeded for user"}', {
            status: 403,
            statusText: "Forbidden",
            headers: { "x-ratelimit-remaining": "0" },
          })
          : jsonResponse({ total_count: 0, artifacts: [] }),
    })
  );

  assertEquals(ran.code, 0);
  assertEquals(ran.payload?.state, "ungated");
  assertStringIncludes(
    ran.payload?.body ?? "",
    "GitHub's API rate limit stopped this run reading the baseline data",
  );
  assertFalse(ran.logs.includes("PR lookup failed"));
});

Deno.test("runCoverageRatchet passes a rate-limited main run with no comment to write", async () => {
  const ran = await withPerfArtifact(() =>
    runRatchet({ listing: rateLimited, prNumber: null })
  );

  assertEquals(ran.code, 0);
  assertEquals(ran.payload, null);
  assertEquals(ran.summary, undefined);
  assertStringIncludes(ran.warnings, "skipping the baseline comparison");
});

Deno.test("runCoverageRatchet resolves an earlier comment for a rate-limited pull request it gates nothing for", async () => {
  const ran = await withPerfArtifact(() =>
    runRatchet({ listing: rateLimited, changed: [] })
  );

  assertEquals(ran.code, 0);
  assertEquals(ran.payload?.state, "resolved");
  assertEquals(ran.payload?.groups, []);
});

Deno.test("runCoverageRatchet rethrows a failure that is not a rate limit", async () => {
  await assertRejects(
    () =>
      runRatchet({
        listing: () => Promise.reject(new Error("the network is down")),
      }),
    Error,
    "the network is down",
  );
});

Deno.test("runCoverageRatchet finds the base commit's run across a page boundary before settling on an older ancestor", async () => {
  // The older ancestor's run is on the newest page and the base-branch commit's
  // own run is on the next, and `main` changed the runner in between. Settling
  // on the ancestor would leave the runner ungated and pass a regression.
  const pages = [[RUN_AT_BASE]];
  const shown = new Set([SHA_B]);
  const ran = await runRatchet({
    listing: listingOf([RUN_ONE_BACK], {
      older: () => {
        const page = pages.shift() ?? null;
        for (const run of page ?? []) shown.add(run.head_sha);
        return Promise.resolve(page);
      },
      accountsFor: (sha) => shown.has(sha),
    }),
    readings: [
      [RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 10 })],
      [RUN_ONE_BACK, reading(RUN_ONE_BACK, { [RUNNER_METRIC]: 20 })],
    ],
    current: 15,
    changedOnBase: ["packages/runner"],
  });

  assertEquals(ran.code, 1);
  assertEquals(ran.payload?.state, "regressed");
  assertStringIncludes(
    ran.logs,
    "Ratchet baseline measured at the base-branch commit: cccccccc.",
  );
  assertFalse(ran.logs.includes("NOT GATED"));
});

Deno.test("runCoverageRatchet reads on for the base commit's run whatever date the commit carries", async () => {
  // The same boundary, through the real listing reader and the real ancestry
  // read. The base-branch commit's committer date is a minute after its run was
  // created: a date is whatever the client that made the commit said it was,
  // so it says nothing about where in the listing the commit's run sits.
  const baseRun = makeRun(1000, SHA_C, createdAtFor(1000));
  const ancestorRun = makeRun(1001, SHA_B, createdAtFor(1001));
  const pages = [
    listingPage(1100).map((run) => run.id === 1001 ? ancestorRun : run),
    listingPage(1000).map((run) => run.id === 1000 ? baseRun : run),
  ];
  const pagesAsked: number[] = [];
  const ran = await runRatchet({
    listing: (currentRunId) =>
      readBaselineRunListing({
        currentRunId,
        fetchPage: (page) => {
          pagesAsked.push(page);
          return Promise.resolve(pages[page - 1] ?? []);
        },
        log: () => {},
      }),
    ownAncestry: true,
    github: (url) =>
      url.includes(`/commits?sha=${SHA_C}`)
        ? jsonResponse([
          { sha: SHA_C, commit: { committer: { date: createdAtFor(1060) } } },
          { sha: SHA_B, commit: { committer: { date: createdAtFor(900) } } },
        ])
        : new Response("not found", { status: 404 }),
    readings: [
      [baseRun, reading(baseRun, { [RUNNER_METRIC]: 10 })],
      [ancestorRun, reading(ancestorRun, { [RUNNER_METRIC]: 20 })],
    ],
    current: 15,
    changedOnBase: ["packages/runner"],
  });

  assertEquals(pagesAsked, [1, 2]);
  assertEquals(ran.code, 1);
  assertEquals(ran.payload?.state, "regressed");
  assertStringIncludes(
    ran.logs,
    "Ratchet baseline measured at the base-branch commit: cccccccc.",
  );
});

Deno.test("runCoverageRatchet does not say the job passed when one group regressed and another went ungated", async () => {
  const ran = await runRatchet({
    listing: listingOf([RUN_AT_BASE]),
    readings: [[RUN_AT_BASE, reading(RUN_AT_BASE, { [RUNNER_METRIC]: 10 })]],
    current: 15,
    alsoMeasured: { [MEMORY_METRIC]: 12 },
    changed: ["packages/runner", "packages/memory"],
  });

  assertEquals(ran.code, 1);
  assertEquals(ran.payload?.state, "regressed");
  assertStringIncludes(
    ran.summary ?? "",
    "### Coverage debt regressed in 1 source group(s)",
  );
  assertStringIncludes(
    ran.summary ?? "",
    "The **Coverage Check** job did not hold `packages/memory` against a " +
      "baseline",
  );
  for (const surface of [ran.logs, ran.summary ?? ""]) {
    assertFalse(surface.includes("job passed"));
    assertFalse(surface.includes("job failed because it could not find"));
  }
  // The regression is what failed the job, so the ungated group is a warning.
  assertStringIncludes(ran.logs, "::warning title=Test coverage was NOT gated");
});
