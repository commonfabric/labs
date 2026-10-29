/**
 * ci-duration's drill-down: the Gantt page and the /bench/gantt.svg image behind it.
 * The image handler shells out to scripts/ci-gantt.ts and writes a temp file.
 * The subprocess and the filesystem calls around it are replaced with
 * stubs that record what the handler asked for and hand back a canned result.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, Run } from "../types.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "../config.ts";
import type {
  CiGanttInput,
  CiGanttOptions,
  CiHistorySource,
} from "../ci-job-history.ts";
import {
  ciCommitGanttPage,
  type CiGanttDataProvider,
  ciGanttPage,
  commitGanttUrl,
  labsCiDuration,
  loomCiDuration,
  renderGantt,
  renderGanttRoute,
  weaverCiDuration,
} from "./ci-duration.ts";
import { PERFORMANCE_VIEW_STYLES } from "../performance-views.ts";
import { collectFromWorkingRuns } from "../test/github-attempts.ts";
import { STATUS_EDGE, STATUS_WASH } from "../palette.ts";

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><text>chart</text></svg>',
);

// Stands in for the collector, which writes the renderer's input file itself
// rather than handing back a chart to be serialized.
function provideGantt(
  chart: (
    source: CiHistorySource,
    options: CiGanttOptions,
  ) => CiGanttInput["runs"],
): CiGanttDataProvider {
  return async (source, options, destination) => {
    const runs = chart(source, options);
    await Deno.writeTextFile(destination, JSON.stringify({ runs }));
    return runs.length;
  };
}

function ctx(runs: Run[]): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: () => Promise.resolve(runs),
    env: () => undefined,
  };
}

function run(over: Partial<Run>): Run {
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "pull_request",
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

interface Fake {
  success?: boolean; // what the ci-gantt run reports
  stderr?: string; // what it printed on the way out
  throws?: Error; // the spawn itself blowing up
  abortOnOutput?: AbortController;
  abortAfterOutput?: AbortController;
}

interface Result {
  res: Response;
  args: string[]; // the argv the handler built for scripts/ci-gantt.ts
  logged: string; // everything the handler wrote to console.error
  leftover: string[]; // temp files still on disk once the handler returned
  input: CiGanttInput;
  requested: { source: CiHistorySource; options: CiGanttOptions };
}

async function gantt(
  query: string,
  fake: Fake = {},
  signal?: AbortSignal,
): Promise<Result> {
  const origTemp = Deno.makeTempFile;
  const origRead = Deno.readFile;
  const origWrite = Deno.writeTextFile;
  const origRemove = Deno.remove;
  const origCommand = Object.getOwnPropertyDescriptor(Deno, "Command")!;
  const origError = console.error;
  const live = new Set<string>();
  const logged: string[] = [];
  let args: string[] = [];
  let seq = 0;
  let written = "";
  let commandSignal: AbortSignal | undefined;
  let requested!: Result["requested"];
  try {
    Deno.makeTempFile = (opts?: Deno.MakeTempOptions) => {
      const path = `/fake-tmp/${opts?.prefix ?? ""}${++seq}${
        opts?.suffix ?? ""
      }`;
      live.add(path);
      return Promise.resolve(path);
    };
    Deno.readFile = (path: string | URL) =>
      live.has(String(path))
        ? Promise.resolve(SVG)
        : Promise.reject(new Deno.errors.NotFound(String(path)));
    Deno.writeTextFile = (
      _path: string | URL,
      data: string | ReadableStream<string>,
    ) => {
      assert(typeof data === "string");
      written = data;
      return Promise.resolve();
    };
    Deno.remove = (path: string | URL) => {
      live.delete(String(path));
      return Promise.resolve();
    };
    Object.defineProperty(Deno, "Command", {
      configurable: true,
      value: class {
        constructor(
          _cmd: string,
          opts: { args: string[]; signal?: AbortSignal },
        ) {
          args = opts.args;
          commandSignal = opts.signal;
        }
        output() {
          if (fake.abortOnOutput) {
            assertEquals(commandSignal, fake.abortOnOutput.signal);
            fake.abortOnOutput.abort();
            return Promise.reject(fake.abortOnOutput.signal.reason);
          }
          if (fake.abortAfterOutput) {
            assertEquals(commandSignal, fake.abortAfterOutput.signal);
            fake.abortAfterOutput.abort();
          }
          if (fake.throws) return Promise.reject(fake.throws);
          return Promise.resolve({
            success: fake.success ?? true,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(fake.stderr ?? ""),
          });
        }
      },
    });
    console.error = (...parts: unknown[]) =>
      void logged.push(parts.map(String).join(" "));
    const url = new URL(`http://d/bench/gantt.svg${query}`);
    const res = await renderGantt(
      url.searchParams,
      provideGantt((source, options) => {
        requested = { source, options };
        return Array.from(
          { length: Math.min(options.limit, 60) },
          (_, index) => ({
            run: {
              attempt: 1,
              databaseId: index + 1,
              status: "completed",
              conclusion: "success",
              event: "push",
              headBranch: "main",
              startedAt: "2026-06-20T18:00:00Z",
              workflowName: source.workflow,
            },
            jobs: [],
          }),
        );
      }),
      signal,
    );
    return {
      res,
      args,
      logged: logged.join("\n"),
      leftover: [...live],
      input: written ? JSON.parse(written) as CiGanttInput : { runs: [] },
      requested,
    };
  } finally {
    Deno.makeTempFile = origTemp;
    Deno.readFile = origRead;
    Deno.writeTextFile = origWrite;
    Deno.remove = origRemove;
    Object.defineProperty(Deno, "Command", origCommand);
    console.error = origError;
  }
}

// The flag ci-gantt is given for a named option, or undefined when unset.
function opt(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

Deno.test("the Gantt page shares the performance view selector", async () => {
  const url = new URL("http://d/bench?view=gantt");
  const html = ciGanttPage(url);
  assertStringIncludes(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  assertStringIncludes(html, "<title>CI run Gantt</title>");
  assertStringIncludes(html, PERFORMANCE_VIEW_STYLES);
  for (const status of ["good", "warn", "bad"] as const) {
    assertStringIncludes(
      html,
      `.brow.${status},.crow.${status}{border-color:color-mix(in srgb,var(--status-${status}) ${
        Number((STATUS_EDGE[status] * 100).toFixed(4))
      }%,transparent);background:color-mix(in srgb,var(--status-${status}) ${
        Number((STATUS_WASH[status] * 0.75 * 100).toFixed(4))
      }%,transparent)}`,
    );
  }
  assertStringIncludes(
    html,
    `.fetch-progress.error,.fetch-progress.warning{border-color:color-mix(in srgb,var(--status-warn) ${
      Number((STATUS_EDGE.warn * 100).toFixed(4))
    }%,transparent)}`,
  );
  assertStringIncludes(html, `${REPO} · ${CI_WORKFLOW}`);
  assertStringIncludes(html, `href="/"`); // a way back to the dashboard
  assertStringIncludes(
    html,
    'href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99">Runtime benchmarks</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI duration history</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99" aria-current="page">CI run Gantt</a>',
  );
  assertStringIncludes(html, '<option value="labs" selected>labs</option>');
  assertStringIncludes(html, "/bench/gantt.svg?"); // the controls point at the image route
  assertStringIncludes(html, "p.set('theme', document.documentElement.dataset.theme");
  assertStringIncludes(html, 'id="fetch-progress"');
  assertStringIncludes(html, 'id="fetch-title">Idle</strong>');
  assertStringIncludes(html, 'aria-label="CI Gantt fetch progress"');
  assertStringIncludes(html, "/bench/gantt-progress?");
  assertStringIncludes(html, "new EventSource(progressUrl())");
  assertStringIncludes(
    html,
    "state.discoveryRequestsMade + ' workflow requests made",
  );
  assertStringIncludes(html, "state.cachedRuns + ' cached");
  assertStringIncludes(html, "state.sharedRequests + ' shared");
  assertStringIncludes(html, "title.textContent = 'Generating chart image…'");
  assertStringIncludes(html, "collectionError || text");
  assertStringIncludes(html, "g.removeAttribute('src')");
  assertStringIncludes(html, "const controller = new AbortController()");
  assertStringIncludes(html, "signal: controller.signal");
  assertStringIncludes(html, "sequence !== renderSequence");
  assertStringIncludes(html, "controller.signal.aborted");
  assert(!html.includes('class="spinner"'));
  assert(!html.includes("min runs per job"));
  assert(!html.includes("minRuns"));
  // The runs slider offers only what the image route will honor, so dragging it
  // to either end can't ask for a limit that comes back silently clamped.
  assertStringIncludes(html, `id="limit" min="1" max="150"`);
  assertEquals((await gantt("?limit=150")).args.indexOf("150") >= 0, true);
  assertStringIncludes(html, "setInterval(() => {");
  assertStringIncludes(html, "}, 1800000)");
  assert(!html.includes("pendingRender"));
  assertStringIncludes(html, "location.href = '/bench?' + params.toString()");
  assert(
    !html.includes(
      ".views a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assert(
    labsCiDuration.routes?.some((route) =>
      route.path === "/bench/gantt-progress"
    ),
  );
  for (
    const path of [
      "/ci-gantt",
      "/ci-gantt.svg",
      "/ci-gantt.png",
      "/ci-gantt-progress",
    ]
  ) {
    assert(labsCiDuration.routes?.some((route) => route.path === path));
  }
  for (const path of ["/ci-gantt.svg", "/ci-gantt-progress"]) {
    const route = labsCiDuration.routes?.find((route) => route.path === path);
    assert(route);
    const invalid = new URL(`http://d${path}?sha=invalid`);
    assertEquals(
      (await route.handler(new Request(invalid), invalid)).status,
      400,
    );

    const tooMany = new URL(`http://d${path}`);
    tooMany.searchParams.set("sha", "f".repeat(40));
    for (let index = 0; index < 151; index++) {
      tooMany.searchParams.append("run", `${1_000 + index}:1`);
    }
    assertEquals(
      (await route.handler(new Request(tooMany), tooMany)).status,
      400,
    );
  }
  for (
    const [path, target] of [
      ["/ci-gantt.png", "/ci-gantt.svg"],
      ["/bench/gantt.png", "/bench/gantt.svg"],
    ]
  ) {
    const route = labsCiDuration.routes?.find((route) => route.path === path);
    assert(route);
    const legacy = new URL(`http://d${path}?repo=loom&limit=12`);
    const response = await route.handler(new Request(legacy), legacy);
    assertEquals(response.status, 308);
    assertEquals(
      response.headers.get("location"),
      `${target}?repo=loom&limit=12`,
    );
  }

  const loomHtml = ciGanttPage(
    new URL(
      "http://d/bench?view=gantt&repo=loom&days=9&sort=duration&stat=p75",
    ),
  );
  assertStringIncludes(loomHtml, `${LOOM_REPO} · ${LOOM_CI_WORKFLOW}`);
  assertStringIncludes(
    loomHtml,
    'href="/bench?view=runtime&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">Runtime benchmarks</a>',
  );
  assertStringIncludes(
    loomHtml,
    'href="/bench?view=ci&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">CI duration history</a>',
  );
  assertStringIncludes(loomHtml, '<option value="loom" selected>loom</option>');
});

Deno.test("the commit Gantt page contains only one commit selection", () => {
  const sha = "b".repeat(40);
  const url = new URL(
    `http://d/ci-gantt?repo=loom&sha=${sha}&limit=2&mainOnly=1&run=701:1&run=702:3`,
  );
  const html = ciCommitGanttPage(url);
  assertStringIncludes(html, `<title>CI Gantt · ${sha.slice(0, 7)}</title>`);
  assertStringIncludes(html, `${LOOM_REPO} · `);
  assertStringIncludes(
    html,
    `href="https://github.com/${LOOM_REPO}/commit/${sha}"`,
  );
  assertStringIncludes(html, 'aria-label="Commit CI Gantt fetch progress"');
  assertStringIncludes(html, "/ci-gantt.svg?");
  assertStringIncludes(html, "/ci-gantt-progress?");
  assertStringIncludes(
    html,
    "Chart includes 2 successful runs for this commit.",
  );
  assertStringIncludes(html, "const image = new Image()");
  assertStringIncludes(html, "image.onerror = () =>");
  assertStringIncludes(html, "URL.revokeObjectURL(src)");
  assertStringIncludes(html, "url.searchParams.set('theme'");
  assertStringIncludes(html, "if (chartSrc) URL.revokeObjectURL(chartSrc)");
  assertStringIncludes(html, "if (chartSettled) return");
  assertStringIncludes(html, "chartSettled = true");
  assertStringIncludes(
    html,
    "stream.close();\n    if (chartSrc) URL.revokeObjectURL(chartSrc);\n    chartSrc = src",
  );
  assert(!html.includes('class="controls"'));
  assert(!html.includes('aria-label="Performance view"'));

  const empty = ciCommitGanttPage(
    new URL(`http://d/ci-gantt?repo=loom&sha=${sha}`),
  );
  assertStringIncludes(
    empty,
    "No successful main CI runs were supplied for this commit.",
  );
  assert(!empty.includes("/ci-gantt.svg?"));
});

Deno.test("the commit Gantt page stars a commit the green branch is at, and no commit it was never at", () => {
  const held = "f".repeat(40);
  const page = (sha: string) =>
    ciCommitGanttPage(
      new URL(`http://d/ci-gantt?repo=loom&sha=${sha}&run=701:1`),
      (repo, asked) =>
        repo === LOOM_REPO && asked === held
          ? { branch: "main-green", current: true }
          : undefined,
    );
  assertStringIncludes(
    page(held),
    `${LOOM_REPO} · <span class="green-star" role="img" aria-label="main-green is at this commit" title="main-green is at this commit">★</span><a class="commit"`,
  );
  assertStringIncludes(page(held), "span.green-star{color:var(--status-good)");
  assert(!page("9".repeat(40)).includes(`<span class="green-star"`));
});

Deno.test("the commit Gantt route reads the green branch of a repository that has one before it serves the page", async () => {
  const at = "e".repeat(40);
  const route = labsCiDuration.routes?.find((route) => route.path === "/ci-gantt");
  assert(route);
  const requests: URL[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)));
    return Promise.resolve(Response.json([
      { id: 8801, after: at, timestamp: new Date().toISOString() },
    ]));
  }) as typeof fetch;
  try {
    const serve = async (repo: string) => {
      const url = new URL(`http://d/ci-gantt?repo=${repo}&sha=${at}&run=701:1`);
      return await (await route.handler(new Request(url), url)).text();
    };
    assertStringIncludes(
      await serve("loom"),
      `aria-label="main-green is at this commit"`,
    );
    assertEquals(requests.map((url) => url.pathname), [
      `/repos/${LOOM_REPO}/activity`,
    ]);
    assert(!(await serve("labs")).includes(`<span class="green-star"`));
    assertEquals(requests.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
});

Deno.test("commit Gantt URL normalization preserves only renderer themes", () => {
  const selection = `repo=labs&sha=${"e".repeat(40)}&run=42:1`;
  for (const theme of ["dark", "light"]) {
    const normalized = commitGanttUrl(
      new URL(`http://d/ci-gantt.svg?${selection}&theme=${theme}`),
    );
    assert(normalized);
    assertEquals(normalized.searchParams.get("theme"), theme);
  }

  const unknown = commitGanttUrl(
    new URL(`http://d/ci-gantt.svg?${selection}&theme=sepia`),
  );
  assert(unknown);
  assertEquals(unknown.searchParams.has("theme"), false);
});

Deno.test("commit Gantt data routes start the exact selected collection", async () => {
  const previousGhToken = Deno.env.get("GH_TOKEN");
  const previousGitHubToken = Deno.env.get("GITHUB_TOKEN");
  const originalError = console.error;
  Deno.env.delete("GH_TOKEN");
  Deno.env.delete("GITHUB_TOKEN");
  console.error = () => {};
  const selection = `repo=labs&sha=${
    "e".repeat(40)
  }&limit=1&mainOnly=1&run=9007199254740991:1`;
  try {
    const imageRoute = labsCiDuration.routes?.find((route) =>
      route.path === "/ci-gantt.svg"
    );
    assert(imageRoute);
    const imageUrl = new URL(`http://d/ci-gantt.svg?${selection}`);
    const image = await imageRoute.handler(new Request(imageUrl), imageUrl);
    assertEquals(image.status, 500);
    assertEquals(await image.text(), "set GH_TOKEN");

    const progressRoute = labsCiDuration.routes?.find((route) =>
      route.path === "/ci-gantt-progress"
    );
    assert(progressRoute);
    const progressUrl = new URL(`http://d/ci-gantt-progress?${selection}`);
    const progress = await progressRoute.handler(
      new Request(progressUrl),
      progressUrl,
    );
    assertEquals(progress.status, 200);
    const events = await progress.text();
    assertStringIncludes(events, '"phase":"error"');
    assertStringIncludes(events, "set GH_TOKEN");
  } finally {
    console.error = originalError;
    if (previousGhToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", previousGhToken);
    if (previousGitHubToken === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", previousGitHubToken);
  }
});

Deno.test("CI duration tiles link to their repository histories", async () => {
  assertEquals(loomCiDuration.routes, undefined);
  const loom = await collectFromWorkingRuns(loomCiDuration, ctx([run({})]));
  assertEquals(loom.href, "/bench?view=ci&repo=loom");
  assertEquals(loom.hint, "main run history ↗");
  const labs = await collectFromWorkingRuns(labsCiDuration, ctx([run({})]));
  assertEquals(labs.href, "/bench?view=ci&repo=labs");
  assertEquals(labs.hint, "main run history ↗");

  const unavailable: Ctx = {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.reject(new Error("set GH_TOKEN to use GitHub")),
    env: () => undefined,
  };
  const coldLabs = await collectFromWorkingRuns(labsCiDuration, unavailable);
  const coldLoom = await collectFromWorkingRuns(loomCiDuration, unavailable);
  assertEquals(
    [coldLabs.href, coldLabs.hint, coldLabs.sub],
    ["/bench?view=ci&repo=labs", "main run history ↗", "set GH_TOKEN"],
  );
  assertEquals(
    [coldLoom.href, coldLoom.hint, coldLoom.sub],
    ["/bench?view=ci&repo=loom", "main run history ↗", "set GH_TOKEN"],
  );

  // Weaver has no history view to open, so its tile is not a link.
  const weaver = await collectFromWorkingRuns(weaverCiDuration, ctx([run({})]));
  assertEquals([weaver.href, weaver.hint], [undefined, undefined]);
  const coldWeaver = await collectFromWorkingRuns(weaverCiDuration, unavailable);
  assertEquals(
    [coldWeaver.href, coldWeaver.hint, coldWeaver.sub],
    [undefined, undefined, "set GH_TOKEN"],
  );
});

Deno.test("/bench/gantt.svg: a successful render returns SVG uncached", async () => {
  const { res, args, input, leftover, requested } = await gantt("?limit=30");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(new Uint8Array(await res.arrayBuffer()), SVG);
  assertEquals(opt(args, "--repo"), REPO);
  assertEquals(opt(args, "--workflow"), CI_WORKFLOW);
  assertEquals(opt(args, "--limit"), "30");
  assertEquals(opt(args, "--theme"), "dark");
  assertEquals(opt(args, "--out"), "/fake-tmp/ci-gantt-2.svg"); // the bytes come from where it was told to write
  assertEquals(opt(args, "--input"), "/fake-tmp/ci-gantt-input-1.json");
  assert(!args.includes("--allow-net"));
  assert(!args.includes("--allow-env"));
  assert(args.includes("--allow-read=/fake-tmp/ci-gantt-input-1.json"));
  assert(!args.includes("--allow-read"));
  assert(!args.includes("--allow-write"));
  assert(!args.includes("--allow-ffi"));
  assert(!args.includes("--allow-sys=cpus,networkInterfaces,hostname"));
  assert(args.includes("--allow-write=/fake-tmp/ci-gantt-2.svg"));
  assertEquals(opt(args, "--scale"), undefined);
  assertEquals(input.runs.length, 30);
  assertEquals(requested.source.key, "labs");
  assertEquals(requested.options, {
    limit: 30,
    mainOnly: false,
    allConclusions: false,
  });
  assertEquals(leftover, []); // the temp file is cleaned up on the way out

  const light = await gantt("?limit=1&theme=light");
  assertEquals(opt(light.args, "--theme"), "default");
});

Deno.test("/bench/gantt.svg includes chart labels without server fonts", async () => {
  const response = await renderGantt(
    new URLSearchParams("limit=1&mainOnly=1"),
    provideGantt(() => [
      {
        run: {
          attempt: 1,
          databaseId: 123,
          status: "completed",
          conclusion: "success",
          event: "push",
          headBranch: "main",
          startedAt: "2026-07-28T18:00:00Z",
          workflowName: CI_WORKFLOW,
        },
        jobs: [{
          name: "Check dashboard labels",
          status: "completed",
          conclusion: "success",
          started_at: "2026-07-28T18:00:05Z",
          completed_at: "2026-07-28T18:01:05Z",
          steps: [{
            name: "🔎 Check",
            number: 1,
            conclusion: "success",
            started_at: "2026-07-28T18:00:10Z",
            completed_at: "2026-07-28T18:01:00Z",
          }],
        }],
      },
    ]),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/svg+xml");
  const svg = await response.text();
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, ">Check dashboard labels</text>");
  assertStringIncludes(svg, ">runs</text>");
});

Deno.test("/bench/gantt.svg finishes collection but skips an abandoned render", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request("http://d/bench/gantt.svg?limit=12", {
    signal: controller.signal,
  });
  const url = new URL(request.url);
  const originalTemp = Deno.makeTempFile;
  const originalRemove = Deno.remove;
  let collected = false;
  const created: string[] = [];
  const removed: string[] = [];
  try {
    Deno.makeTempFile = (opts?: Deno.MakeTempOptions) => {
      const path = `/fake-tmp/${opts?.prefix ?? ""}${opts?.suffix ?? ""}`;
      created.push(path);
      return Promise.resolve(path);
    };
    Deno.remove = (path: string | URL) => {
      removed.push(String(path));
      return Promise.resolve();
    };
    const response = await renderGanttRoute(request, url, (
      _source,
      _options,
      destination,
    ) => {
      collected = true;
      assertEquals(destination, "/fake-tmp/ci-gantt-input-.json");
      return Promise.resolve(0);
    });
    assert(collected);
    // The collection writes into a temporary file, so that one exists; the
    // chart image is never started, so no file is made for its output.
    assertEquals(created, ["/fake-tmp/ci-gantt-input-.json"]);
    assertEquals(removed, ["/fake-tmp/ci-gantt-input-.json"]);
    assertEquals(response.status, 204);
    assertEquals(response.headers.get("cache-control"), "no-store");
  } finally {
    Deno.makeTempFile = originalTemp;
    Deno.remove = originalRemove;
  }
});

Deno.test("/bench/gantt.svg stops rendering when its request is abandoned", async () => {
  const controller = new AbortController();
  const result = await gantt(
    "?limit=12",
    { abortOnOutput: controller },
    controller.signal,
  );
  assertEquals(result.res.status, 204);
  assertEquals(result.res.headers.get("cache-control"), "no-store");
  assert(result.args.includes("12"));
  assertEquals(result.leftover, []);
});

Deno.test("/bench/gantt.svg drops an image completed after abandonment", async () => {
  const controller = new AbortController();
  const result = await gantt(
    "?limit=12",
    { abortAfterOutput: controller },
    controller.signal,
  );
  assertEquals(result.res.status, 204);
  assertEquals(result.res.headers.get("cache-control"), "no-store");
  assertEquals(result.leftover, []);
});

Deno.test("/bench/gantt.svg selects loom for both cached data and rendering", async () => {
  const { args, requested, input } = await gantt(
    "?repo=loom&limit=12&mainOnly=1",
  );
  assertEquals(requested.source.key, "loom");
  assertEquals(requested.options, {
    limit: 12,
    mainOnly: true,
    allConclusions: false,
  });
  assertEquals(opt(args, "--repo"), LOOM_REPO);
  assertEquals(opt(args, "--workflow"), LOOM_CI_WORKFLOW);
  assertEquals(input.runs[0].run.workflowName, LOOM_CI_WORKFLOW);
});

Deno.test("a commit Gantt image requests the selected run attempts", async () => {
  const sha = "c".repeat(40);
  const selected = await gantt(
    `?sha=${sha}&limit=2&mainOnly=1&run=501:1&run=502:4`,
  );
  assertEquals(selected.requested.options, {
    limit: 2,
    mainOnly: true,
    allConclusions: false,
    headSha: sha,
    selectedRuns: [
      { runId: 501, runAttempt: 1 },
      { runId: 502, runAttempt: 4 },
    ],
  });
  assertEquals(
    selected.args.flatMap((arg, index) =>
      arg === "--run-id" ? [selected.args[index + 1]] : []
    ),
    ["501", "502"],
  );
  assertEquals(opt(selected.args, "--min-runs"), "1");
});

Deno.test("/bench/gantt.svg: limit is clamped to the slider's range, junk falls back to 60", async () => {
  assertEquals(opt((await gantt("?limit=500")).args, "--limit"), "150");
  assertEquals(opt((await gantt("?limit=0")).args, "--limit"), "1");
  assertEquals(opt((await gantt("?limit=abc")).args, "--limit"), "60");
  assertEquals(opt((await gantt("")).args, "--limit"), "60");
});

Deno.test("/bench/gantt.svg: the checkboxes are off unless set to 1", async () => {
  const offResult = await gantt("?mainOnly=0&allConclusions=yes");
  const off = offResult.args;
  assert(!off.includes("--main-only"), "mainOnly=0 is not main-only");
  assert(!off.includes("--all-conclusions"));
  assertEquals(offResult.requested.options.allConclusions, false);
  assertEquals(opt(off, "--min-runs"), "6");
  const onResult = await gantt("?mainOnly=1&allConclusions=1");
  const on = onResult.args;
  assert(on.includes("--main-only"));
  assert(on.includes("--all-conclusions"));
  assertEquals(onResult.requested.options.allConclusions, true);
});

Deno.test("/bench/gantt.svg: automatic min-runs fits every window", async () => {
  // A main-only window can be thin. The floor is capped at the run count so even a
  // one-run window still draws instead of having every job dropped.
  assertEquals(opt((await gantt("?mainOnly=1")).args, "--min-runs"), "2");
  assertEquals(
    opt((await gantt("?mainOnly=1&limit=1")).args, "--min-runs"),
    "1",
  );
  assertEquals(opt((await gantt("?limit=1")).args, "--min-runs"), "1");
  assertEquals(opt((await gantt("?limit=4")).args, "--min-runs"), "4");
});

Deno.test("/bench/gantt.svg ignores the removed minRuns parameter", async () => {
  assertEquals(
    opt((await gantt("?mainOnly=1&minRuns=9")).args, "--min-runs"),
    "2",
  );
});

Deno.test("/bench/gantt.svg: a failing ci-gantt is a 500, with its stderr in the server log only", async () => {
  const { res, logged, leftover } = await gantt("?limit=5", {
    success: false,
    stderr: "no runs matched --min-runs",
  });
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "ci-gantt failed (see server log)"); // the raw stderr stays server-side
  assertStringIncludes(logged, "no runs matched --min-runs");
  assertEquals(leftover, []);
});

Deno.test("/bench/gantt.svg: a spawn that throws is a 500, not an unhandled rejection", async () => {
  const { res, logged, leftover } = await gantt("", {
    throws: new Error("deno: command not found"),
  });
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "not found");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertStringIncludes(logged, "deno: command not found");
  assertEquals(leftover, []); // the temp file is removed even on the error path
});

Deno.test("/bench/gantt.svg reports the performance-history boundary as a rate limit hit", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await renderGantt(
      new URLSearchParams(),
      () =>
        Promise.reject(
          new Error(
            "GitHub rate limit has been hit at the 80% performance-history safety threshold.",
          ),
        ),
    );
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(await response.text(), "rate limit hit");
  } finally {
    console.error = originalError;
  }
});

Deno.test("/bench/gantt.svg returns a safe collection error to the page", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await renderGantt(
      new URLSearchParams(),
      () =>
        Promise.reject(new Error("GitHub API secret/path failed: HTTP 401")),
    );
    assertEquals(response.status, 500);
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(await response.text(), "auth failed");
  } finally {
    console.error = originalError;
  }
});

Deno.test("ci-duration: no passing runs is gray, never a false green", async () => {
  const v = await collectFromWorkingRuns(labsCiDuration, 
    ctx([
      run({ conclusion: "failure" }),
      run({ status: "in_progress", conclusion: null }),
    ]),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—"); // no data, like every other tile — not a zero-minute build
  assertEquals(v.duration, 0); // no span to label
  assertEquals(
    await collectFromWorkingRuns(labsCiDuration, ctx([])).then((x) => x.status),
    "unknown",
  );
});

Deno.test("ci-duration: the median minutes set the status against the thresholds", async () => {
  const mins = (m: number) =>
    run({
      created_at: new Date(Date.now() - m * 60_000).toISOString(),
      run_started_at: new Date(Date.now() - m * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  assertEquals(
    await collectFromWorkingRuns(labsCiDuration, ctx([mins(10)])).then((
      v,
    ) => [v.status, v.value]),
    ["good", "10m"],
  );
  assertEquals(
    await collectFromWorkingRuns(labsCiDuration, ctx([mins(16)])).then((
      v,
    ) => [v.status, v.value]),
    ["warn", "16m"],
  );
  assertEquals(
    await collectFromWorkingRuns(labsCiDuration, ctx([mins(45)])).then((
      v,
    ) => [v.status, v.value]),
    ["bad", "45m"],
  );
  // The median, not the mean: one long run among short ones doesn't move it.
  const v = await collectFromWorkingRuns(labsCiDuration, ctx([mins(10), mins(10), mins(180)]));
  assertEquals([v.status, v.value], ["good", "10m"]);
  assertStringIncludes(v.sub ?? "", "median of last 3 PR runs"); // under the 20-run bar -> count window
});

Deno.test("ci-duration measures from creation through completion", async () => {
  const now = Date.now();
  const view = await collectFromWorkingRuns(labsCiDuration, 
    ctx([
      run({
        created_at: new Date(now - 15 * 60_000).toISOString(),
        run_started_at: new Date(now - 5 * 60_000).toISOString(),
        updated_at: new Date(now).toISOString(),
      }),
    ]),
  );

  assertEquals(view.value, "15m");
});
