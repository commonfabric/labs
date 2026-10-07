/**
 * Ctx tests: makeCtx() builds the memoized data sources every tile reads. The
 * GitHub API is stubbed with a workflow's whole run list, served a page at a
 * time as GitHub serves it, and with a filtered list that can lag it, so these
 * pin which runs a source takes, the age cutoff, the cap, the order the window
 * comes back in, what a lagging filtered list can and cannot change, and the
 * caching, without a network.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { makeCtx } from "./ctx.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "./config.ts";
import type { GitHubRun } from "./github-runs.ts";
import { GreenBranch } from "./green-branch.ts";
import { type Ctx, runSource } from "./types.ts";

const DAY_MS = 86_400_000;

// GitHub lists a workflow's runs newest first, and a run created later has a
// larger id. The canned runs are timed from their id: run `TOP` started an
// hour ago, and each smaller id a minute before the one above it.
const TOP = 10_000;

function run(over: Partial<GitHubRun> & { id: number }): GitHubRun {
  const startedAt = new Date(
    Date.now() - 3_600_000 - (TOP - over.id) * 60_000,
  ).toISOString();
  return {
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_sha: "sha",
    display_title: "t",
    created_at: startedAt,
    run_started_at: startedAt,
    updated_at: startedAt,
    html_url: "",
    head_commit: { message: "t (#1)" },
    ...over,
  };
}

// `n` runs from `top` down, newest first, each made by `make`.
const runs = (
  n: number,
  top = TOP,
  make: (id: number) => GitHubRun = (id) => run({ id }),
) => Array.from({ length: n }, (_, i) => make(top - i));

// A page of the unfiltered list, as distinct from a filtered list's page.
const isPage = (url: URL) =>
  url.searchParams.has("page") && !url.searchParams.has("branch") &&
  !url.searchParams.has("event");
const isRun = (url: URL) => /\/actions\/runs\/\d+$/.test(url.pathname);

/**
 * The GitHub API as these tests stub it: `lists` maps a repository to its
 * workflow's whole run list, served a page at a time, `filtered` answers every
 * filtered list, `activity` maps a repository to the updates of its branches,
 * and `fails` makes a request fail. `requests` collects every url asked for.
 */
interface Github {
  lists: Record<string, GitHubRun[]>;
  filtered?: (url: URL) => GitHubRun[];
  activity?: Record<string, { id: number; after: string; timestamp: string }[]>;
  fails?: (url: URL) => boolean;
}

// Run `body` against `github`, stubbed, with a context that reads green
// branches through `green`. The real fetch and GH_TOKEN are restored
// afterwards, since other test files share this process.
async function withGithub(
  github: Github,
  body: (ctx: Ctx, requests: URL[]) => Promise<void>,
  green: (repo: string) => GreenBranch | undefined = () => undefined,
): Promise<void> {
  const requests: URL[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    if (github.fails?.(url)) {
      return Promise.resolve(new Response("down", { status: 502 }));
    }
    const repo = url.pathname.split("/").slice(2, 4).join("/");
    const all = github.lists[repo] ?? [];
    let answer: unknown;
    if (url.pathname.endsWith("/activity")) {
      answer = github.activity?.[repo] ?? [];
    } else if (isRun(url)) {
      answer = all.find((held) => url.pathname.endsWith(`/${held.id}`));
    } else if (isPage(url)) {
      const size = Number(url.searchParams.get("per_page"));
      const start = (Number(url.searchParams.get("page")) - 1) * size;
      answer = { workflow_runs: all.slice(start, start + size) };
    } else {
      answer = { workflow_runs: github.filtered?.(url) ?? [] };
    }
    return Promise.resolve(Response.json(answer));
  }) as typeof fetch;
  try {
    await body(makeCtx(green), requests);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
}

const pages = (requests: URL[]) => requests.filter(isPage);

