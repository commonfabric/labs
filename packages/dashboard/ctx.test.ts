/**
 * Ctx tests: makeCtx() builds the memoized data sources every tile reads. The
 * GitHub API is stubbed with a canned runs response, so these pin the paging,
 * the age cutoff, the cap, the order the window comes back in, the join between
 * pages, and the caching without a network.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { makeCtx } from "./ctx.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "./config.ts";
import { type Ctx, type Run, runSource } from "./types.ts";

// GitHub hands back a workflow's runs newest first, so the canned runs are timed
// from their id: a larger id is an older run, and a page of ascending ids reads
// the way a real page does.
function run(over: Partial<Run> = {}): Run {
  const startedAt = new Date(Date.now() - 3_600_000 - (over.id ?? 1) * 60_000)
    .toISOString();
  return {
    id: 1,
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

const runs = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => run({ id: from + i }));

// The first request carries no anchor; every later one asks for the runs at or
// before the run the page before it ended on.
const anchorOf = (url: string) => new URL(url).searchParams.get("created");
const first = (url: string) => anchorOf(url) === null;

// Run `body` against a stubbed GitHub API. `reply` answers each request with the
// workflow_runs for that url; `urls` collects every url asked for, so a test can
// count the fetches. The real fetch and GH_TOKEN are restored afterwards, since
// other test files share this process.
async function withGithub(
  reply: (url: string) => Run[],
  body: (ctx: Ctx, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ workflow_runs: reply(url) }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    await body(makeCtx(), urls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
}

Deno.test("runs(): labs main-branch runs of the CI workflow, each tagged with its repo", async () => {
  await withGithub(
    (url) => (first(url) ? runs(2) : []),
    async (ctx, urls) => {
      const out = await ctx.runs();
      assertEquals(
        urls[0],
        `https://api.github.com/repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&per_page=100`,
      );
      assertEquals(out.map((r) => r.id), [1, 2]);
      // A combined stream needs to know which repo a row came from; nothing in the
      // API response carries it, so the fetcher tags each run.
      assertEquals(out.map((r) => r.repo), [REPO, REPO]);
    },
  );
});

Deno.test("runs(): a second read within the TTL is served from the cache, not refetched", async () => {
  await withGithub(
    (url) => (first(url) ? runs(2) : []),
    async (ctx, urls) => {
      const first = await ctx.runs();
      const second = await ctx.runs();
      // Two pages walked once — the second read added no requests.
      assertEquals(urls.length, 2);
      assertEquals(second, first);
      // runsFor with the same repo and workflow is the same source, so it shares it.
      assertEquals(await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main")), first);
      assertEquals(urls.length, 2);
    },
  );
});

Deno.test("runsFor: each repo and workflow is cached separately", async () => {
  await withGithub((url) => {
    if (!first(url)) return [];
    return url.includes(LOOM_REPO) ? [run({ id: 77 })] : [run({ id: 11 })];
  }, async (ctx, urls) => {
    const labs = await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    const loom = await ctx.runsFor(runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"));
    // A second repo must not be handed the first repo's cached runs.
    assertEquals(labs.map((r) => r.id), [11]);
    assertEquals(loom.map((r) => r.id), [77]);
    assertEquals(loom[0].repo, LOOM_REPO);
    assert(
      urls.some((u) =>
        u.includes(
          `repos/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}/runs`,
        )
      ),
      urls.join(" "),
    );
    // Four requests: two pages each. Loom re-read is then cached under its own key.
    assertEquals(urls.length, 4);
    await ctx.runsFor(runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"));
    assertEquals(urls.length, 4);
  });
});

Deno.test("runsFor: a workflow's main and pull request runs are separate sources", async () => {
  await withGithub((url) => {
    if (!first(url)) return [];
    const query = new URL(url).searchParams;
    if (query.get("branch") === "main" && !query.has("event")) {
      return [run({ id: 11 })];
    }
    if (query.get("event") === "pull_request" && !query.has("branch")) {
      return [run({ id: 22, event: "pull_request" })];
    }
    return [];
  }, async (ctx, urls) => {
    const main = await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    const pulls = await ctx.runsFor(
      runSource(REPO, CI_WORKFLOW, "pull requests"),
    );
    assertEquals(main.map((r) => r.id), [11]);
    assertEquals(pulls.map((r) => r.id), [22]);
    // Two pages each, and each source is then cached under its own key.
    assertEquals(urls.length, 4);
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "pull requests"));
    await ctx.runsFor(runSource(REPO, CI_WORKFLOW, "main"));
    assertEquals(urls.length, 4);
  });
});

Deno.test("runs(): pages accumulate in order until a page comes back empty", async () => {
  await withGithub(
    // The anchored page opens on the run page one ended on, then carries on.
    (url) => (first(url) ? runs(100) : [run({ id: 100 }), ...runs(3, 101)]),
    async (ctx, urls) => {
      const out = await ctx.runs();
      assertEquals(out.length, 103);
      assertEquals(out[100].id, 101); // page 2 follows page 1, newest-first order kept
      assertEquals(urls.map(first), [true, false]);
    },
  );
});

Deno.test("runs(): an empty first page stops the walk rather than asking for the next", async () => {
  await withGithub(() => [], async (ctx, urls) => {
    assertEquals(await ctx.runs(), []);
    assertEquals(urls.length, 1);
  });
});

Deno.test("runs(): the stream is capped at CI_RUNS_MAX, mid-page if need be", async () => {
  // The stub over-serves: one page holds more than the cap.
  await withGithub(
    (url) => (first(url) ? runs(CI_RUNS_MAX + 50) : []),
    async (ctx, urls) => {
      const out = await ctx.runs();
      assertEquals(out.length, CI_RUNS_MAX);
      assertEquals(out[out.length - 1].id, CI_RUNS_MAX); // truncated at the cap, not at the page end
      assertEquals(urls.length, 1); // and no further page is asked for
    },
  );
});

Deno.test("runs(): a run past the age cutoff ends the stream", async () => {
  const day = 86_400_000;
  const at = (id: number, daysAgo: number) =>
    run({
      id,
      run_started_at: new Date(Date.now() - daysAgo * day).toISOString(),
    });
  await withGithub(
    (url) =>
      first(url)
        ? [
          at(1, 1),
          at(2, CI_RUNS_MAX_AGE_DAYS + 1),
          at(3, CI_RUNS_MAX_AGE_DAYS + 2),
        ]
        : [],
    async (ctx, urls) => {
      const out = await ctx.runs();
      // Runs arrive newest-first, so the first one past the cutoff and everything
      // behind it are dropped.
      assertEquals(out.map((r) => r.id), [1]);
      assertEquals(urls.length, 1);
    },
  );
});

Deno.test("runs(): a run with an unreadable start time is kept, not read as ancient", async () => {
  await withGithub(
    (url) =>
      first(url)
        ? [run({ id: 1, run_started_at: "" }), run({ id: 2 })]
        : [],
    async (ctx) => {
      assertEquals((await ctx.runs()).map((r) => r.id), [1, 2]);
    },
  );
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
  await withGithub(
    (url) =>
      first(url) ? [{ ...run({ id: 7 }), ...surplus } as Run] : [],
    async (ctx) => {
      const [only] = await ctx.runs();
      assertEquals(only.id, 7);
      assertEquals(only.repo, REPO);
      assertEquals(only.head_commit, { message: "t (#1)" });
      assertEquals(
        Object.keys(only).filter((key) => key in surplus),
        [],
      );
    },
  );
});

const DAY_MS = 86_400_000;

// A run whose creation and start are `msAgo` behind now, for the tests that care
// which moment a page was cut from.
const aged = (id: number, msAgo: number) => {
  const at = new Date(Date.now() - msAgo).toISOString();
  return run({ id, created_at: at, run_started_at: at });
};

Deno.test("runs(): an anchored page that does not carry its anchor is refused", async () => {
  // Page one is current; the anchored page answers from a month back and has
  // never heard of the run it was anchored to. Joined, they would read as one
  // window with a month-wide hole, and the streak the build tile walks would run
  // off the end of the current runs into the stale ones.
  await withGithub(
    (url) =>
      first(url)
        ? Array.from({ length: 100 }, (_, i) => aged(1 + i, 3 * DAY_MS + i * 60_000))
        : Array.from({ length: 100 }, (_, i) => aged(1000 + i, 35 * DAY_MS + i * 60_000)),
    async (ctx) => {
      const error = await assertRejects(() => ctx.runs(), Error);
      assertStringIncludes(error.message, "came back without run 100");
    },
  );
});

Deno.test("runs(): a page anchored to a run the source no longer knows is refused", async () => {
  // The other way round: page one answers from a month back, so the anchor is a
  // run from then. A page that comes back without it is refused just the same,
  // whichever side of the join went stale.
  await withGithub(
    (url) =>
      first(url)
        ? Array.from({ length: 100 }, (_, i) => aged(1000 + i, 35 * DAY_MS + i * 60_000))
        : Array.from({ length: 100 }, (_, i) => aged(1 + i, 3 * DAY_MS + i * 60_000)),
    async (ctx) => {
      const error = await assertRejects(() => ctx.runs(), Error);
      assertStringIncludes(error.message, "came back without run 1099");
    },
  );
});

Deno.test("runs(): a page is asked for by anchor, not by offset", async () => {
  // Built once, so the assertion names the same run the stub served rather than
  // a run stamped a few milliseconds later.
  const page = Array.from({ length: 100 }, (_, i) => aged(1 + i, (1 + i) * 60_000));
  const rest = Array.from({ length: 100 }, (_, i) => aged(100 + i, (100 + i) * 60_000));
  await withGithub((url) => (first(url) ? page : rest), async (ctx, urls) => {
    await ctx.runs();
    assertEquals(urls.length, 2);
    assert(!urls[0].includes("created="), urls[0]);
    assert(
      !urls.some((u) => new URL(u).searchParams.has("page")),
      urls.join(" "),
    );
    // The second request names the run the first one ended on.
    assertEquals(anchorOf(urls[1]), `<=${page[99].created_at}`);
  });
});

Deno.test("runs(): the run an anchored page repeats is carried once", async () => {
  // Every anchored page opens on a run the window already holds, so the join
  // always repeats one run. The repeat is not two runs, and the window is one
  // short of two full pages because of it.
  await withGithub(
    (url) =>
      first(url)
        ? Array.from({ length: 100 }, (_, i) => aged(1 + i, (1 + i) * 60_000))
        : Array.from({ length: 100 }, (_, i) => aged(100 + i, (100 + i) * 60_000)),
    async (ctx) => {
      const out = await ctx.runs();
      assertEquals(out.length, 199);
      assertEquals(new Set(out.map((r) => r.id)).size, 199);
      assertEquals(out[0].id, 1);
      assertEquals(out[out.length - 1].id, 199);
    },
  );
});
