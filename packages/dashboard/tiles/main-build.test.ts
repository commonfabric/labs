/**
 * The main-build tile's streak: how long the tip conclusion has held on main.
 * Canned runs, no network. See tiles.test.ts for the rest of this tile's contract.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { LOOM_REPO, REPO } from "../config.ts";
import type { Ctx, Run } from "../types.ts";
import { labsCi, loomCi } from "./main-build.ts";
import { byUrl, withGithubAttempt } from "../test/github-attempts.ts";

function ctx(runs: Run[]): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: () => Promise.resolve(runs),
    env: () => undefined,
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

// Runs arrive newest-first, and the tile ages the streak off Date.now().
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

function attemptUrl(repo: string, id: number, attempt: number): string {
  return `https://api.github.com/repos/${repo}/actions/runs/${id}/attempts/${attempt}`;
}

function jobsUrl(repo: string, id: number, attempt: number): string {
  return `${attemptUrl(repo, id, attempt)}/jobs?per_page=1`;
}

Deno.test("labs and loom ci: an active rerun retains its last completed failure", async () => {
  const cases = [
    { tile: labsCi, repo: REPO, id: 41 },
    { tile: loomCi, repo: LOOM_REPO, id: 42 },
  ];
  for (const { tile, repo, id } of cases) {
    const active = run({
      id,
      status: "in_progress",
      conclusion: null,
      run_attempt: 2,
      head_sha: "latest",
      display_title: "retry the failed build",
      run_started_at: ago(5),
    });
    const failure = run({
      id,
      conclusion: "failure",
      run_attempt: 1,
      head_sha: "latest",
      run_started_at: ago(30),
    });
    const olderSuccess = run({
      id: id + 100,
      conclusion: "success",
      head_sha: "older",
      run_started_at: ago(90),
    });

    await withGithubAttempt(failure, async (urls) => {
      const first = await tile.collect(ctx([active, olderSuccess]));
      const second = await tile.collect(ctx([active, olderSuccess]));
      assertEquals(first.status, "bad");
      assertEquals(first.value, "failure");
      assertStringIncludes(first.extra ?? "", "build rerunning");
      assertEquals(second.status, "bad");
      assertEquals(urls, [
        `https://api.github.com/repos/${repo}/actions/runs/${id}/attempts/1`,
      ]);
    });
  }
});

Deno.test("labs ci: an active rerun retains a success over an older failure", async () => {
  const id = 43;
  const active = run({
    id,
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
    head_sha: "latest",
    display_title: "verify the passing build",
    run_started_at: ago(5),
  });
  const success = run({
    id,
    conclusion: "success",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderFailure = run({
    id: 143,
    conclusion: "failure",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(success, async () => {
    const view = await labsCi.collect(ctx([active, olderFailure]));
    assertEquals(view.status, "good");
    assertEquals(view.value, "passing");
    assertStringIncludes(view.extra ?? "", "build rerunning");
  });
});

Deno.test("labs ci: a newer build does not hide the completed attempt of an older rerun", async () => {
  const cases = [
    {
      runId: 44,
      newRunId: 45,
      conclusion: "failure",
      olderConclusion: "success",
      status: "bad",
      value: "failure",
    },
    {
      runId: 46,
      newRunId: 47,
      conclusion: "success",
      olderConclusion: "failure",
      status: "good",
      value: "passing",
    },
  ] as const;

  for (
    const {
      runId,
      newRunId,
      conclusion,
      olderConclusion,
      status,
      value,
    } of cases
  ) {
    const newBuild = run({
      id: newRunId,
      status: "in_progress",
      conclusion: null,
      run_attempt: 1,
      run_started_at: ago(2),
    });
    const activeRerun = run({
      id: runId,
      status: "in_progress",
      conclusion: null,
      run_attempt: 2,
      run_started_at: ago(5),
    });
    const completedAttempt = run({
      id: runId,
      conclusion,
      run_attempt: 1,
      run_started_at: ago(30),
    });
    const older = run({
      id: runId + 100,
      conclusion: olderConclusion,
      run_started_at: ago(90),
    });

    await withGithubAttempt(completedAttempt, async (urls) => {
      const view = await labsCi.collect(
        ctx([newBuild, activeRerun, older]),
      );
      assertEquals(view.status, status);
      assertEquals(view.value, value);
      assertStringIncludes(view.extra ?? "", "next build running");
      assertEquals(urls, [
        `https://api.github.com/repos/${REPO}/actions/runs/${runId}/attempts/1`,
      ]);
    });
  }
});

Deno.test("labs ci: an observed failure survives a rerun without another API result", async () => {
  const id = 51;
  const failure = run({
    id,
    conclusion: "failure",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderSuccess = run({
    id: 151,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });
  assertEquals(
    (await labsCi.collect(ctx([failure, olderSuccess]))).status,
    "bad",
  );

  await withGithubAttempt(
    new Error("attempt endpoint unavailable"),
    async (urls) => {
      const active = run({
        id,
        status: "in_progress",
        conclusion: null,
        run_attempt: 2,
        head_sha: "latest",
        display_title: "retry the failed build",
        run_started_at: ago(5),
      });
      const view = await labsCi.collect(ctx([active, olderSuccess]));
      assertEquals(view.status, "bad");
      assertEquals(view.value, "failure");
      assertStringIncludes(view.extra ?? "", "build rerunning");
      assertEquals(urls, []);
    },
  );
});

Deno.test("labs ci: a malformed required attempt is rejected", async (t) => {
  const cases: { name: string; overrides: Partial<Run> }[] = [
    { name: "wrong run id", overrides: { id: 999 } },
    { name: "wrong attempt", overrides: { run_attempt: 2 } },
    { name: "unfinished status", overrides: { status: "in_progress" } },
    { name: "missing conclusion", overrides: { conclusion: null } },
  ];

  for (const [index, { name, overrides }] of cases.entries()) {
    await t.step(name, async () => {
      const id = 600 + index;
      const active = run({
        id,
        status: "in_progress",
        conclusion: null,
        run_attempt: 2,
        head_sha: "latest",
        run_started_at: ago(5),
      });
      const malformed = run({
        id,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        head_sha: "latest",
        run_started_at: ago(30),
        ...overrides,
      });
      const olderSuccess = run({
        id: 1600 + index,
        conclusion: "success",
        head_sha: "older",
        run_started_at: ago(90),
      });

      await withGithubAttempt(malformed, async (urls) => {
        await assertRejects(
          () => labsCi.collect(ctx([active, olderSuccess])),
          Error,
          `GitHub run ${id} attempt 1 did not include a completed conclusion`,
        );
        assertEquals(urls, [
          `https://api.github.com/repos/${REPO}/actions/runs/${id}/attempts/1`,
        ]);
      });
    });
  }
});

Deno.test("labs ci: a repeated failure keeps the streak from the prior attempt", async () => {
  const id = 52;
  const firstAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderSuccess = run({
    id: 152,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });
  assertEquals(
    (await labsCi.collect(ctx([firstAttempt, olderSuccess]))).sub,
    "failure for 30m",
  );

  const secondAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const view = await labsCi.collect(ctx([secondAttempt, olderSuccess]));
  assertEquals(view.status, "bad");
  assertEquals(view.sub, "failure for 30m");
});

Deno.test("labs ci: a new build preserves the prior run's attempt history", async () => {
  const id = 55;
  const firstAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 1,
    head_sha: "previous",
    run_started_at: ago(60),
  });
  const olderSuccess = run({
    id: 155,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(120),
  });
  await labsCi.collect(ctx([firstAttempt, olderSuccess]));

  const secondAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 2,
    head_sha: "previous",
    run_started_at: ago(30),
  });
  assertEquals(
    (await labsCi.collect(ctx([secondAttempt, olderSuccess]))).sub,
    "failure for 1h 0m",
  );

  const newBuild = run({
    id: 56,
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const view = await labsCi.collect(
    ctx([newBuild, secondAttempt, olderSuccess]),
  );
  assertEquals(view.status, "bad");
  assertEquals(view.sub, "failure for 1h 0m");
  assertStringIncludes(view.extra ?? "", "next build running");
});

Deno.test("labs ci: a cold completed rerun backfills its prior result", async () => {
  const secondAttempt = run({
    id: 57,
    conclusion: "success",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const firstAttempt = run({
    id: 57,
    conclusion: "failure",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderSuccess = run({
    id: 157,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(firstAttempt, async (urls) => {
    const view = await labsCi.collect(ctx([secondAttempt, olderSuccess]));
    assertEquals(view.status, "good");
    assertEquals(view.sub, "green for 5m");
    assertEquals(urls, [
      `https://api.github.com/repos/${REPO}/actions/runs/57/attempts/1`,
    ]);
  });
});

Deno.test("labs ci: an unavailable optional attempt preserves the known verdict", async () => {
  const id = 61;
  const secondAttempt = run({
    id,
    conclusion: "success",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const olderSuccess = run({
    id: 161,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(
    new Error("attempt endpoint unavailable"),
    async (urls) => {
      const view = await labsCi.collect(
        ctx([secondAttempt, olderSuccess]),
      );
      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
      assertEquals(view.sub, "green for 5m");
      assertEquals(urls, [
        `https://api.github.com/repos/${REPO}/actions/runs/${id}/attempts/1`,
      ]);
    },
  );
});

Deno.test("labs ci: a missed attempt breaks the cached streak", async () => {
  const id = 58;
  const firstAttempt = run({
    id,
    conclusion: "success",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(90),
  });
  const olderFailure = run({
    id: 158,
    conclusion: "failure",
    head_sha: "older",
    run_started_at: ago(180),
  });
  assertEquals(
    (await labsCi.collect(ctx([firstAttempt, olderFailure]))).sub,
    "green for 1h 30m",
  );

  const thirdAttempt = run({
    id,
    conclusion: "success",
    run_attempt: 3,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const secondAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  await withGithubAttempt(secondAttempt, async (urls) => {
    const view = await labsCi.collect(ctx([thirdAttempt, olderFailure]));
    assertEquals(view.status, "good");
    assertEquals(view.sub, "green for 5m");
    assertEquals(urls, [
      `https://api.github.com/repos/${REPO}/actions/runs/${id}/attempts/2`,
    ]);
  });
});

Deno.test("labs ci: a cold third attempt reconstructs its completed failure streak", async () => {
  const id = 59;
  const active = run({
    id,
    status: "in_progress",
    conclusion: null,
    run_attempt: 3,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const secondAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const firstAttempt = run({
    id,
    conclusion: "failure",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(60),
  });
  const olderSuccess = run({
    id: 159,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(120),
  });

  await withGithubAttempt(
    (url) => url.endsWith("/attempts/2") ? secondAttempt : firstAttempt,
    async (urls) => {
      const view = await labsCi.collect(ctx([active, olderSuccess]));
      assertEquals(view.status, "bad");
      assertEquals(view.value, "failure");
      assertEquals(view.sub, "failure for 1h 0m");
      assertStringIncludes(view.extra ?? "", "build rerunning");
      assertEquals(urls, [
        `https://api.github.com/repos/${REPO}/actions/runs/${id}/attempts/2`,
        `https://api.github.com/repos/${REPO}/actions/runs/${id}/attempts/1`,
      ]);
    },
  );
});

Deno.test("labs ci streak: measured from the flip, not from the oldest run in the window", async () => {
  const runs = [
    run({ conclusion: "success", run_started_at: ago(30) }),
    run({ conclusion: "success", run_started_at: ago(125) }), // the oldest green of this streak
    run({ conclusion: "failure", run_started_at: ago(300) }), // the red before it — outside the streak
  ];
  const v = await labsCi.collect(ctx(runs));
  assertEquals(v.status, "good");
  // Green since the 125-minute-old run. Reaching past the failure would say "5h 0m".
  assertEquals(v.sub, "green for 2h 5m");
});

Deno.test("labs ci streak: a red streak is named by its raw conclusion", async () => {
  const runs = [
    run({ conclusion: "timed_out", run_started_at: ago(20) }),
    run({ conclusion: "timed_out", run_started_at: ago(45) }),
    run({ conclusion: "success", run_started_at: ago(200) }),
  ];
  const v = await labsCi.collect(ctx(runs));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "timed_out");
  assertEquals(v.sub, "timed_out for 45m");
});

Deno.test("labs ci streak: in-flight runs neither start nor break a streak", async () => {
  const runs = [
    run({ status: "in_progress", conclusion: null, run_started_at: ago(5) }),
    run({ conclusion: "success", run_started_at: ago(70) }),
  ];
  const v = await labsCi.collect(ctx(runs));
  // The unfinished run is not a verdict, so the last completed green still stands.
  assertEquals(v.status, "good");
  assertEquals(v.sub, "green for 1h 10m");
});

Deno.test("labs and loom ci streak: cancelled runs that never started neither set the verdict nor break a streak", async () => {
  const cases = [
    { tile: labsCi, repo: REPO },
    { tile: loomCi, repo: LOOM_REPO },
  ];
  for (const { tile, repo } of cases) {
    const newerCancelled = run({
      conclusion: "cancelled",
      run_started_at: ago(10),
    });
    const innerCancelled = run({
      conclusion: "cancelled",
      run_started_at: ago(50),
    });
    const runs = [
      run({ status: "in_progress", conclusion: null, run_started_at: ago(5) }),
      newerCancelled,
      run({ conclusion: "success", run_started_at: ago(30) }),
      innerCancelled,
      run({ conclusion: "success", run_started_at: ago(70) }),
      run({ conclusion: "failure", run_started_at: ago(200) }),
    ];
    const jobs = [newerCancelled, innerCancelled].map((cancelled) =>
      jobsUrl(repo, cancelled.id, 1)
    );

    await withGithubAttempt(
      byUrl(jobs.map((url) => [url, { total_count: 0 }])),
      async (urls) => {
        const v = await tile.collect(ctx(runs));
        assertEquals(v.status, "good");
        assertEquals(v.value, "passing");
        assertEquals(v.sub, "green for 1h 10m");
        assertStringIncludes(v.extra ?? "", "next build running");
        assertEquals(urls, jobs);
      },
    );
  }
});

Deno.test("labs and loom ci: a cancelled run that ran jobs is the verdict and ends a green streak", async () => {
  const cases = [
    { tile: labsCi, repo: REPO },
    { tile: loomCi, repo: LOOM_REPO },
  ];
  for (const { tile, repo } of cases) {
    const timedOut = run({ conclusion: "cancelled", run_started_at: ago(10) });
    const stopped = run({ conclusion: "cancelled", run_started_at: ago(50) });

    await withGithubAttempt(
      byUrl([
        [jobsUrl(repo, timedOut.id, 1), { total_count: 38 }],
        [jobsUrl(repo, stopped.id, 1), { total_count: 38 }],
      ]),
      async () => {
        const verdict = await tile.collect(ctx([
          timedOut,
          run({ conclusion: "success", run_started_at: ago(30) }),
        ]));
        assertEquals(verdict.status, "bad");
        assertEquals(verdict.value, "cancelled");
        assertEquals(verdict.sub, "cancelled for 10m");

        const streak = await tile.collect(ctx([
          run({ conclusion: "success", run_started_at: ago(20) }),
          stopped,
          run({ conclusion: "success", run_started_at: ago(90) }),
        ]));
        assertEquals(streak.status, "good");
        assertEquals(streak.sub, "green for 20m");
      },
    );
  }
});

Deno.test("labs ci streak: between failures, a cancelled run that never started does not end the red streak", async () => {
  const cancelled = run({ conclusion: "cancelled", run_started_at: ago(20) });
  const runs = [
    run({ conclusion: "failure", run_started_at: ago(10) }),
    cancelled,
    run({ conclusion: "failure", run_started_at: ago(40) }),
    run({ conclusion: "success", run_started_at: ago(100) }),
  ];

  await withGithubAttempt({ total_count: 0 }, async (urls) => {
    const v = await labsCi.collect(ctx(runs));
    assertEquals(v.status, "bad");
    assertEquals(v.value, "failure");
    assertEquals(v.sub, "failure for 40m");
    assertEquals(urls, [jobsUrl(REPO, cancelled.id, 1)]);
  });
});

Deno.test("labs ci: a cancelled rerun that never started yields to its prior completed attempt", async () => {
  const id = 70;
  const cancelledRerun = run({
    id,
    conclusion: "cancelled",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const firstAttempt = run({
    id,
    conclusion: "success",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderFailure = run({
    id: 170,
    conclusion: "failure",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(
    byUrl([
      [jobsUrl(REPO, id, 2), { total_count: 0 }],
      [attemptUrl(REPO, id, 1), firstAttempt],
    ]),
    async (urls) => {
      const view = await labsCi.collect(ctx([cancelledRerun, olderFailure]));
      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
      assertEquals(view.sub, "green for 30m");
      assertEquals(urls, [jobsUrl(REPO, id, 2), attemptUrl(REPO, id, 1)]);
    },
  );
});

Deno.test("labs ci: a cancelled rerun that ran jobs is the verdict over its prior attempt", async () => {
  const id = 71;
  const cancelledRerun = run({
    id,
    conclusion: "cancelled",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const firstAttempt = run({
    id,
    conclusion: "success",
    run_attempt: 1,
    head_sha: "latest",
    run_started_at: ago(30),
  });
  const olderSuccess = run({
    id: 171,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(
    byUrl([
      [jobsUrl(REPO, id, 2), { total_count: 12 }],
      [attemptUrl(REPO, id, 1), firstAttempt],
    ]),
    async (urls) => {
      const view = await labsCi.collect(ctx([cancelledRerun, olderSuccess]));
      assertEquals(view.status, "bad");
      assertEquals(view.value, "cancelled");
      assertEquals(view.sub, "cancelled for 5m");
      assertEquals(urls, [jobsUrl(REPO, id, 2), attemptUrl(REPO, id, 1)]);
    },
  );
});

Deno.test("labs ci: an unreadable attempt after only cancelled runs that never started rejects the collection", async () => {
  const id = 72;
  const cancelledRerun = run({
    id,
    conclusion: "cancelled",
    run_attempt: 2,
    head_sha: "latest",
    run_started_at: ago(5),
  });
  const olderSuccess = run({
    id: 172,
    conclusion: "success",
    head_sha: "older",
    run_started_at: ago(90),
  });

  await withGithubAttempt(
    byUrl([
      [jobsUrl(REPO, id, 2), { total_count: 0 }],
      [attemptUrl(REPO, id, 1), new Error("attempt endpoint unavailable")],
    ]),
    async (urls) => {
      await assertRejects(
        () => labsCi.collect(ctx([cancelledRerun, olderSuccess])),
        Error,
        "attempt endpoint unavailable",
      );
      assertEquals(urls, [jobsUrl(REPO, id, 2), attemptUrl(REPO, id, 1)]);
    },
  );
});

Deno.test("labs ci: an unreadable job count rejects a collection with no verdict yet, and otherwise ends the streak", async () => {
  const unavailable = new Error("job listing unavailable");
  const newestCancelled = run({
    conclusion: "cancelled",
    run_started_at: ago(5),
  });
  await withGithubAttempt(unavailable, async (urls) => {
    await assertRejects(
      () =>
        labsCi.collect(ctx([
          newestCancelled,
          run({ conclusion: "success", run_started_at: ago(30) }),
        ])),
      Error,
      "job listing unavailable",
    );
    assertEquals(urls, [jobsUrl(REPO, newestCancelled.id, 1)]);
  });

  const olderCancelled = run({
    conclusion: "cancelled",
    run_started_at: ago(20),
  });
  await withGithubAttempt(unavailable, async (urls) => {
    const view = await labsCi.collect(ctx([
      run({ conclusion: "success", run_started_at: ago(5) }),
      olderCancelled,
      run({ conclusion: "success", run_started_at: ago(90) }),
    ]));
    assertEquals(view.status, "good");
    assertEquals(view.sub, "green for 5m");
    assertEquals(urls, [jobsUrl(REPO, olderCancelled.id, 1)]);
  });
});

Deno.test("labs ci: the job count of a cancelled attempt is requested once, and no other attempt's is", async () => {
  const neverStarted = run({
    conclusion: "cancelled",
    run_started_at: ago(10),
  });
  const stopped = run({ conclusion: "cancelled", run_started_at: ago(40) });
  const runs = [
    run({ conclusion: "success", run_started_at: ago(5) }),
    neverStarted,
    run({ conclusion: "success", run_started_at: ago(20) }),
    stopped,
    run({ conclusion: "failure", run_started_at: ago(60) }),
  ];
  const jobs = [
    jobsUrl(REPO, neverStarted.id, 1),
    jobsUrl(REPO, stopped.id, 1),
  ];

  await withGithubAttempt(
    byUrl([[jobs[0], { total_count: 0 }], [jobs[1], { total_count: 3 }]]),
    async (urls) => {
      for (let collection = 0; collection < 2; collection++) {
        const view = await labsCi.collect(ctx(runs));
        assertEquals(view.status, "good");
        assertEquals(view.sub, "green for 20m");
      }
      assertEquals(urls, jobs);
    },
  );
});

Deno.test("labs ci: no completed runs -> unknown, and no streak claimed", async () => {
  const v = await labsCi.collect(ctx([run({ status: "queued", conclusion: null })]));
  assertEquals(v.status, "unknown");
  assertEquals(v.sub, "no completed runs in window");
});