Deno.test("runs(): labs main-branch runs of the CI workflow, each tagged with its repo", async () => {
  await withGithub({
    lists: {
      [REPO]: [
        run({ id: TOP }),
        run({ id: TOP - 1, head_branch: "feature", event: "pull_request" }),
        run({ id: TOP - 2 }),
      ],
    },
  }, async (ctx, requests) => {
    const out = await ctx.runs();
    assertEquals(
      pages(requests)[0].href,
      `https://api.github.com/repos/${REPO}/actions/workflows/` +
        `${CI_WORKFLOW}/runs?per_page=100&page=1`,
    );
    assertEquals(out.map((r) => r.id), [TOP, TOP - 2]);
    // A combined stream needs to know which repo a row came from; nothing in
    // the API response carries it, so the fetcher tags each run.
    assertEquals(out.map((r) => r.repo), [REPO, REPO]);
  });
});

Deno.test("runs(): a second read within the TTL is served from the cache, not refetched", async () => {
  await withGithub({ lists: { [REPO]: runs(2) } }, async (ctx, requests) => {
    const first = await ctx.runs();
    const made = requests.length;
    const second = await ctx.runs();
    assertEquals(requests.length, made);
    assertEquals(second, first);
    // runsFor with the same repo and workflow is the same source, so it
    // shares it.
    assertEquals(
      await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main")),
      first,
    );
    assertEquals(requests.length, made);
  });
});

Deno.test("runsFor: each repo and workflow is cached separately", async () => {
  await withGithub({
    lists: { [REPO]: [run({ id: 11 })], [LOOM_REPO]: [run({ id: 77 })] },
  }, async (ctx, requests) => {
    const labs = await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    const loom = await ctx.runsFor(
      runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"),
    );
    // A second repo must not be handed the first repo's cached runs.
    assertEquals(labs.map((r) => r.id), [11]);
    assertEquals(loom.map((r) => r.id), [77]);
    assertEquals(loom[0].repo, LOOM_REPO);
    assert(
      pages(requests).some((url) =>
        url.pathname ===
          `/repos/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}/runs`
      ),
      requests.join(" "),
    );
    const made = requests.length;
    await ctx.runsFor(runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"));
    assertEquals(requests.length, made);
  });
});

Deno.test("runsFor: a workflow's main and pull request runs are separate sources", async () => {
  await withGithub({
    lists: {
      [REPO]: [
        run({ id: 22, event: "pull_request", head_branch: "feature" }),
        run({ id: 11 }),
      ],
    },
  }, async (ctx, requests) => {
    const main = await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    const pulls = await ctx.runsFor(
      runSource(REPO, CI_WORKFLOW, "pull requests"),
    );
    assertEquals(main.map((r) => r.id), [11]);
    assertEquals(pulls.map((r) => r.id), [22]);
    // Each source is then cached under its own key.
    const made = requests.length;
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "pull requests"));
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    assertEquals(requests.length, made);
  });
});

Deno.test("runs(): pages accumulate in order until the list ends", async () => {
  // Pull request runs fill most of the list, so the main runs a source wants
  // are spread over several pages.
  const list = runs(250, TOP, (id) =>
    id % 5 === 0
      ? run({ id })
      : run({ id, event: "pull_request", head_branch: "feature" }));
  await withGithub({ lists: { [REPO]: list } }, async (ctx, requests) => {
    const out = await ctx.runs();
    assertEquals(
      out.map((r) => r.id),
      list.filter((held) => held.head_branch === "main").map((r) => r.id),
    );
    assertEquals(pages(requests).length, 3);
  });
});

Deno.test("runs(): an empty first page stops the walk rather than asking for the next", async () => {
  await withGithub({ lists: {} }, async (ctx, requests) => {
    assertEquals(await ctx.runs(), []);
    assertEquals(pages(requests).length, 1);
  });
});

Deno.test("runs(): the stream is capped at CI_RUNS_MAX, mid-page if need be", async () => {
  await withGithub(
    { lists: { [REPO]: runs(CI_RUNS_MAX + 150) } },
    async (ctx, requests) => {
      const out = await ctx.runs();
      assertEquals(out.length, CI_RUNS_MAX);
      // Truncated at the cap, not at the page end.
      assertEquals(out[out.length - 1].id, TOP - CI_RUNS_MAX + 1);
      // Each page after the first holds the last run of the page before it,
      // so the cap falls on the third page, and no fourth is asked for.
      assertEquals(pages(requests).length, 3);
    },
  );
});

