/**
 * ci: GitHub is replaced with an in-memory stand-in holding an organization of
 * repositories, the workflows in them, and the runs behind those workflows.
 * The tests cover the headline in each of its shapes, which jobs reach the
 * body, which runs the tile passes over, and the gray states.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CI_FAILURE_FRESH_HOURS,
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "../config.ts";
import { compactSpan } from "../lib.ts";
import type { Ctx } from "../types.ts";
import { createCiHealth } from "./ci-health.ts";

const ORG = REPO.split("/")[0];
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 1, 12);

function ctx(env: Record<string, string> = { GH_TOKEN: "token" }): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => env[key],
  };
}

interface WorkflowSpec {
  name: string;
  file: string;
  state?: string;
  runs?: RunSpec[];
  // When the workflow's file last changed on the default branch. A file that
  // changed long before any of its runs leaves every verdict standing.
  fileChangedMinutesAgo?: number;
}

interface RunSpec {
  conclusion: string | null;
  event?: string;
  minutesAgo?: number;
  branch?: string;
  startedJobs?: number; // jobs the attempt listing reports, for a cancelled run
  status?: string; // "completed" unless the run is still going
  ranMinutes?: number; // how long a completed run went on before it ended
  jobsStatus?: number; // the status its job-count read answers with
}

interface RepoSpec {
  name: string;
  archived?: boolean;
  defaultBranch?: string;
  workflows?: WorkflowSpec[];
  workflowsStatus?: number;
  runsStatus?: number; // the status every run listing of this repo answers with
  commitsStatus?: number; // the status every commit listing of this repo answers with
  workflowsBody?: unknown; // what the workflow listing answers, in place of the workflows
  commitsBody?: unknown; // what every commit listing answers, in place of the history
}

// The two repositories whose main build the tile keeps in the body.
const labsCi = (runs: RunSpec[]): WorkflowSpec => ({
  name: "CI",
  file: CI_WORKFLOW,
  runs,
});
const loomCi = (runs: RunSpec[]): WorkflowSpec => ({
  name: "Tests (fast)",
  file: LOOM_CI_WORKFLOW,
  runs,
});
const green: RunSpec[] = [{ conclusion: "success", minutesAgo: 30 }];

interface Wire {
  calls: string[];
  logged: string[];
}

function workflowId(repo: string, file: string): number {
  let id = 0;
  for (const character of `${repo}/${file}`) {
    id = (id * 31 + character.charCodeAt(0)) % 100000;
  }
  return id + 1;
}

async function withGitHub(
  repos: RepoSpec[],
  body: (wire: Wire) => Promise<void>,
): Promise<void> {
  const real = { fetch: globalThis.fetch, now: Date.now, error: console.error };
  const wire: Wire = { calls: [], logged: [] };
  const byFullName = new Map<string, RepoSpec>(
    repos.map((repo) => [`${ORG}/${repo.name}`, repo]),
  );
  const startedJobsById = new Map<number, number>();
  const jobsStatusById = new Map<number, number>();
  const pages = Math.max(1, Math.ceil(repos.length / 100));

  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    wire.calls.push(url.pathname + url.search);

    if (url.pathname === `/orgs/${ORG}/repos`) {
      // One repository per page, so every test exercises the page walk.
      const page = Number(url.searchParams.get("page"));
      const listed = repos.map((repo) => ({
        full_name: `${ORG}/${repo.name}`,
        default_branch: repo.defaultBranch ?? "main",
        archived: repo.archived ?? false,
      }));
      return Promise.resolve(Response.json(
        pages === 1 ? listed : listed.slice((page - 1) * 100, page * 100),
      ));
    }

    const listing = url.pathname.match(/^\/repos\/(.+)\/actions\/workflows$/);
    if (listing) {
      const repo = byFullName.get(listing[1])!;
      if (repo.workflowsStatus !== undefined) {
        return Promise.resolve(
          new Response("no access", { status: repo.workflowsStatus }),
        );
      }
      if (repo.workflowsBody !== undefined) {
        return Promise.resolve(Response.json(repo.workflowsBody));
      }
      return Promise.resolve(Response.json({
        workflows: (repo.workflows ?? []).map((workflow) => ({
          id: workflowId(listing[1], workflow.file),
          name: workflow.name,
          path: `.github/workflows/${workflow.file}`,
          state: workflow.state ?? "active",
          html_url: `https://github.com/${listing[1]}/actions/${workflow.file}`,
        })),
      }));
    }

    const commits = url.pathname.match(/^\/repos\/(.+)\/commits$/);
    if (commits) {
      const repo = byFullName.get(commits[1])!;
      if (repo.commitsStatus !== undefined) {
        return Promise.resolve(
          new Response("no access", { status: repo.commitsStatus }),
        );
      }
      if (repo.commitsBody !== undefined) {
        return Promise.resolve(Response.json(repo.commitsBody));
      }
      const path = url.searchParams.get("path") ?? "";
      const workflow = (repo.workflows ?? []).find((candidate) =>
        path === `.github/workflows/${candidate.file}`
      )!;
      const ago = workflow.fileChangedMinutesAgo ?? 100 * 24 * 60;
      return Promise.resolve(Response.json([{
        sha: "c".repeat(40),
        commit: {
          committer: { date: new Date(T0 - ago * 60_000).toISOString() },
        },
      }]));
    }

    const jobs = url.pathname.match(
      /^\/repos\/(.+)\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/,
    );
    if (jobs) {
      const failing = jobsStatusById.get(Number(jobs[2]));
      if (failing !== undefined) {
        return Promise.resolve(new Response("unavailable", { status: failing }));
      }
      return Promise.resolve(Response.json({
        total_count: startedJobsById.get(Number(jobs[2])) ?? 0,
      }));
    }

    const runs = url.pathname.match(
      /^\/repos\/(.+)\/actions\/workflows\/(\d+)\/runs$/,
    );
    if (runs) {
      const repo = byFullName.get(runs[1])!;
      if (repo.runsStatus !== undefined) {
        return Promise.resolve(
          new Response("no access", { status: repo.runsStatus }),
        );
      }
      const workflow = (repo.workflows ?? []).find((candidate) =>
        workflowId(runs[1], candidate.file) === Number(runs[2])
      )!;
      const branch = url.searchParams.get("branch");
      // GitHub filters on a status or a conclusion before it pages.
      const wanted = url.searchParams.get("status");
      return Promise.resolve(Response.json({
        workflow_runs: (workflow.runs ?? [])
          .filter((run) => (run.branch ?? "main") === branch)
          .filter((run) =>
            wanted === null || (run.status ?? "completed") === wanted ||
            run.conclusion === wanted
          )
          .map((run, index) => ({ run, index }))
          // A page holds as many runs as it was asked for, newest first.
          .slice(
            (Number(url.searchParams.get("page") ?? 1) - 1) *
              Number(url.searchParams.get("per_page") ?? 30),
            Number(url.searchParams.get("page") ?? 1) *
              Number(url.searchParams.get("per_page") ?? 30),
          )
          .map(({ run, index }) => {
            const id = Number(runs[2]) * 100 + index;
            startedJobsById.set(id, run.startedJobs ?? 0);
            if (run.jobsStatus !== undefined) {
              jobsStatusById.set(id, run.jobsStatus);
            }
            const createdAgo = run.minutesAgo ?? 0;
            const completed = (run.status ?? "completed") === "completed";
            const endedAgo = completed
              ? Math.max(0, createdAgo - (run.ranMinutes ?? 10))
              : 0;
            return {
            id,
            status: run.status ?? "completed",
            conclusion: completed ? run.conclusion : null,
            run_attempt: 1,
            event: run.event ?? "push",
            head_sha: "sha",
            display_title: workflow.name,
            created_at: new Date(T0 - createdAgo * 60_000).toISOString(),
            run_started_at: new Date(T0 - createdAgo * 60_000).toISOString(),
            updated_at: new Date(T0 - endedAgo * 60_000).toISOString(),
            html_url: `https://github.com/${runs[1]}/actions/runs/${runs[2]}`,
            head_commit: null,
            };
          }),
      }));
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  Date.now = () => T0;
  console.error = (...args: unknown[]) => {
    wire.logged.push(args.map(String).join(" "));
  };

  try {
    await body(wire);
  } finally {
    globalThis.fetch = real.fetch;
    Date.now = real.now;
    console.error = real.error;
  }
}

const standingOrg = (
  labsRuns: RunSpec[],
  loomRuns: RunSpec[],
  extra: RepoSpec[] = [],
): RepoSpec[] => [
  { name: REPO.split("/")[1], workflows: [labsCi(labsRuns)] },
  { name: LOOM_REPO.split("/")[1], workflows: [loomCi(loomRuns)] },
  ...extra,
];

Deno.test("ci: every job passing keeps labs and loom green in the body", async () => {
  await withGitHub(standingOrg(green, green), async () => {
    const tile = createCiHealth();
    const view = await tile.collect(ctx());

    assertEquals(tile.label, "ci");
    assertEquals(view.href, "/ci");
    assertEquals(view.hint, "every job ↗");
    // The tile is itself the link, so its rows carry none of their own.
    assert(!(view.extra ?? "").includes("<a "));
    // A live update redraws the tile, and the list keeps a reader's focus and
    // scroll position across it by this key.
    assertStringIncludes(view.extra ?? "", `data-focus-key="jobs"`);
    assertEquals(view.status, "good");
    assertEquals(view.value, "passing");
    assertStringIncludes(view.aside ?? "", "2 jobs · 2 repos");
    assertStringIncludes(view.extra ?? "", `<span class="dot green"></span>labs · CI`);
    assertStringIncludes(
      view.extra ?? "",
      `<span class="dot green"></span>loom · Tests (fast)`,
    );
    assertStringIncludes(view.extra ?? "", "30m ago");
  });
});

Deno.test("ci: one failing job names its repository in the headline", async () => {
  await withGitHub(
    standingOrg(green, [{ conclusion: "failure", minutesAgo: 190 }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
      assertStringIncludes(
        view.extra ?? "",
        `<span class="dot red"></span>loom · Tests (fast)`,
      );
      assertStringIncludes(view.extra ?? "", "failure · 3h ago");
      // A red tile drops every job that is passing, labs' main build included.
      assert(!(view.extra ?? "").includes("labs · CI"));
    },
  );
});

Deno.test("ci: a failing job outside the two main builds is found and named", async () => {
  await withGitHub(
    standingOrg(green, green, [{
      name: "infra",
      workflows: [{
        name: "Terraform plan",
        file: "plan.yml",
        runs: [{ conclusion: "timed_out", minutesAgo: 60 }],
      }],
    }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "infra failing");
      assertStringIncludes(view.aside ?? "", "3 jobs · 3 repos");
      assertStringIncludes(
        view.extra ?? "",
        `<span class="dot red"></span>infra · Terraform plan`,
      );
      assertStringIncludes(view.extra ?? "", "timed_out · 1h ago");
    },
  );
});

Deno.test("ci: several failing jobs are counted and all of them listed", async () => {
  await withGitHub(
    standingOrg(
      [{ conclusion: "failure", minutesAgo: 20 }],
      [{ conclusion: "startup_failure", minutesAgo: 40 }],
      [{
        name: "bay",
        workflows: [{
          name: "Audit",
          file: "audit.yml",
          runs: [{ conclusion: "failure", minutesAgo: 90 }],
        }],
      }],
    ),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "3 failing");
      for (const name of ["labs · CI", "loom · Tests (fast)", "bay · Audit"]) {
        assertStringIncludes(view.extra ?? "", name);
      }
    },
  );
});

Deno.test("ci: a conclusion that judges nothing falls through to the run before it", async () => {
  const cases: { newest: RunSpec[]; value: string; status: string }[] = [
    {
      // A queued run a newer push replaced started no job and judged nothing.
      newest: [
        { conclusion: "cancelled", minutesAgo: 5, startedJobs: 0 },
        { conclusion: "success", minutesAgo: 65 },
      ],
      value: "passing",
      status: "good",
    },
    {
      newest: [
        { conclusion: "skipped", minutesAgo: 5 },
        { conclusion: "failure", minutesAgo: 65 },
      ],
      value: "loom failing",
      status: "bad",
    },
    {
      newest: [
        { conclusion: "success", event: "pull_request", minutesAgo: 5 },
        { conclusion: "failure", minutesAgo: 65 },
      ],
      value: "loom failing",
      status: "bad",
    },
  ];
  for (const testCase of cases) {
    await withGitHub(standingOrg(green, testCase.newest), async () => {
      const view = await createCiHealth().collect(ctx());
      assertEquals(view.status, testCase.status);
      assertEquals(view.value, testCase.value);
    });
  }
});

Deno.test("ci: a cancelled run that ran jobs is a failure, not a run to pass over", async () => {
  await withGitHub(
    standingOrg(green, [
      // A job killed by its own `timeout-minutes` concludes cancelled with a
      // job listing behind it. Reading it as a non-verdict would leave the
      // older success showing and call a timed-out build passing.
      { conclusion: "cancelled", minutesAgo: 20, startedJobs: 4 },
      { conclusion: "success", minutesAgo: 200 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
      assertStringIncludes(view.extra ?? "", "cancelled · 20m ago");
    },
  );
});

Deno.test("ci: a failure nobody has fixed in two days goes orange, still failing", async () => {
  const stale = CI_FAILURE_FRESH_HOURS * 60 + 60;
  await withGitHub(
    standingOrg(green, [{ conclusion: "failure", minutesAgo: stale }]),
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      // It is still one of the failing jobs, and still named as one, with how
      // long ago it failed.
      assertEquals(view.value, "loom failing");
      assertStringIncludes(
        view.extra ?? "",
        `failure · ${compactSpan(stale * 60_000)} ago`,
      );
      // It was read perfectly well, so nothing reports it as unreadable.
      assertEquals(
        wire.logged.filter((line) => line.startsWith("ci: could not read:")),
        [],
      );
      assertStringIncludes(
        view.extra ?? "",
        `<span class="dot amber"></span>loom · Tests (fast)`,
      );
      // The tile is not red, so the labs main build stays in the body.
      assertStringIncludes(view.extra ?? "", "labs · CI");
    },
  );
});

Deno.test("ci: one fresh failure keeps the tile red beside an older one", async () => {
  const stale = CI_FAILURE_FRESH_HOURS * 60 + 60;
  await withGitHub(
    standingOrg(
      [{ conclusion: "failure", minutesAgo: 30 }],
      [{ conclusion: "failure", minutesAgo: stale }],
    ),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "2 failing");
      assertStringIncludes(view.extra ?? "", `<span class="dot red"></span>labs`);
      assertStringIncludes(view.extra ?? "", `<span class="dot amber"></span>loom`);
    },
  );
});

Deno.test("ci: a failure an hour short of the threshold is still red", async () => {
  const fresh = CI_FAILURE_FRESH_HOURS * 60 - 60;
  await withGitHub(
    standingOrg(green, [{ conclusion: "failure", minutesAgo: fresh }]),
    async () => {
      const view = await createCiHealth().collect(ctx());
      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
    },
  );
});

Deno.test("ci: a failure made by a workflow since changed is no longer counted", async () => {
  // Someone stopped the job rather than fixed it: its file changed after the
  // failure, and nothing has run under the new definition since.
  await withGitHub(
    standingOrg(green, green, [{
      name: "crm",
      workflows: [{
        name: "Nightly export",
        file: "export.yml",
        runs: [{ conclusion: "failure", event: "schedule", minutesAgo: 180 }],
        fileChangedMinutesAgo: 60,
      }],
    }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
      assertStringIncludes(view.aside ?? "", "2 jobs · 3 repos");
      assert(!(view.extra ?? "").includes("Nightly export"));
    },
  );
});

Deno.test("ci: a job gated off after it failed stops counting, while its runs go on", async () => {
  // A daily job fails, then gains a job-level `if:` that is never true here.
  // It still runs every day, and every run concludes skipped, which passes no
  // judgment; the failure behind them came from the file before the change.
  const gated = (days: number): RunSpec[] => [
    ...Array.from({ length: days }, (_, day): RunSpec => ({
      conclusion: "skipped",
      event: "schedule",
      minutesAgo: (day + 1) * 24 * 60,
    })),
    { conclusion: "failure", event: "schedule", minutesAgo: (days + 1) * 24 * 60 },
  ];
  for (const days of [1, 5]) {
    await withGitHub(
      standingOrg(green, green, [{
        name: "gvisor",
        workflows: [{
          name: "CodeQL",
          file: "codeql.yml",
          runs: gated(days),
          fileChangedMinutesAgo: (days + 1) * 24 * 60 - 60,
        }],
      }]),
      async () => {
        const tile = createCiHealth();
        const view = await tile.collect(ctx());
        assertEquals(view.status, "good", `${days} skipped`);
        assertEquals(view.value, "passing");

        const page = await (await tile.routes![0].handler(
          new Request("http://dashboard/ci"),
          new URL("http://dashboard/ci"),
        )).text();
        // While the failure is among the runs read, it says what happened;
        // once five skipped runs have pushed it out, it says what they did.
        assertStringIncludes(
          page,
          days === 1 ? "changed since it failed" : "recent runs judged nothing",
        );
      },
    );
  }
});

Deno.test("ci: a failure made after the workflow's last change still counts", async () => {
  await withGitHub(
    [
      { name: REPO.split("/")[1], workflows: [labsCi(green)] },
      {
        name: LOOM_REPO.split("/")[1],
        workflows: [{
          ...loomCi([{ conclusion: "failure", minutesAgo: 180 }]),
          fileChangedMinutesAgo: 300,
        }],
      },
    ],
    async () => {
      const view = await createCiHealth().collect(ctx());
      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
    },
  );
});

Deno.test("ci: a pinned build changed since its failure reads gray and says why", async () => {
  await withGitHub(
    [
      { name: REPO.split("/")[1], workflows: [labsCi(green)] },
      {
        name: LOOM_REPO.split("/")[1],
        workflows: [{
          ...loomCi([{ conclusion: "failure", minutesAgo: 180 }]),
          fileChangedMinutesAgo: 60,
        }],
      },
    ],
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "good");
      assertStringIncludes(
        view.extra ?? "",
        `<span class="dot gray"></span>loom · Tests (fast)`,
      );
      assertStringIncludes(view.extra ?? "", "changed since it failed");
    },
  );
});

Deno.test("ci: a failure stands when its workflow's history cannot be read", async () => {
  await withGitHub(
    standingOrg(green, [{ conclusion: "failure", minutesAgo: 180 }]).map(
      (repo) =>
        repo.name === LOOM_REPO.split("/")[1]
          ? { ...repo, commitsStatus: 403 }
          : repo,
    ),
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
      assert(
        wire.logged.some((line) =>
          line.startsWith("ci: could not read loom · Tests (fast)'s history:")
        ),
        "the unanswered check leaves a trace",
      );
    },
  );
});

Deno.test("ci: a passing job never asks for its workflow's history", async () => {
  await withGitHub(standingOrg(green, green), async (wire) => {
    await createCiHealth().collect(ctx());
    assertEquals(wire.calls.filter((call) => call.includes("/commits?")), []);
  });
});

Deno.test("ci: a run cancelled because a newer one replaced it judges nothing", async () => {
  // gvisor's release workflow cancels in progress: a push landed 35 minutes
  // into a run, its run started, and the older run was cancelled seconds
  // later, jobs and all. Only the run before them says anything yet.
  await withGitHub(
    standingOrg(green, [
      { conclusion: null, status: "in_progress", minutesAgo: 5 },
      { conclusion: "cancelled", minutesAgo: 40, ranMinutes: 36, startedJobs: 1 },
      { conclusion: "success", minutesAgo: 6 * 24 * 60 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
    },
  );
});

Deno.test("ci: a run cancelled before any newer run began is still a failure", async () => {
  // It timed out, or somebody stopped it, and the push after it came later.
  await withGitHub(
    standingOrg(green, [
      { conclusion: null, status: "in_progress", minutesAgo: 5 },
      { conclusion: "cancelled", minutesAgo: 60, ranMinutes: 35, startedJobs: 1 },
      { conclusion: "success", minutesAgo: 6 * 24 * 60 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertEquals(view.value, "loom failing");
    },
  );
});

Deno.test("ci: a run still going is not a verdict", async () => {
  await withGitHub(
    standingOrg(green, [
      { conclusion: null, status: "in_progress", minutesAgo: 5 },
      { conclusion: "failure", minutesAgo: 60 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());
      // The newest completed run decides; the one still going says nothing.
      assertEquals(view.value, "loom failing");
    },
  );
});

Deno.test("ci: a fork's pull request from a branch named main does not crowd out the job's runs", async () => {
  // Twenty-five runs a pull request started fill more than the first page;
  // the job's own failure is behind them.
  const forkRuns = Array.from({ length: 25 }, (_, index): RunSpec => ({
    conclusion: "success",
    event: "pull_request",
    minutesAgo: index + 1,
  }));
  await withGitHub(
    standingOrg(green, [...forkRuns, { conclusion: "failure", minutesAgo: 100 }]),
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.value, "loom failing");
      const loomPages = wire.calls.filter((call) =>
        call.startsWith(`/repos/${LOOM_REPO}/actions/workflows/`) &&
        call.includes("/runs?")
      );
      assertEquals(loomPages.length, 2, "the second page holds the job's run");
      assertStringIncludes(loomPages[1], "&page=2");
    },
  );
});

Deno.test("ci: a workflow only pull requests start has no verdict and says so", async () => {
  // Its only runs on the default branch's name are a fork's pull request's.
  await withGitHub(
    standingOrg(green, green, [{
      name: "pond",
      workflows: [{
        name: "Preview deploy",
        file: "preview.yml",
        runs: [
          { conclusion: "failure", event: "pull_request", minutesAgo: 30 },
          { conclusion: "success", event: "pull_request_target", minutesAgo: 90 },
        ],
      }],
    }]),
    async () => {
      const tile = createCiHealth();
      const view = await tile.collect(ctx());
      assertEquals(view.status, "good");
      assertStringIncludes(view.aside ?? "", "2 jobs · 3 repos");

      const page = await (await tile.routes![0].handler(
        new Request("http://dashboard/ci"),
        new URL("http://dashboard/ci"),
      )).text();
      assertStringIncludes(
        page,
        `Preview deploy</a></td><td class="measure">no completed run</td>`,
      );
    },
  );
});

Deno.test("ci: runs a pull request review started are a pull request's too", async () => {
  await withGitHub(
    standingOrg(green, [
      { conclusion: "success", event: "pull_request_review", minutesAgo: 5 },
      { conclusion: "success", event: "pull_request_review_comment", minutesAgo: 10 },
      { conclusion: "failure", minutesAgo: 60 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());
      assertEquals(view.value, "loom failing");
    },
  );
});

Deno.test("ci: a red tile lists only its failing jobs", async () => {
  await withGitHub(
    standingOrg(green, [{ conclusion: "failure", minutesAgo: 30 }], [
      { name: "pond", workflowsStatus: 403 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "bad");
      assertStringIncludes(view.extra ?? "", "loom · Tests (fast)");
      // Neither the unreadable repository nor the passing labs build.
      assert(!(view.extra ?? "").includes("pond"));
      assert(!(view.extra ?? "").includes("labs · CI"));
    },
  );
});

Deno.test("ci: a workflow listing that is not a list of workflows is unreadable", async () => {
  await withGitHub(
    standingOrg(green, green, [{ name: "pond", workflowsBody: { workflows: "none" } }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      assertEquals(view.value, "1 unreadable");
      assertStringIncludes(view.extra ?? "", "pond · workflows");
    },
  );
});

Deno.test("ci: a failure stands when its workflow's history makes no sense", async () => {
  const cases: { body: unknown; logged: boolean }[] = [
    // Not a list of commits at all.
    { body: { message: "moved" }, logged: true },
    // A commit with no date the check can compare.
    { body: [{ commit: { committer: { date: "yesterday" } } }], logged: true },
    // No commit ever touched the file on this branch, so nothing redefined it.
    { body: [], logged: false },
  ];
  for (const testCase of cases) {
    await withGitHub(
      standingOrg(green, [{ conclusion: "failure", minutesAgo: 30 }]).map(
        (repo) =>
          repo.name === LOOM_REPO.split("/")[1]
            ? { ...repo, commitsBody: testCase.body }
            : repo,
      ),
      async (wire) => {
        const view = await createCiHealth().collect(ctx());

        assertEquals(view.value, "loom failing", JSON.stringify(testCase.body));
        assertEquals(
          wire.logged.some((line) =>
            line.includes("GitHub commits returned invalid data")
          ),
          testCase.logged,
          JSON.stringify(testCase.body),
        );
      },
    );
  }
});

Deno.test("ci: a cancelled run whose job count cannot be read is unreadable, not passed", async () => {
  await withGitHub(
    standingOrg(green, [
      { conclusion: "cancelled", minutesAgo: 20, jobsStatus: 500 },
      { conclusion: "success", minutesAgo: 200 },
    ]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      assertEquals(view.value, "1 unreadable");
      assertStringIncludes(view.extra ?? "", "loom · Tests (fast)");
    },
  );
});

Deno.test("ci: a repository that leaves the inventory takes its job counts with it", async () => {
  // A cancelled run's job count is held across collections. Once its
  // repository has left the inventory, the count held for it goes too, so
  // the repository's return reads its runs afresh.
  const repos = standingOrg(green, [
    { conclusion: "cancelled", minutesAgo: 20, startedJobs: 2 },
  ]);
  const loom = repos[1];
  await withGitHub(repos, async (wire) => {
    const tile = createCiHealth();
    const realNow = Date.now;
    const counts = () =>
      wire.calls.filter((call) => call.includes("/attempts/1/jobs")).length;
    try {
      await tile.collect(ctx());
      assertEquals(counts(), 1);

      repos.splice(1, 1);
      Date.now = () => T0 + HOUR + 60_000;
      await tile.collect(ctx());
      assertEquals(counts(), 1, "a repository not in the inventory is not read");

      repos.push(loom);
      Date.now = () => T0 + 2 * HOUR + 120_000;
      const view = await tile.collect(ctx());
      assertEquals(counts(), 2, "its count was read again");
      assertEquals(view.value, "loom failing");
    } finally {
      Date.now = realNow;
    }
  });
});

Deno.test("ci: a job with no run carrying a verdict is not counted as failing", async () => {
  await withGitHub(
    standingOrg(green, green, [{
      name: "specs",
      workflows: [{
        name: "Link check",
        file: "links.yml",
        runs: [{ conclusion: "cancelled", minutesAgo: 10, startedJobs: 0 }],
      }],
    }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
      // The job with no verdict is not one the headline speaks for, so the
      // count leaves it out rather than folding it into "passing".
      assertStringIncludes(view.aside ?? "", "2 jobs · 3 repos");
      assert(!(view.extra ?? "").includes("Link check"));
    },
  );
});

Deno.test("ci: archived repositories and disabled workflows are left out", async () => {
  await withGitHub(
    standingOrg(green, green, [
      {
        name: "notes",
        archived: true,
        workflows: [{
          name: "Publish",
          file: "publish.yml",
          runs: [{ conclusion: "failure", minutesAgo: 10 }],
        }],
      },
      {
        name: "crm",
        workflows: [{
          name: "Nightly",
          file: "nightly.yml",
          state: "disabled_manually",
          runs: [{ conclusion: "failure", minutesAgo: 10 }],
        }],
      },
    ]),
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "good");
      assertStringIncludes(view.aside ?? "", "2 jobs · 3 repos");
      assert(
        !wire.calls.some((call) => call.includes("/notes/")),
        "an archived repository is not asked about",
      );
    },
  );
});

Deno.test("ci: a run on a repository's own default branch is the one read", async () => {
  await withGitHub(
    standingOrg(green, green, [{
      name: "gvisor",
      defaultBranch: "master",
      workflows: [{
        name: "Build",
        file: "build.yml",
        runs: [
          { conclusion: "failure", branch: "main", minutesAgo: 5 },
          { conclusion: "success", branch: "master", minutesAgo: 50 },
        ],
      }],
    }]),
    async () => {
      const view = await createCiHealth().collect(ctx());
      assertEquals(view.status, "good");
      assertEquals(view.value, "passing");
    },
  );
});

Deno.test("ci: a repository whose workflows cannot be read is reported, not hidden", async () => {
  await withGitHub(
    standingOrg(green, green, [{ name: "pond", workflowsStatus: 403 }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      assertEquals(view.value, "1 unreadable");
      assertStringIncludes(
        view.extra ?? "",
        `<span class="dot amber"></span>pond · workflows`,
      );
      assertStringIncludes(view.extra ?? "", "unreadable");
      // The tile is not red, so the two main builds stay in the body.
      assertStringIncludes(view.extra ?? "", "labs · CI");
    },
  );
});

Deno.test("ci: a tile with everything to list does not also carry a line saying nothing", async () => {
  await withGitHub(
    [
      { name: REPO.split("/")[1], workflowsStatus: 403 },
      { name: LOOM_REPO.split("/")[1], workflowsStatus: 403 },
    ],
    async () => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      assertEquals(view.value, "2 unreadable");
      // Every tile in a row is as tall as the tallest, so the list takes the
      // one line under the headline rather than standing beneath a second.
      assertEquals(view.sub, undefined);
      assertStringIncludes(view.extra ?? "", "labs · workflows");
      assertStringIncludes(view.extra ?? "", "loom · workflows");
    },
  );
});

Deno.test("ci: an organization with nothing in it says so, having no list to show", async () => {
  await withGitHub([], async () => {
    const view = await createCiHealth().collect(ctx());

    assertEquals(view.status, "unknown");
    assertEquals(view.value, "—");
    assertEquals(view.sub, "no jobs found");
    assertEquals(view.extra, undefined);
  });
});

Deno.test("ci: the repository inventory is read once an hour and shared", async () => {
  await withGitHub(standingOrg(green, green), async (wire) => {
    const tile = createCiHealth();
    await tile.collect(ctx());
    await tile.collect(ctx());

    const inventory = wire.calls.filter((call) =>
      call.startsWith(`/orgs/${ORG}/repos`) ||
      call.includes("/actions/workflows?per_page=100")
    );
    assertEquals(inventory.length, 3, "one repo listing and two workflow listings");
    assertEquals(
      wire.calls.filter((call) => call.includes("/runs?")).length,
      4,
      "the results behind the inventory are read every collection",
    );
  });
});

Deno.test("ci: an unavailable organization listing stays gray", async () => {
  const real = { fetch: globalThis.fetch, error: console.error };
  const logged: string[] = [];
  globalThis.fetch = (() =>
    Promise.resolve(new Response("nope", { status: 403 }))) as typeof fetch;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const view = await createCiHealth().collect(ctx());
    assertEquals(view.status, "unknown");
    assertEquals(view.value, "—");
    assertEquals(view.sub, "auth failed");
    assert(
      logged.some((line) =>
        line.startsWith("ci: could not read the repository inventory:")
      ),
    );
  } finally {
    globalThis.fetch = real.fetch;
    console.error = real.error;
  }
});

Deno.test("ci: an organization listing that is not a list of repositories stays gray", async () => {
  const real = { fetch: globalThis.fetch, error: console.error };
  const logged: string[] = [];
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({ message: "moved" }))) as typeof fetch;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const view = await createCiHealth().collect(ctx());
    assertEquals(view.status, "unknown");
    assertEquals(view.value, "—");
    assert(
      logged.some((line) =>
        line.includes("GitHub organization repositories returned invalid data")
      ),
    );
  } finally {
    globalThis.fetch = real.fetch;
    console.error = real.error;
  }
});

Deno.test("ci: no token grays the tile out without asking GitHub anything", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the tile asked GitHub without a token");
  }) as typeof fetch;
  try {
    const view = await createCiHealth().collect(ctx({}));
    assertEquals(view.status, "unknown");
    assertEquals(view.value, "—");
    assertEquals(view.sub, "set GH_TOKEN");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("ci: the organization listing is walked to its last page", async () => {
  // GitHub answers at most 100 repositories per page, so a full page means
  // there is another. Every repository past the first page carries a job.
  const filler = Array.from({ length: 99 }, (_, index): RepoSpec => ({
    name: `filler-${index}`,
  }));
  await withGitHub(
    [...standingOrg(green, green), ...filler, {
      name: "web-weaver",
      workflows: [{
        name: "Deploy",
        file: "deploy.yml",
        runs: [{ conclusion: "failure", minutesAgo: 15 }],
      }],
    }],
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(
        wire.calls.filter((call) => call.startsWith(`/orgs/${ORG}/repos`)),
        [
          `/orgs/${ORG}/repos?per_page=100&page=1`,
          `/orgs/${ORG}/repos?per_page=100&page=2`,
        ],
      );
      assertEquals(view.status, "bad");
      assertEquals(view.value, "web-weaver failing");
      assertStringIncludes(view.aside ?? "", "3 jobs · 102 repos");
    },
  );
});

Deno.test("ci: a workflow whose runs cannot be read is reported, not passed over", async () => {
  await withGitHub(
    standingOrg(green, green, [{
      name: "raia",
      runsStatus: 403,
      workflows: [{ name: "Nightly", file: "nightly.yml", runs: green }],
    }]),
    async (wire) => {
      const view = await createCiHealth().collect(ctx());

      assertEquals(view.status, "warn");
      assertEquals(view.value, "1 unreadable");
      assertStringIncludes(view.extra ?? "", "raia · Nightly");
      assertStringIncludes(view.extra ?? "", "auth failed");
      assert(
        wire.logged.some((line) =>
          line.startsWith("ci: could not read:") &&
          line.includes("raia · Nightly")
        ),
        "an unreadable job leaves a diagnosable trace",
      );
    },
  );
});

Deno.test("ci: a workflow name carrying markup is escaped into the body", async () => {
  await withGitHub(
    standingOrg(green, green, [{
      name: "pond",
      workflows: [{
        name: `<img src=x onerror="alert(1)">`,
        file: "evil.yml",
        runs: [{ conclusion: "failure", minutesAgo: 10 }],
      }],
    }]),
    async () => {
      const view = await createCiHealth().collect(ctx());

      assert(!(view.extra ?? "").includes("<img"));
      assertStringIncludes(view.extra ?? "", "&lt;img src=x onerror=&quot;");
    },
  );
});

Deno.test("ci: a stale inventory is read again on the next collection", async () => {
  await withGitHub(standingOrg(green, green), async (wire) => {
    const tile = createCiHealth();
    const realNow = Date.now;
    try {
      await tile.collect(ctx());
      Date.now = () => T0 + HOUR + 60_000;
      await tile.collect(ctx());
    } finally {
      Date.now = realNow;
    }
    assertEquals(
      wire.calls.filter((call) => call.startsWith(`/orgs/${ORG}/repos`)).length,
      2,
    );
  });
});
