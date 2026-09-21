/**
 * Tile tests: each tile is a pure collect(ctx) -> TileView, exercised with a
 * hand-made Ctx. No server, no network, no subprocess — the CI tiles get canned
 * runs and the token-gated tiles get an empty env (their gray-out contract).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { TILE_LAYOUT_FIXTURES } from "./tile-layout-fixtures.ts";
import { runSource, type Ctx, type Run } from "./types.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "./config.ts";
import { labsCi, loomCi } from "./tiles/main-build.ts";
import { labsCiTrust, loomCiTrust } from "./tiles/ci-trust.ts";
import { labsCiDuration, loomCiDuration } from "./tiles/ci-duration.ts";
import { commitGanttHref, recentRuns } from "./tiles/recent-runs.ts";
import { dau, foldSeries, parseExcludes } from "./tiles/dau.ts";
import { coverageDebt } from "./tiles/coverage-debt.ts";
import { githubMembers } from "./tiles/github-members.ts";
import { buildSnapshot, discordOnline } from "./tiles/discord-online.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import {
  GITHUB_LAG_DAYS,
  githubCiSpend,
} from "./tiles/github-ci-spend.ts";
import { projectMonthly, settled } from "./spend.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import {
  benchmark,
  formatNs,
  trendPct,
  trendStatus,
} from "./tiles/benchmark.ts";
import { TILES } from "./registry.ts";
import {
  byUrl,
  type GithubAnswer,
  withGithubAttempt,
} from "./test/github-attempts.ts";

function ctx(
  runs: Run[],
  env: Record<string, string> = {},
  runsByRepo?: (repo: string) => Run[],
): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: (repo: string) =>
      Promise.resolve(runsByRepo ? runsByRepo(repo) : runs),
    env: (k) => env[k],
  };
}

let nextRunId = 1;

function run(over: Partial<Run>): Run {
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: nextRunId++,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "sha",
    display_title: "t",
    created_at: startedAt,
    run_started_at: startedAt,
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: "t (#1)" },
    ...over,
  };
}

// An earlier attempt of `of`, as GitHub's attempt endpoint returns it.
function attemptOf(of: Run, attempt: number, conclusion: string): Run {
  return { ...of, run_attempt: attempt, conclusion };
}

function attemptUrl(attempt: Run, repo = REPO): string {
  return `https://api.github.com/repos/${repo}/actions/runs/${attempt.id}/attempts/${attempt.run_attempt}`;
}

// Where the job count of `attempt` is requested.
function jobsUrl(attempt: Run, repo = REPO): string {
  return `${attemptUrl(attempt, repo)}/jobs?per_page=1`;
}

// The trust grid's cell colors, in the newest-first order the runs arrive in.
function cellColors(extra: string | undefined): string[] {
  return [...(extra ?? "").matchAll(/background:(var\(--[^)]+\))/g)]
    .map((match) => match[1])
    .reverse();
}

Deno.test("labs ci:passing tip -> good", async () => {
  const v = await labsCi.collect(ctx([run({ conclusion: "success" })]));
  assertEquals(v.status, "good");
  assertEquals(v.value, "passing");
});

Deno.test("labs ci:failing tip -> bad (shows the raw conclusion)", async () => {
  const v = await labsCi.collect(ctx([run({ conclusion: "failure" })]));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "failure");
});

Deno.test("labs ci:no completed runs -> unknown", async () => {
  const v = await labsCi.collect(
    ctx([run({ status: "in_progress", conclusion: null })]),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
});

Deno.test("labs ci trust: only first-attempt success counts as green", async () => {
  // Two of four completed runs passed first try. A success on retry remains in
  // the denominator but does not count as first-try green.
  const retried = run({ conclusion: "success", run_attempt: 2 });
  const runs = [
    run({ conclusion: "success", run_attempt: 1 }),
    run({ conclusion: "success", run_attempt: 1 }),
    retried,
    run({ conclusion: "failure" }),
  ];
  await withGithubAttempt(
    attemptOf(retried, 1, "failure"),
    async () => {
      const v = await labsCiTrust.collect(ctx(runs));
      assertEquals(v.value, "50.0%");
      assertEquals(v.status, "bad");
      assertEquals(v.sub, "first-try green · last 4 runs");
    },
  );
});

Deno.test("labs and loom ci trust: a cancelled run that never started is left out of the share", async () => {
  const cases = [
    { tile: labsCiTrust, repo: REPO },
    { tile: loomCiTrust, repo: LOOM_REPO },
  ];
  for (const { tile, repo } of cases) {
    const cancelled = [
      run({ conclusion: "cancelled" }),
      run({ conclusion: "cancelled" }),
    ];
    const runs = [
      run({ conclusion: "success" }),
      cancelled[0],
      cancelled[1],
      run({ conclusion: "failure" }),
    ];
    const jobs = cancelled.map((attempt) => jobsUrl(attempt, repo));
    await withGithubAttempt(
      byUrl(jobs.map((url) => [url, { total_count: 0 }])),
      async (urls) => {
        const v = await tile.collect(ctx(runs));
        assertEquals(v.value, "50.0%");
        assertEquals(v.sub, "first-try green · 2 of last 4 runs");
        assertEquals(cellColors(v.extra), [
          "var(--status-good)",
          "var(--status-unknown)",
          "var(--status-unknown)",
          "var(--status-bad)",
        ]);
        assertEquals(urls.toSorted(), jobs.toSorted());
      },
    );
  }
});

Deno.test("labs and loom ci trust: a cancelled run that ran jobs counts as a failure", async () => {
  const cases = [
    { tile: labsCiTrust, repo: REPO },
    { tile: loomCiTrust, repo: LOOM_REPO },
  ];
  for (const { tile, repo } of cases) {
    const timedOut = run({ conclusion: "cancelled" });
    const runs = [
      run({ conclusion: "success" }),
      timedOut,
      run({ conclusion: "success" }),
      run({ conclusion: "failure" }),
    ];
    await withGithubAttempt(
      byUrl([[jobsUrl(timedOut, repo), { total_count: 38 }]]),
      async (urls) => {
        const v = await tile.collect(ctx(runs));
        assertEquals(v.value, "50.0%");
        assertEquals(v.sub, "first-try green · last 4 runs");
        assertEquals(cellColors(v.extra), [
          "var(--status-good)",
          "var(--status-bad)",
          "var(--status-good)",
          "var(--status-bad)",
        ]);
        assertEquals(urls, [jobsUrl(timedOut, repo)]);
      },
    );
  }
});

Deno.test("labs ci trust: a run is green only when its one attempt not cancelled before starting succeeded", async () => {
  const afterUnstartedGreen = run({ conclusion: "success", run_attempt: 2 });
  const afterUnstartedRed = run({ conclusion: "failure", run_attempt: 2 });
  const redAfterUnstarted = run({ conclusion: "success", run_attempt: 3 });
  const rerunOfGreen = run({ conclusion: "success", run_attempt: 2 });
  const neverStarted = run({ conclusion: "cancelled", run_attempt: 2 });
  const cancelledRetry = run({ conclusion: "cancelled", run_attempt: 2 });
  const successAfterTimeout = run({ conclusion: "success", run_attempt: 2 });
  const failedRerunOfGreen = run({ conclusion: "failure", run_attempt: 2 });
  const timedOutRerunOfGreen = run({ conclusion: "cancelled", run_attempt: 2 });
  const unstartedRerunOfGreen = run({
    conclusion: "cancelled",
    run_attempt: 2,
  });
  const earlier = [
    attemptOf(afterUnstartedGreen, 1, "cancelled"),
    attemptOf(afterUnstartedRed, 1, "cancelled"),
    attemptOf(redAfterUnstarted, 1, "cancelled"),
    attemptOf(redAfterUnstarted, 2, "failure"),
    attemptOf(rerunOfGreen, 1, "success"),
    attemptOf(neverStarted, 1, "cancelled"),
    attemptOf(cancelledRetry, 1, "failure"),
    attemptOf(successAfterTimeout, 1, "cancelled"),
    attemptOf(failedRerunOfGreen, 1, "success"),
    attemptOf(timedOutRerunOfGreen, 1, "success"),
    attemptOf(unstartedRerunOfGreen, 1, "success"),
  ];
  const unstarted = [
    attemptOf(afterUnstartedGreen, 1, "cancelled"),
    attemptOf(afterUnstartedRed, 1, "cancelled"),
    attemptOf(redAfterUnstarted, 1, "cancelled"),
    attemptOf(neverStarted, 1, "cancelled"),
    neverStarted,
    unstartedRerunOfGreen,
  ];
  const ranJobs = [
    attemptOf(successAfterTimeout, 1, "cancelled"),
    timedOutRerunOfGreen,
  ];

  await withGithubAttempt(
    byUrl([
      ...earlier.map((attempt) => [attemptUrl(attempt), attempt] as const),
      ...unstarted.map((attempt) =>
        [jobsUrl(attempt), { total_count: 0 }] as const
      ),
      ...ranJobs.map((attempt) =>
        [jobsUrl(attempt), { total_count: 38 }] as const
      ),
    ]),
    async (urls) => {
      const v = await labsCiTrust.collect(ctx([
        afterUnstartedGreen,
        afterUnstartedRed,
        redAfterUnstarted,
        rerunOfGreen,
        neverStarted,
        cancelledRetry,
        successAfterTimeout,
        failedRerunOfGreen,
        timedOutRerunOfGreen,
        unstartedRerunOfGreen,
      ]));
      // Green: the first and last, each left with one successful attempt once
      // the attempt cancelled before starting is passed over. The fifth was
      // cancelled before starting on every attempt and is left out. Every other
      // run is red: it failed, or ran jobs before it was cancelled, or needed a
      // rerun of an attempt that was left.
      assertEquals(cellColors(v.extra), [
        "var(--status-good)",
        "var(--status-bad)",
        "var(--status-bad)",
        "var(--status-bad)",
        "var(--status-unknown)",
        "var(--status-bad)",
        "var(--status-bad)",
        "var(--status-bad)",
        "var(--status-bad)",
        "var(--status-good)",
      ]);
      assertEquals(v.value, "22.2%");
      assertEquals(v.sub, "first-try green · 9 of last 10 runs");
      assertEquals(
        urls.toSorted(),
        [
          ...earlier.map((attempt) => attemptUrl(attempt)),
          ...[...unstarted, ...ranJobs].map((attempt) => jobsUrl(attempt)),
        ].toSorted(),
      );
    },
  );
});

Deno.test("labs ci trust: an earlier attempt is requested once", async () => {
  const retried = run({ conclusion: "success", run_attempt: 2 });
  const earlier = attemptOf(retried, 1, "cancelled");
  await withGithubAttempt(
    byUrl([
      [attemptUrl(earlier), earlier],
      [jobsUrl(earlier), { total_count: 0 }],
    ]),
    async (urls) => {
      assertEquals((await labsCiTrust.collect(ctx([retried]))).value, "100.0%");
      assertEquals((await labsCiTrust.collect(ctx([retried]))).value, "100.0%");
      assertEquals(urls, [attemptUrl(earlier), jobsUrl(earlier)]);
    },
  );
});

Deno.test("labs ci trust: the job count of a cancelled attempt is requested once, and no other attempt's is", async () => {
  const neverStarted = run({ conclusion: "cancelled" });
  const timedOut = run({ conclusion: "cancelled" });
  const runs = [
    run({ conclusion: "success" }),
    neverStarted,
    run({ conclusion: "failure" }),
    timedOut,
    run({ conclusion: "timed_out" }),
  ];
  const jobs = [jobsUrl(neverStarted), jobsUrl(timedOut)];
  await withGithubAttempt(
    byUrl([[jobs[0], { total_count: 0 }], [jobs[1], { total_count: 38 }]]),
    async (urls) => {
      for (let collection = 0; collection < 2; collection++) {
        const v = await labsCiTrust.collect(ctx(runs));
        assertEquals(v.value, "25.0%");
        assertEquals(v.sub, "first-try green · 4 of last 5 runs");
      }
      assertEquals(urls.toSorted(), jobs.toSorted());
    },
  );
});

Deno.test("labs ci trust: a job count is forgotten once its run leaves the window", async () => {
  const cancelled = run({ conclusion: "cancelled" });
  const other = run({ conclusion: "success" });
  await withGithubAttempt({ total_count: 0 }, async (urls) => {
    await labsCiTrust.collect(ctx([cancelled]));
    await labsCiTrust.collect(ctx([other]));
    await labsCiTrust.collect(ctx([cancelled]));
    assertEquals(urls, [jobsUrl(cancelled), jobsUrl(cancelled)]);
  });
});

Deno.test("labs ci trust: an earlier attempt GitHub does not return fails the collection", async () => {
  const retried = run({ conclusion: "success", run_attempt: 2 });
  await withGithubAttempt(
    new Error("attempt endpoint unavailable"),
    async () => {
      await assertRejects(
        () => labsCiTrust.collect(ctx([retried])),
        Error,
        "attempt endpoint unavailable",
      );
    },
  );
});

Deno.test("labs ci trust: a job count GitHub does not return fails the collection", async (t) => {
  const cases: { name: string; answer: GithubAnswer; message: string }[] = [
    {
      name: "failed request",
      answer: new Error("job listing unavailable"),
      message: "job listing unavailable",
    },
    {
      name: "count that is not a number",
      answer: { total_count: "38" },
      message: "did not include a numeric `total_count`",
    },
    {
      name: "missing count",
      answer: { total_count: undefined },
      message: "did not include a numeric `total_count`",
    },
  ];
  for (const { name, answer, message } of cases) {
    await t.step(name, async () => {
      const cancelled = run({ conclusion: "cancelled" });
      await withGithubAttempt(answer, async (urls) => {
        await assertRejects(
          () =>
            labsCiTrust.collect(ctx([
              run({ conclusion: "success" }),
              cancelled,
            ])),
          Error,
          message,
        );
        assertEquals(urls, [jobsUrl(cancelled)]);
      });
    });
  }
});

Deno.test(
  "labs ci trust grid: every run in the latest 160-run window has a cell",
  async () => {
    const createdAt = (index: number) => new Date(index * 1_000).toISOString();
    const runs = [
      run({
        status: "in_progress",
        conclusion: null,
        created_at: createdAt(160),
      }),
      ...Array.from({ length: 159 }, (_, index) =>
        run({
          conclusion: "success",
          created_at: createdAt(159 - index),
        })),
      run({ conclusion: "failure", created_at: createdAt(0) }),
    ];
    const view = await labsCiTrust.collect(ctx(runs));
    const cells = (view.extra ?? "").match(/class="cell"/g)?.length ?? 0;
    assertEquals(cells, 160);
    assertStringIncludes(
      view.extra ?? "",
      'class="cells labeled"',
    );
    assertEquals(
      view.sub,
      "first-try green · 159 of last 160 runs",
    );
    assert(
      !(view.extra ?? "").includes("var(--status-bad)"),
      "the 161st run must be outside the grid and percentage window",
    );
  },
);

Deno.test("labs ci trust grid: cell colors match trust scoring", async () => {
  const retried = run({ conclusion: "success", run_attempt: 2 });
  const neverStarted = run({ conclusion: "cancelled" });
  const timedOut = run({ conclusion: "cancelled" });
  const runs = [
    run({ conclusion: "success", run_attempt: 1 }),
    retried,
    run({ conclusion: "failure" }),
    neverStarted,
    timedOut,
    run({ status: "in_progress", conclusion: null }),
    run({ status: "queued", conclusion: null }),
    run({ status: "completed", conclusion: null }),
  ];
  const earlier = attemptOf(retried, 1, "failure");
  await withGithubAttempt(
    byUrl([
      [attemptUrl(earlier), earlier],
      [jobsUrl(neverStarted), { total_count: 0 }],
      [jobsUrl(timedOut), { total_count: 38 }],
    ]),
    async () => {
      const view = await labsCiTrust.collect(ctx(runs));
      const colors = cellColors(view.extra);
      assertEquals(view.value, "25.0%");
      assertEquals(colors.filter((color) => color === "var(--status-good)").length, 1);
      assertEquals(colors.filter((color) => color === "var(--status-bad)").length, 3);
      assertEquals(colors.filter((color) => color === "var(--running)").length, 1);
      assertEquals(
        colors.filter((color) => color === "var(--status-unknown)").length,
        3,
      );
    },
  );
});

Deno.test("labs ci trust grid: duration spans the displayed runs", async () => {
  const now = Date.now();
  const runs = [
    run({ created_at: new Date(now).toISOString() }),
    run({ created_at: new Date(now - 2 * 86_400_000).toISOString() }),
    run({ created_at: new Date(now - 5 * 86_400_000).toISOString() }),
  ];
  const view = await labsCiTrust.collect(ctx(runs));
  assertEquals(view.duration, 5 * 86_400_000);
  assertStringIncludes(view.extra ?? "", 'class="cells labeled"');

  const malformed = await labsCiTrust.collect(ctx([
    runs[0],
    run({ created_at: "not a timestamp" }),
    runs[2],
  ]));
  assertEquals(malformed.duration, 0);
  assert(!(malformed.extra ?? "").includes("cells labeled"));

  const window = Array.from({ length: 161 }, (_, i) =>
    run({ created_at: new Date(now - i * 86_400_000).toISOString() })
  );
  const limited = await labsCiTrust.collect(ctx(window));
  assertEquals(limited.duration, 159 * 86_400_000);
});

Deno.test("ci-duration window: the 6h window when it has >= 20 runs, else the most recent 20", async () => {
  const now = Date.now();
  const at = (minsAgo: number) =>
    run({
      created_at: new Date(now - minsAgo * 60_000).toISOString(),
      run_started_at: new Date(now - minsAgo * 60_000).toISOString(),
      updated_at: new Date(now - minsAgo * 60_000 + 5 * 60_000).toISOString(),
    });
  // 25 runs within the last ~25 min -> the 6h window wins (25 >= 20).
  const busy = Array.from({ length: 25 }, (_, i) => at(i));
  assertStringIncludes(
    (await labsCiDuration.collect(ctx(busy))).sub ?? "",
    "25 passing runs in the last 6h",
  );
  // 5 recent + 30 from two days ago -> only 5 in 6h (< 20) -> fall back to the last 20.
  const quiet = [
    ...Array.from({ length: 5 }, (_, i) => at(i)),
    ...Array.from({ length: 30 }, () => at(60 * 48)),
  ];
  assertStringIncludes(
    (await labsCiDuration.collect(ctx(quiet))).sub ?? "",
    "last 20 passing runs",
  );
});

Deno.test("ci-duration: only runs that passed end to end count", async () => {
  const now = Date.now();
  const at = (i: number, over: Partial<Run>) =>
    run({
      created_at: new Date(now - i * 60_000).toISOString(),
      run_started_at: new Date(now - i * 60_000).toISOString(),
      updated_at: new Date(now - i * 60_000 + 5 * 60_000).toISOString(),
      ...over,
    });
  const runs = [
    ...Array.from({ length: 20 }, (_, i) => at(i, { conclusion: "success" })),
    at(0, { conclusion: "failure" }),
    at(1, { conclusion: "cancelled" }),
    at(2, { conclusion: "timed_out" }),
    at(3, { status: "in_progress", conclusion: null }),
    at(4, { event: "workflow_dispatch", conclusion: "success" }),
  ];
  // Only the 20 successful push runs are counted; the rest are ignored.
  assertStringIncludes(
    (await labsCiDuration.collect(ctx(runs))).sub ?? "",
    "20 passing runs in the last 6h",
  );
});

Deno.test("ci-duration: a run without a usable landing span is dropped", async () => {
  const now = Date.now();
  const usable = run({
    created_at: new Date(now - 10 * 60_000).toISOString(),
    run_started_at: new Date(now - 10 * 60_000).toISOString(),
    updated_at: new Date(now).toISOString(),
  });
  // A final update at or before the landing trigger, and a landing trigger that
  // does not parse. Both would otherwise reach the median as a duration of zero
  // or NaN minutes.
  const endsBeforeItLands = run({
    created_at: new Date(now).toISOString(),
    run_started_at: new Date(now).toISOString(),
    updated_at: new Date(now - 60_000).toISOString(),
  });
  const unparseableLanding = run({
    created_at: "the fourteenth of never",
    run_started_at: new Date(now - 20 * 60_000).toISOString(),
    updated_at: new Date(now).toISOString(),
  });

  const mixed = await labsCiDuration.collect(
    ctx([usable, endsBeforeItLands, unparseableLanding]),
  );
  assertEquals(mixed.value, "10m");
  assertStringIncludes(mixed.sub ?? "", "last 1 passing runs");

  const none = await labsCiDuration.collect(
    ctx([endsBeforeItLands, unparseableLanding]),
  );
  assertEquals(none.status, "unknown");
  assertEquals(none.value, "—");
});

Deno.test("recent-runs: wide, failure tip -> bad, rows link to the landing PR", async () => {
  const v = await recentRuns.collect(
    ctx([
      run({ conclusion: "failure", head_commit: { message: "oops (#42)" } }),
    ]),
  );
  assertEquals(recentRuns.wide, true);
  assertEquals(v.status, "bad");
  assertStringIncludes(v.extra ?? "", "/pull/42");
});

Deno.test("recent runs: timestamps have a UTC fallback and a viewer-local marker", async () => {
  const startedAt = "2024-01-02T17:05:00Z";
  const runsByRepo = (repo: string) =>
    repo === REPO ? [run({ run_started_at: startedAt })] : [];
  const v = await recentRuns.collect(ctx([], {}, runsByRepo));
  assertStringIncludes(
    v.extra ?? "",
    `<time class="t" datetime="${startedAt}" data-viewer-time>17:05 UTC</time>`,
  );
});

Deno.test("recent runs: duration opens every successful run for the commit", async () => {
  const sha = "a".repeat(40);
  const start = Date.parse("2026-07-21T18:00:00Z");
  const first = run({
    id: 41,
    head_sha: sha,
    run_started_at: new Date(start).toISOString(),
    updated_at: new Date(start + 185_000).toISOString(),
  });
  const second = run({
    id: 42,
    head_sha: sha,
    run_attempt: 2,
    run_started_at: new Date(start - 60_000).toISOString(),
    updated_at: new Date(start + 120_000).toISOString(),
  });
  const failed = run({ id: 43, head_sha: sha, conclusion: "failure" });
  const loom = run({ id: 44, repo: LOOM_REPO, head_sha: sha });
  const dispatched = run({
    id: 45,
    event: "workflow_dispatch",
    head_sha: sha,
  });
  const running = run({
    id: 46,
    status: "in_progress",
    conclusion: null,
    head_sha: "b".repeat(40),
    run_started_at: new Date(start - 120_000).toISOString(),
  });
  const untimed = run({
    id: 47,
    head_sha: "c".repeat(40),
    run_started_at: new Date(start - 180_000).toISOString(),
    updated_at: "not-a-timestamp",
  });
  const brief = run({
    id: 48,
    head_sha: "d".repeat(40),
    run_started_at: new Date(start - 240_000).toISOString(),
    updated_at: new Date(start - 198_000).toISOString(),
  });

  const href = commitGanttHref(first, [
    first,
    second,
    failed,
    loom,
    dispatched,
  ]);
  assert(href);
  const target = new URL(href, "http://dashboard");
  assertEquals(target.pathname, "/ci-gantt");
  assertEquals(target.searchParams.get("repo"), "labs");
  assertEquals(target.searchParams.get("sha"), sha);
  assertEquals(target.searchParams.getAll("run"), ["41:1", "42:2"]);
  assertEquals(commitGanttHref({ ...first, head_sha: "" }, [first]), null);
  assertEquals(commitGanttHref(failed, [first, failed]), null);
  const tooMany = Array.from(
    { length: 151 },
    (_, index) => run({ id: 1_000 + index, head_sha: sha }),
  );
  assertEquals(commitGanttHref(tooMany[0], tooMany), null);

  const runsByRepo = (repo: string) =>
    repo === REPO
      ? [first, second, failed, dispatched, running, untimed, brief]
      : [loom];
  const html = (await recentRuns.collect(ctx([], {}, runsByRepo))).extra ?? "";
  assertStringIncludes(
    html,
    `class="evdur" data-focus-key="gantt-41" href="${
      href.replaceAll("&", "&amp;")
    }"`,
  );
  assertStringIncludes(html, 'class="evtxt" data-focus-key="pr-title-41"');
  assertStringIncludes(
    html,
    '>3m 05s</a><a class="evarrow" data-focus-key="pr-arrow-41"',
  );
  assertStringIncludes(html, '<span class="evdur">running</span>');
  assertStringIncludes(html, '<span class="evdur">—</span>');
  assertStringIncludes(html, '>42s</a><a class="evarrow"');
});

Deno.test("tile labels: the labs/loom ci family is renamed and paired", async () => {
  const one = ctx([run({ conclusion: "success" })]);
  const labsTrust = await labsCiTrust.collect(one);
  const loomTrust = await loomCiTrust.collect(one);
  assertEquals((await labsCi.collect(one)).label, "labs ci");
  assertEquals((await loomCi.collect(one)).label, "loom ci");
  assertEquals(labsTrust.label, "labs ci trust");
  assertEquals(loomTrust.label, "loom ci trust");
  assertEquals(labsTrust.alignChartBottom, true);
  assertEquals(loomTrust.alignChartBottom, true);
  assertEquals((await labsCiDuration.collect(one)).label, "labs ci duration");
  assertEquals((await loomCiDuration.collect(one)).label, "loom ci duration");
});

Deno.test("runSource creates workflow snapshot metadata", () => {
  assertEquals(runSource(REPO, CI_WORKFLOW), {
    repo: REPO,
    workflow: CI_WORKFLOW,
  });
});

Deno.test("CI tiles declare the workflow snapshots that drive them", () => {
  const labsSource = [{ repo: REPO, workflow: CI_WORKFLOW }];
  const loomSource = [{ repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW }];
  for (const tile of [labsCi, labsCiTrust, labsCiDuration]) {
    assertEquals(tile.runSources, labsSource);
  }
  for (const tile of [loomCi, loomCiTrust, loomCiDuration]) {
    assertEquals(tile.runSources, loomSource);
  }
  assertEquals(recentRuns.runSources, [...labsSource, ...loomSource]);
});

Deno.test("labs ci: an in-flight build renders at the bottom (extra), not the header (aside)", async () => {
  const runs = [
    run({ status: "in_progress", conclusion: null, display_title: "wip" }),
    run({ conclusion: "success" }),
  ];
  const v = await labsCi.collect(ctx(runs));
  assertStringIncludes(v.extra ?? "", "next build running");
  assert(
    !(v.aside ?? "").includes("next build running"),
    "the badge is no longer in the header aside",
  );
});

Deno.test("recent runs: labs and loom runs interleave chronologically, each tagged", async () => {
  const now = Date.now();
  const mk = (repo: string, minsAgo: number, msg: string) =>
    run({
      repo,
      run_started_at: new Date(now - minsAgo * 60_000).toISOString(),
      head_commit: { message: msg },
    });
  const byRepo = (repo: string) =>
    repo === LOOM_REPO
      ? [mk(LOOM_REPO, 10, "loom c (#7)"), mk(LOOM_REPO, 30, "loom b (#6)")]
      : [mk(REPO, 5, "labs c (#3)"), mk(REPO, 20, "labs a (#2)")];
  const v = await recentRuns.collect(ctx([], {}, byRepo));
  // Newest-first interleave across repos: labs 5m, loom 10m, labs 20m, loom 30m.
  const order = [
    ...(v.extra ?? "").matchAll(
      /class="evtxt" data-focus-key="pr-title-\d+" href="[^"]*\/pull\/(\d+)/g,
    ),
  ]
    .map((match) => match[1]);
  assertEquals(order, ["3", "7", "2", "6"]);
  assertStringIncludes(v.extra ?? "", "labs · ");
  assertStringIncludes(v.extra ?? "", "loom · ");
});

Deno.test("dau: distinct identities per UTC day, excluding the DIDs we name", () => {
  const D = 86_400_000;
  const ser = (did: string, pts: [number, number][]) => ({
    labels: [{ key: { name: "user.did" }, value: did }],
    values: pts.map(([timestamp, value]) => ({ timestamp, value })),
  });
  const day1 = 1_783_641_600_000, day2 = day1 + D;
  const series = [
    ser("did:key:alice", [[day1, 998], [day2, 3184]]),
    ser("did:key:bob", [[day2, 12]]),
    ser("did:key:server", [[day1, 500], [day2, 500]]), // a service principal
  ];
  const all = foldSeries(series, new Set());
  assertEquals(all.get(day1)?.size, 2);
  assertEquals(all.get(day2)?.size, 3);
  // Naming the service principal takes it out of every day it appears in.
  const human = foldSeries(series, new Set(["did:key:server"]));
  assertEquals(human.get(day1)?.size, 1);
  assertEquals(human.get(day2)?.size, 2);
  // A bucket carrying no spans for an identity is not that identity being active.
  assertEquals(
    foldSeries([ser("did:key:alice", [[day1, 0]])], new Set()).size,
    0,
  );
});

Deno.test("dau: the exclusion list is read defensively", () => {
  assertEquals([...parseExcludes("did:key:a, did:key:b ,, ")], [
    "did:key:a",
    "did:key:b",
  ]);
  assertEquals(parseExcludes(undefined).size, 0);
  assertEquals(parseExcludes("").size, 0);
});

Deno.test("gated tiles gray out cleanly without their env", async () => {
  const cases = [
    [discordOnline, "DISCORD_BOT_TOKEN"],
    [gcpSpend, "GCP_BILLING_TABLE"],
    [prodErrors, "SIGNOZ_URL"],
    [githubCiSpend, "GH_TOKEN"],
    [modelSpend, "OPENAI_ADMIN_KEY"],
    [benchmark, "GH_TOKEN"],
    [dau, "SIGNOZ_URL"],
    [githubMembers, "GH_TOKEN"],
    [coverageDebt, "GH_TOKEN"],
  ] as const;
  for (const [tile, needle] of cases) {
    const v = await tile.collect(ctx([]));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", needle);
  }
});

Deno.test("discord snapshot: splits online members into Team and Visitors", () => {
  const guild = {
    id: "g",
    roles: [
      { id: "team", name: "Team", color: 0x2ecc71, position: 5 },
      { id: "g", name: "@everyone", color: 0, position: 0 },
    ],
    members: [
      { user: { id: "a" }, roles: ["team"] },
      { user: { id: "b" }, roles: [] },
      { user: { id: "c" }, roles: ["team"] }, // offline, excluded
      { user: { id: "d" }, roles: ["team"] },
    ],
    presences: [
      { user: { id: "a" }, status: "online" },
      { user: { id: "b" }, status: "idle" },
      { user: { id: "c" }, status: "offline" },
      { user: { id: "d" }, status: "dnd" },
    ],
  };
  const snap = buildSnapshot(guild);
  assert(snap);
  assertEquals(snap.online, 3); // a, b, d (c is offline)
  assertEquals(snap.team, 2); // a, d carry the role and are online
  assertEquals(snap.visitors, 1); // b
  assertEquals(snap.teamColor, "#2ecc71"); // the role's own color
});

Deno.test("projectMonthly: >=2-week (or month-to-date) window, spilling into last month", () => {
  const lastMonth = Array.from({ length: 30 }, () => 100); // $100/day last month
  // >= 2 weeks of data this month -> pure month-to-date rate, last month ignored.
  //   $2000 over 20 days, 30-day month -> $3000.
  assertEquals(projectMonthly(2000, 20, 30, lastMonth), 3000);
  // < 2 weeks -> 14-day window = 6 days this month + last 8 of last month.
  //   window = 1200 + 8*100 = 2000 over 14 days -> (2000/14)*30.
  assert(
    Math.abs(projectMonthly(1200, 6, 30, lastMonth) - (2000 / 14) * 30) < 1e-6,
  );
  // No data this month yet -> window is the last 14 days of last month.
  assertEquals(projectMonthly(0, 0, 31, lastMonth), 100 * 31);
  // No data anywhere -> falls back to mtd.
  assertEquals(projectMonthly(0, 0, 31, []), 0);
});

Deno.test("settled: a day is known once it has a figure, or once billing has had time", () => {
  const L = GITHUB_LAG_DAYS; // 2
  // Day 15 of the month. Spend every day through the 15th: the last two days have
  // figures, so they are known despite being inside the lag.
  assertEquals(
    settled(Array.from({ length: 31 }, (_, i) => (i < 15 ? 10 : 0)), 15, L)
      .length,
    15,
  );
  // Nothing since the 5th. The days that carried spend stop at 5, but by the 15th
  // billing has settled everything up to the 13th, so those quiet days are known.
  assertEquals(
    settled(Array.from({ length: 31 }, (_, i) => (i < 5 ? 10 : 0)), 15, L)
      .length,
    13,
  );
  // The window keeps growing as the month goes on rather than stalling at 5.
  assertEquals(
    settled(Array.from({ length: 31 }, (_, i) => (i < 5 ? 10 : 0)), 31, L)
      .length,
    29,
  );
  // Nothing at all this month: still only what billing has settled.
  assertEquals(settled(new Array(31).fill(0), 15, L).length, 13);
  // Day 1: nothing is settled yet and nothing has a figure.
  assertEquals(settled(new Array(31).fill(0), 1, L).length, 0);
  // A completed prior month, seen from part-way through the next one, is all known.
  assertEquals(settled(new Array(30).fill(0), 30 + 15, L).length, 30);
  // ...except at the very start of the next month, where its tail has not settled.
  assertEquals(settled(new Array(30).fill(0), 30 + 1, L).length, 29);
  assertEquals(settled([], 15, L).length, 0);
});

Deno.test("projectMonthly: the window keeps up with the calendar once spend stops", () => {
  // The real shape that started this: $1.01 across a fortnight, a penny on the 1st
  // and a dollar on the 14th, nothing else, no prior month.
  const month = new Array(31).fill(0);
  month[0] = 0.01;
  month[13] = 1.0;
  const rate = (day: number) => {
    const covered = settled(month, day, 1).length;
    return projectMonthly(1.01, covered, 31, []);
  };
  // On the 15th the fortnight is rated over 14 days, not over the 2 that spent.
  assert(Math.abs(rate(15) - (1.01 / 14) * 31) < 1e-6);
  // Counting only the days that spent would rate it over 2 and project ~7x higher.
  assert(projectMonthly(1.01, 2, 31, []) / rate(15) > 6);
  // By the end of the month the projection has converged on what was actually spent,
  // instead of stalling at the 14th and claiming double.
  assert(
    rate(31) < 1.15,
    `end-of-month projection should approach $1.01, got ${rate(31)}`,
  );
  assert(rate(31) < rate(15), "the rate falls as quiet days accumulate");
  // The same money landing early is rated over the same elapsed fortnight, not over
  // the two days at the start of it.
  const early = new Array(31).fill(0);
  early[0] = 0.01;
  early[1] = 1.0;
  assertEquals(settled(early, 15, 1).length, 14);
});

Deno.test("projectMonthly: a borrowed tail is settled before it is borrowed", () => {
  // Early in a month the borrowed days are last month's tail, the part most likely
  // not to have settled. Taking those zeros as real quiet days rates the window near
  // zero and projects far under the truth.
  const steady = Array.from({ length: 30 }, () => 10); // $10/day last month
  const truth = 310; // day 3 of a 31-day month, $30 spent at the same $10/day
  assertEquals(projectMonthly(30, 3, 31, steady), truth);
  // On the 1st, with a 2-day lag, last month's final day is not known yet.
  const unsettledTail = [...steady.slice(0, 29), 0];
  assertEquals(settled(unsettledTail, 30 + 1, GITHUB_LAG_DAYS).length, 29);
  assertEquals(
    projectMonthly(30, 3, 31, settled(unsettledTail, 30 + 1, GITHUB_LAG_DAYS)),
    truth,
  );
  // Borrowed raw, that one zero drags the rate down.
  assert(
    projectMonthly(30, 3, 31, unsettledTail) < truth,
    "an unsettled tail under-projects",
  );
  // A prior month with no data at all borrows nothing rather than a month of zeros.
  assertEquals(
    settled(new Array(30).fill(0), 30 + 1, GITHUB_LAG_DAYS).length,
    29,
  );
  // But by mid-month a genuinely quiet prior month is known, and counts as quiet.
  assertEquals(
    settled(new Array(30).fill(0), 30 + 15, GITHUB_LAG_DAYS).length,
    30,
  );
});

Deno.test("benchmark: trend classification — flat/down good, up warn, steep up bad", () => {
  const t = (v: number[]) => v.map((_, i) => i * 86_400_000); // one sample per day
  const st = (v: number[]) => trendStatus(trendPct(t(v), v));
  assertEquals(st([100, 101, 99, 100, 100, 101, 99, 100]), "good"); // flat
  assertEquals(st([130, 125, 120, 115, 110, 105, 100]), "good"); // falling
  assertEquals(st([100, 102, 104, 106, 108, 110, 112]), "warn"); // ~12% rise
  assertEquals(st([100, 120, 140, 160, 180, 200, 240]), "bad"); // steep rise
});

Deno.test("benchmark: fewer than a week of days claims no trend", () => {
  const t = (v: number[]) => v.map((_, i) => i * 86_400_000);
  // A big jump, but only three days of data -> reported flat (too little to judge).
  assertEquals(trendPct(t([100, 500, 2000]), [100, 500, 2000]), 0);
});

Deno.test("benchmark: the trend ignores a lone spike", () => {
  const flat = [100, 100, 100, 100, 100, 100, 100, 100];
  const spiked = [...flat];
  spiked[3] = 400; // a 4x outlier — a median level does not move to meet it
  const times = flat.map((_, i) => i * 86_400_000);
  assertEquals(trendStatus(trendPct(times, spiked)), "good");
});

Deno.test("benchmark: formatNs picks a readable unit", () => {
  assertEquals(formatNs(500), "500ns");
  assertEquals(formatNs(1500), "1.5µs");
  assertEquals(formatNs(2_000_000), "2.0ms");
  assertEquals(formatNs(50_000_000), "50ms");
  assertEquals(formatNs(NaN), "—");
});

Deno.test("registry: unique ids and positive intervals", () => {
  const ids = TILES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length, "tile ids must be unique");
  for (const t of TILES) {
    assert(t.intervalMs > 0, `${t.id} needs a positive intervalMs`);
  }
});

Deno.test("every tile's drill-down link reaches a route the dashboard serves", () => {
  // An unrecognized path falls through to the dashboard itself, so a tile
  // linking at a page nobody serves lands the viewer back where they started.
  const served = new Set(
    TILES.flatMap((tile) => tile.routes ?? []).map((route) => route.path),
  );
  for (const { id, view } of TILE_LAYOUT_FIXTURES) {
    if (view.href === undefined || /^https?:/.test(view.href)) continue;
    const path = new URL(view.href, "http://dashboard").pathname;
    assert(
      served.has(path),
      `${id} links to ${path}, which no registered tile serves`,
    );
  }
});

Deno.test("layout fixtures cover every registered tile in registry order", () => {
  assertEquals(
    TILE_LAYOUT_FIXTURES.map(({ id }) => id),
    TILES.map(({ id }) => id),
  );
  assertEquals(
    TILE_LAYOUT_FIXTURES.filter(({ wide }) => wide).map(({ id }) => id),
    TILES.filter(({ wide }) => wide).map(({ id }) => id),
  );
});