Deno.test("runs(): a run past the age cutoff ends the stream", async () => {
  const at = (id: number, daysAgo: number) => {
    const time = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    return run({ id, created_at: time, run_started_at: time });
  };
  await withGithub({
    lists: {
      [REPO]: [
        at(TOP, 1),
        at(TOP - 1, CI_RUNS_MAX_AGE_DAYS + 1),
        at(TOP - 2, 2),
      ],
    },
  }, async (ctx) => {
    // Runs arrive newest-first, so the first one past the cutoff and everything
    // behind it are dropped.
    assertEquals((await ctx.runs()).map((r) => r.id), [TOP]);
  });
});

Deno.test("runs(): a run with an unreadable start time is kept, not read as ancient", async () => {
  await withGithub({
    lists: { [REPO]: [run({ id: TOP, run_started_at: "" }), run({ id: 9 })] },
  }, async (ctx) => {
    assertEquals((await ctx.runs()).map((r) => r.id), [TOP, 9]);
  });
});

Deno.test("runs(): a response without workflow_runs reads as no runs", async () => {
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    )) as typeof fetch;
  try {
    assertEquals(await makeCtx().runs(), []);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
});

Deno.test("env(): reads the process environment, undefined when unset", () => {
  const key = "DASHBOARD_CTX_TEST_KEY";
  const ctx = makeCtx();
  Deno.env.set(key, "set-by-the-test");
  try {
    assertEquals(ctx.env(key), "set-by-the-test");
  } finally {
    Deno.env.delete(key);
  }
  assertEquals(ctx.env(key), undefined);
});

Deno.test("runs(): a run keeps only the fields tiles read", async () => {
  // What GitHub actually sends with every entry. The repository, head
  // repository, whole head commit, and both actors are around fifty times the
  // size of the fields a tile reads, and the snapshot is held between
  // collections, so none of it is kept.
  const surplus = {
    repository: { id: 1, full_name: REPO, description: "x".repeat(500) },
    head_repository: { id: 1, full_name: REPO },
    actor: { login: "someone", id: 2 },
    triggering_actor: { login: "someone", id: 2 },
    artifacts_url: "https://api.github.test/artifacts",
    jobs_url: "https://api.github.test/jobs",
    check_suite_id: 99,
  };
  await withGithub({
    lists: { [REPO]: [{ ...run({ id: 7 }), ...surplus }] },
  }, async (ctx) => {
    const [only] = await ctx.runs();
    assertEquals(only.id, 7);
    assertEquals(only.repo, REPO);
    assertEquals(only.head_commit, { message: "t (#1)" });
    assertEquals(Object.keys(only).filter((key) => key in surplus), []);
  });
});

