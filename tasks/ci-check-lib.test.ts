import {
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  acceptedCoverageDebt,
  type Artifact,
  coverageGroupsForChangedFiles,
  coverageMetricForGroup,
  coverageMetricGroupName,
  coverageMetricMeasuredSet,
  downloadAndExtractArtifact,
  fetchArtifactsForRun,
  fetchIssueComments,
  githubGet,
  githubPatch,
  githubPost,
  GitHubRateLimitError,
  isNotFound,
  measuredSetCoverageMetric,
} from "./ci-check-lib.ts";
import { buildZip } from "./zip-testing.ts";

Deno.test("acceptedCoverageDebt reads a name's line increment", () => {
  assertEquals(
    acceptedCoverageDebt(
      "ACCEPT_COVERAGE_DEBT: packages/runner  +123 lines\n" +
        "ACCEPT_COVERAGE_DEBT: workspace +7 lines",
    ),
    new Map([["packages/runner", 123], ["workspace", 7]]),
  );
});

Deno.test("acceptedCoverageDebt reads a one-line increment", () => {
  assertEquals(
    acceptedCoverageDebt("ACCEPT_COVERAGE_DEBT: tasks +1 line"),
    new Map([["tasks", 1]]),
  );
});

Deno.test("acceptedCoverageDebt rejects a total in place of an increment", () => {
  // An acceptance naming a total says nothing about how much debt the pull
  // request adds, and means something different against every baseline, so it
  // is rejected rather than read as though it were an increment.

  assertThrows(
    () =>
      acceptedCoverageDebt("ACCEPT_COVERAGE_DEBT: packages/runner = 123 lines"),
    Error,
    "<workspace member> +N lines",
  );
});

Deno.test("acceptedCoverageDebt rejects a metric name in place of a name", () => {
  assertThrows(
    () =>
      acceptedCoverageDebt(
        "ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines +7 lines",
      ),
    Error,
    "<workspace member> +N lines",
  );
});

Deno.test("acceptedCoverageDebt rejects a name nothing could measure", () => {
  // Only `packages` splits below its top level, so a path below any other
  // top-level directory cannot name a member.
  assertThrows(
    () => acceptedCoverageDebt("ACCEPT_COVERAGE_DEBT: tasks/foo +7 lines"),
    Error,
    "name a workspace member",
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
});

Deno.test("acceptedCoverageDebt reads a workspace member nested below packages", () => {
  const name = "packages/connectors/github/connector";
  assertEquals(
    acceptedCoverageDebt(`ACCEPT_COVERAGE_DEBT: ${name} +7 lines`).get(name),
    7,
  );
});

Deno.test("acceptedCoverageDebt reads only a marker starting a line", () => {
  // A description explaining the mechanism carries no acceptance, and is not a
  // malformed one either.
  const prose =
    "Rebasing changes what an ACCEPT_COVERAGE_DEBT: total means, so it " +
    "accepts a rise instead.";
  assertEquals(acceptedCoverageDebt(prose).size, 0);

  // An indented example of the marker is an example, and accepts nothing by
  // showing the form.
  assertEquals(
    acceptedCoverageDebt(
      "Accept a rise above the baseline instead:\n\n" +
        "    ACCEPT_COVERAGE_DEBT: packages/runner +12 lines\n",
    ).size,
    0,
  );

  // Flush against the left margin, the same line is an acceptance.
  assertEquals(
    acceptedCoverageDebt(
      "Accepting the flapping lines:\n\nACCEPT_COVERAGE_DEBT: tasks +3 lines\n",
    ),
    new Map([["tasks", 3]]),
  );
});

Deno.test("coverageGroupsForChangedFiles names the source group of each changed source file", () => {
  const groups = coverageGroupsForChangedFiles([
    "packages/runner/src/cell.ts",
    "packages/patterns/README.md",
    "packages/ui/src/button.test.tsx",
    "tasks\\coverage-gate.ts",
    "scripts/build.ts",
  ]);

  assertEquals([...groups].sort(), ["packages/runner", "packages/ui", "tasks"]);
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
    },
  );
});

Deno.test("downloadAndExtractArtifact raises a rate limit rather than reporting no artifact", async () => {
  // Reported as `null` the limit would read as an artifact that is not
  // there, which is a claim about the run rather than about GitHub.
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

Deno.test("fetchArtifactsForRun stops at a short or an empty page when GitHub gives no total", async () => {
  const artifacts = (count: number): Artifact[] =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      name: `artifact-${index + 1}`,
      size_in_bytes: 1,
      expired: false,
    }));
  const originalFetch = globalThis.fetch;
  try {
    for (
      const [pages, read, requested] of [
        [[artifacts(3)], 3, 1],
        [[artifacts(100), []], 100, 2],
      ] as const
    ) {
      let requests = 0;
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ artifacts: pages[requests++] }), {
            status: 200,
          }),
        )) as typeof fetch;
      assertEquals((await fetchArtifactsForRun(123)).length, read);
      assertEquals(requests, requested);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("coverageMetricGroupName returns null for a name that is not a coverage metric", () => {
  assertEquals(coverageMetricGroupName("job: Check"), null);
  assertEquals(coverageMetricGroupName("coverage-debt: tasks"), null);
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
  // would report a figure the gate has no opinion about.
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
      new Response(new Uint8Array(zip), { status: 200 }),
    )) as typeof fetch;
  try {
    return await read();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("downloadAndExtractArtifact unpacks the artifact it downloads", async () => {
  const zip = await buildZip(
    "records.json",
    new TextEncoder().encode('{"ok":true}'),
    0,
  );
  const directory = await withArtifactZip(
    zip,
    () => downloadAndExtractArtifact(7, "artifact-unpack-test-"),
  );
  assertExists(directory);
  try {
    assertEquals(
      await Deno.readTextFile(`${directory}/records.json`),
      '{"ok":true}',
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