Deno.test("runs(): the newest page brings in runs the listing lags behind", async () => {
  // GitHub's list filtered to main answers from an index weeks behind: it
  // knows only the oldest run, and shows it failing as it once was.
  await withGithub({
    lists: { [REPO]: runs(3) },
    filtered: () => [
      run({
        id: TOP - 2,
        conclusion: "failure",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ],
  }, async (ctx) => {
    const out = await ctx.runs();
    assertEquals(out.map((r) => r.id), [TOP, TOP - 1, TOP - 2]);
    assertEquals(out.map((r) => r.conclusion), [
      "success",
      "success",
      "success",
    ]);
  });
});

Deno.test("runs(): a filtered list that shows a run as it stood earlier cannot turn it back", async () => {
  const later = new Date(Date.now() - 60_000).toISOString();
  const earlier = new Date(Date.now() - 600_000).toISOString();
  await withGithub({
    lists: {
      [REPO]: [run({ id: TOP, run_attempt: 2, updated_at: later })],
    },
    filtered: () => [
      run({
        id: TOP,
        status: "in_progress",
        conclusion: null,
        updated_at: earlier,
      }),
    ],
  }, async (ctx, requests) => {
    const [only] = await ctx.runs();
    assertEquals(only.run_attempt, 2);
    assertEquals(only.conclusion, "success");
    assertEquals(requests.filter(isRun), []);
  });
});

Deno.test("runs(): a main run started again since it was read is read again by its id", async () => {
  using time = new FakeTime();
  // The run started again sits below the top page of the list, which a later
  // read of the top does not reach.
  const list = runs(150);
  const github: Github = {
    lists: { [REPO]: list },
    filtered: (url) =>
      url.searchParams.get("branch") === "main"
        ? list.filter((held) => held.run_attempt > 1)
        : [],
  };
  await withGithub(github, async (ctx, requests) => {
    await ctx.runs();
    const again = run({
      id: TOP - 120,
      run_attempt: 2,
      updated_at: new Date(Date.now() + 1_000).toISOString(),
    });
    list[120] = again;
    time.tick(20_001);
    requests.length = 0;

    const out = await ctx.runs();
    assertEquals(out.find((r) => r.id === again.id)?.run_attempt, 2);
    assertEquals(
      requests.filter(isRun).map((url) => url.pathname),
      [`/repos/${REPO}/actions/runs/${again.id}`],
    );
  });
});

Deno.test("runsFor: the pull request source takes pull request runs from the newest page", async () => {
  await withGithub({
    lists: {
      [REPO]: [
        run({ id: TOP, event: "pull_request", head_branch: "feature" }),
        run({ id: TOP - 1 }),
        run({ id: TOP - 2, event: "pull_request", head_branch: "fix" }),
      ],
    },
  }, async (ctx) => {
    const pulls = await ctx.runsFor(
      runSource(REPO, CI_WORKFLOW, "pull requests"),
    );
    assertEquals(pulls.map((r) => r.id), [TOP, TOP - 2]);
  });
});

Deno.test("runsFor: a workflow's sources share a read of its newest page", async () => {
  await withGithub({ lists: { [REPO]: runs(30) } }, async (ctx, requests) => {
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "pull requests"));
    assertEquals(pages(requests).length, 1);
  });
});

Deno.test("runs(): a failed read of the newest page fails the fetch", async () => {
  await withGithub({
    lists: { [REPO]: runs(3) },
    fails: (url) => url.searchParams.get("page") === "1",
  }, async (ctx) => {
    await assertRejects(() => ctx.runs(), Error, "HTTP 502");
  });
});

Deno.test("runs(): a failed read of a later unfiltered page fails the fetch", async () => {
  const list = runs(250, TOP, (id) =>
    id % 5 === 0
      ? run({ id })
      : run({ id, event: "pull_request", head_branch: "feature" }));
  await withGithub({
    lists: { [REPO]: list },
    fails: (url) => url.searchParams.get("page") === "2",
  }, async (ctx) => {
    await assertRejects(() => ctx.runs(), Error, "HTTP 502");
  });
});

Deno.test("runsFor: a run on main carries what its repo's green branch says of its commit, and a pull request's run does not", async () => {
  const current = "c".repeat(40);
  const former = "d".repeat(40);
  const recently = new Date(Date.now() - 3_600_000).toISOString();
  const loom = new GreenBranch(LOOM_REPO, "main-green");
  await withGithub({
    lists: {
      [LOOM_REPO]: [
        run({ id: TOP, head_sha: current }),
        run({ id: TOP - 1, head_sha: former }),
        run({ id: TOP - 2, head_sha: "e".repeat(40) }),
        run({
          id: TOP - 3,
          head_sha: current,
          event: "pull_request",
          head_branch: "feature",
        }),
      ],
    },
    activity: {
      [LOOM_REPO]: [
        { id: 902, after: current, timestamp: recently },
        { id: 901, after: former, timestamp: recently },
      ],
    },
  }, async (ctx, requests) => {
    const main = await ctx.runsFor(
      runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"),
    );
    assertEquals(main.map((r) => r.green), [
      { branch: "main-green", current: true },
      { branch: "main-green", current: false },
      undefined,
    ]);
    const pulls = await ctx.runsFor(
      runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "pull requests"),
    );
    assertEquals(pulls.map((r) => r.green), [undefined]);
    // Only the main source reads the branch, and labs has none.
    await ctx.runs();
    assertEquals(
      requests.filter((url) => url.pathname.endsWith("/activity")).map((url) =>
        url.pathname
      ),
      [`/repos/${LOOM_REPO}/activity`],
    );
  }, (repo) => repo === LOOM_REPO ? loom : undefined);
});
