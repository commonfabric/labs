import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CiJobs, Job } from "../ci-jobs-page.ts";
import { RECENT_DISPLAY, REPOS_PATH } from "../config.ts";
import { type Board, repoPageResponse, repoPagesRoute } from "../repo-page.ts";
import {
  type Run,
  runSource,
  type RunSource,
  runSourceKey,
  type Tile,
  type TileView,
} from "../types.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 30, 12, 0);

const LABS = "commonfabric/labs";
const LOOM = "commonfabric/loom";
const LABS_MAIN = runSource(LABS, "deno.yml", "main");
const LABS_PRS = runSource(LABS, "deno.yml", "pull requests");

function tile(label: string, over: Partial<Tile> = {}): Tile {
  return {
    label,
    intervalMs: MINUTE,
    collect: () => Promise.resolve({ status: "unknown" }),
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    repo: "labs",
    workflow: "CI",
    path: ".github/workflows/deno.yml",
    pinned: false,
    status: "good",
    failing: false,
    result: "success",
    event: "push",
    startedAt: NOW - 30 * MINUTE,
    ranMs: 20 * MINUTE,
    href: "https://github.com/commonfabric/labs/actions/runs/1",
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 11,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "a".repeat(40),
    display_title: "fix(runner): keep labels (#8248)",
    created_at: new Date(NOW - HOUR).toISOString(),
    run_started_at: new Date(NOW - HOUR).toISOString(),
    updated_at: new Date(NOW - HOUR + 30 * MINUTE).toISOString(),
    html_url: "https://github.com/commonfabric/labs/actions/runs/11",
    head_commit: { message: "fix(runner): keep labels (#8248)\n\nbody" },
    ...over,
  };
}

function collection(over: Partial<CiJobs> = {}): CiJobs {
  return {
    jobs: [job()],
    repos: ["labs", "loom"],
    unreadableRepos: [],
    collectedAt: NOW - 2 * MINUTE,
    ...over,
  };
}

/** A board holding `views` by tile label and `runs` by run source. */
function board(
  tiles: Tile[],
  views: Record<string, TileView> = {},
  runs: Map<string, { runs: Run[]; problem?: string }> = new Map(),
): Board {
  return {
    tiles,
    view: (tile) => views[tile.label],
    runs: (source: RunSource) =>
      runs.get(runSourceKey(source)) ?? { runs: [], problem: "pending" },
  };
}

async function page(
  from: Board,
  jobs: CiJobs | undefined,
  query: string,
): Promise<{ status: number; html: string }> {
  const response = repoPageResponse(
    from,
    jobs,
    new URL(`http://localhost${REPOS_PATH}${query}`),
    NOW,
  );
  return { status: response.status, html: await response.text() };
}

const TRUST = tile("labs ci trust", {
  repo: LABS,
  runSources: [LABS_MAIN],
});
const DURATION = tile("labs ci duration", {
  repo: LABS,
  runSources: [LABS_PRS],
});
const LOOM_TRUST = tile("loom ci trust", {
  repo: LOOM,
  runSources: [runSource(LOOM, "test-fast.yml", "main")],
});

/** How many times `needle` occurs in `html`. */
const occurrences = (html: string, needle: string): number =>
  html.split(needle).length - 1;

describe("repo-page", () => {
  describe("the index", () => {
    it("groups repositories by standing, worst first within each group", async () => {
      const failing = (repo: string, count: number) =>
        Array.from({ length: count }, (_, index) =>
          job({
            repo,
            workflow: `W${index}`,
            status: "bad",
            failing: true,
            result: "failure",
          }));
      const { status, html } = await page(
        board([]),
        collection({
          jobs: [...failing("two", 2), ...failing("ten", 10), job({ repo: "calm" })],
          repos: ["calm", "quiet", "ten", "two"],
        }),
        "",
      );
      expect(status).toBe(200);
      expect(html).toContain("<title>Repositories</title>");
      expect(html).toContain(
        "4 repositories. 2 need attention, 1 is passing, and 1 has nothing to report.",
      );
      const at = (needle: string) => html.indexOf(needle);
      expect(at("Not passing")).toBeLessThan(at(`href="/repos?name=ten"`));
      expect(at(`href="/repos?name=ten"`)).toBeLessThan(at(`href="/repos?name=two"`));
      expect(at(`href="/repos?name=two"`)).toBeLessThan(at("Passing <span"));
      expect(at("Passing <span")).toBeLessThan(at(`href="/repos?name=calm"`));
      expect(at(`href="/repos?name=calm"`)).toBeLessThan(at("Nothing to report"));
      expect(at("Nothing to report")).toBeLessThan(at(`href="/repos?name=quiet"`));
    });

    it("counts a troubled repository's workflows, runs going, and measures on its card", async () => {
      const going = run({ status: "in_progress", conclusion: null });
      const { html } = await page(
        board(
          [TRUST, DURATION],
          { "labs ci trust": { status: "bad", value: "40.0%" } },
          new Map([[runSourceKey(LABS_MAIN), { runs: [going] }]]),
        ),
        collection(),
        "",
      );
      expect(html).toContain(`<span class="rc-facts">1 workflow · 1 running · 2 measures</span>`);
    });

    it("lists a repository only a tile names", async () => {
      const { html } = await page(board([LOOM_TRUST]), collection({ jobs: [], repos: [] }), "");
      expect(html).toContain(`href="/repos?name=loom"`);
    });

    it("draws a card naming the worst thing wrong for a repository in trouble, and a name for one passing", async () => {
      const { html } = await page(
        board([]),
        collection({
          jobs: [
            job({ repo: "loom", workflow: "Tests", status: "bad", failing: true, result: "failure" }),
            job({ repo: "labs" }),
          ],
        }),
        "",
      );
      expect(html).toContain(`<span class="rc-word said-bad">1 failing</span><span class="rc-worst">Tests · failure</span>`);
      expect(html).toContain(`<div class="names"><a href="/repos?name=labs"><span class="dot green"></span>labs</a></div>`);
      expect(html).not.toContain(`<a class="repo-card good"`);
    });
  });

  describe("a repository's page", () => {
    it("leads with its standing, and lists each thing that needs attention", async () => {
      const { html } = await page(
        board([TRUST, DURATION], {
          "labs ci trust": {
            status: "warn",
            value: "82.0%",
            sub: "first-try green · last 160 runs",
          },
          "labs ci duration": { status: "good", value: "6m", sub: "median" },
        }),
        collection({
          jobs: [
            job({
              workflow: "Benchmarks",
              status: "bad",
              failing: true,
              result: "failure",
              startedAt: NOW - 2 * HOUR,
            }),
            job(),
          ],
        }),
        "?name=labs",
      );
      expect(html).toContain(`<header class="hero bad">`);
      expect(html).toContain(`<p class="standing-line said-bad"><span class="dot red"></span>1 failing</p>`);
      expect(html).toContain(`<span class="subject">Benchmarks</span><span class="detail">failure</span><span class="when">2h ago</span>`);
      expect(html).toContain(`<span class="subject">labs ci trust</span><span class="detail"><b>82.0%</b> · first-try green · last 160 runs</span>`);
      expect(html).not.toContain(`<span class="subject">labs ci duration</span>`);
      // Each links where its job or tile does.
      expect(html).toContain(`<a class="concern" href="https://github.com/commonfabric/labs/actions/runs/1" target="_blank" rel="noopener"><span class="dot red"></span><span class="subject">Benchmarks</span>`);
      expect(html).toContain(`<div class="concern"><span class="dot amber"></span><span class="subject">labs ci trust</span>`);
    });

    it("says it is passing and lists nothing when every job and measure is well", async () => {
      const { html } = await page(
        board([TRUST], { "labs ci trust": { status: "good", value: "99.0%" } }),
        collection(),
        "?name=labs",
      );
      expect(html).toContain(`<header class="hero good">`);
      expect(html).toContain("</span>Passing</p>");
      expect(html).toContain("Nothing needs attention.");
    });

    it("leaves a gray measure out of its standing, and still lists it", async () => {
      const { html } = await page(
        board([TRUST, DURATION], {
          "labs ci trust": { status: "good", value: "99.0%" },
          "labs ci duration": { status: "unknown", value: "—", sub: "source unreachable" },
        }),
        collection(),
        "?name=labs",
      );
      expect(html).toContain(`<header class="hero good">`);
      expect(html).toContain(`<span class="subject">labs ci duration</span><span class="detail"><b>—</b> · source unreachable</span>`);
    });

    it("names its standing by its color when its workflows are unreadable and a measure is red", async () => {
      const { html } = await page(
        board([TRUST], { "labs ci trust": { status: "bad", value: "40.0%" } }),
        collection({ jobs: [], unreadableRepos: [LABS] }),
        "?name=labs",
      );
      expect(html).toContain(`<header class="hero bad">`);
      expect(html).toContain("</span>Needs attention</p>");
    });

    it("counts a job that could not be read among its workflows and not among those passing", async () => {
      const { html } = await page(
        board([]),
        collection({
          jobs: [job(), job({ workflow: "Audit", status: "warn", result: "rate limit hit" })],
        }),
        "?name=labs",
      );
      expect(html).toContain("<dt>workflows passing</dt><dd>1<small> of 2</small></dd>");
      expect(html).toContain(`<span class="subject">Audit</span><span class="detail">rate limit hit</span>`);
    });

    it("shows the measures of its own tiles and not another repository's", async () => {
      const { html } = await page(
        board([TRUST, LOOM_TRUST], {
          "labs ci trust": {
            status: "good",
            value: "99.0%",
            extra: `<svg id="trust-chart"></svg>`,
            href: "/bench?view=ci",
          },
          "loom ci trust": { status: "good", value: "12.0%" },
        }),
        collection(),
        "?name=labs",
      );
      expect(html).toContain(`<a class="card good" data-focus-key="labs ci trust" href="/bench?view=ci">`);
      expect(html).toContain(`<svg id="trust-chart"></svg>`);
      expect(html).not.toContain("loom ci trust");
      expect(html).not.toContain("12.0%");
    });

    it("links to its code, pull requests, and actions on GitHub", async () => {
      const { html } = await page(board([]), collection(), "?name=labs");
      expect(html).toContain(`<a href="https://github.com/commonfabric/labs" target="_blank" rel="noopener">commonfabric/labs ↗</a>`);
      expect(html).toContain(`<a href="https://github.com/commonfabric/labs/pulls" target="_blank" rel="noopener">pull requests ↗</a>`);
      expect(html).toContain(`<a href="https://github.com/commonfabric/labs/actions" target="_blank" rel="noopener">actions ↗</a>`);
      expect(html).toContain("<span>workflows read 2m ago</span>");
    });

    it("links each run source's heading to every run of its workflow on GitHub", async () => {
      const { html } = await page(
        board(
          [TRUST, DURATION],
          {},
          new Map([
            [runSourceKey(LABS_MAIN), { runs: [run()] }],
            [runSourceKey(LABS_PRS), { runs: [run({ event: "pull_request" })] }],
          ]),
        ),
        collection(),
        "?name=labs",
      );
      expect(html).toContain(`<a href="https://github.com/commonfabric/labs/actions/workflows/deno.yml?query=branch%3Amain" target="_blank" rel="noopener">deno.yml ↗</a>`);
      expect(html).toContain(`<a href="https://github.com/commonfabric/labs/actions/workflows/deno.yml?query=event%3Apull_request" target="_blank" rel="noopener">deno.yml ↗</a>`);
    });

    it("shows the tiles, runs, and listing problems of a same-named repository under another owner", async () => {
      const elsewhere = runSource("elsewhere/labs", "ci.yml", "main");
      const { html } = await page(
        board(
          [tile("elsewhere trust", { repo: "elsewhere/labs", runSources: [elsewhere] })],
          { "elsewhere trust": { status: "good", value: "91.0%" } },
          new Map([[runSourceKey(elsewhere), { runs: [run()] }]]),
        ),
        collection({ unreadableRepos: ["elsewhere/labs"] }),
        "?name=labs",
      );
      expect(html).toContain("91.0%");
      expect(html).toContain("ci.yml ↗</a>");
      expect(html).toContain("Its workflows could not be listed.");
    });

    it("says no tile follows its runs when none does", async () => {
      const { html } = await page(board([]), collection(), "?name=labs");
      expect(html).toContain("No tile follows this repository's runs.");
      expect(html).not.toContain(`class="runs-chart"`);
    });

    it("says a measure is not collected yet before its tile has a view", async () => {
      const { html } = await page(board([TRUST]), collection(), "?name=labs");
      expect(html).toContain(`<p class="big said-unknown">—</p><p class="sub">not collected yet</p>`);
    });

    it("charts and lists the runs of each of its sources, main before pull requests", async () => {
      const { html } = await page(
        board(
          [TRUST, DURATION],
          {},
          new Map([
            [runSourceKey(LABS_MAIN), { runs: [run()] }],
            [runSourceKey(LABS_PRS), {
              runs: [
                run({
                  id: 12,
                  status: "in_progress",
                  conclusion: null,
                  event: "pull_request",
                  display_title: "feat: a new page",
                  html_url: "https://github.com/commonfabric/labs/actions/runs/12",
                }),
              ],
            }],
          ]),
        ),
        collection(),
        "?name=labs",
      );
      const main = html.indexOf("Main branch <span");
      const prs = html.indexOf("Pull requests <span");
      expect(main).toBeGreaterThan(0);
      expect(prs).toBeGreaterThan(main);
      expect(html).toContain("The newest finished run on main passed 30 min ago.");
      // A bar for each run, linked to it.
      expect(html).toContain(`href="https://github.com/commonfabric/labs/actions/runs/11" target="_blank" rel="noopener" tabindex="-1" title="fix(runner): keep labels (#8248) — green · 30m 00s · 1h ago"`);
      // A run on main is listed by the pull request that landed it.
      expect(html).toContain(`href="https://github.com/commonfabric/labs/pull/8248" target="_blank" rel="noopener">fix(runner): keep labels (#8248)</a>`);
      // A pull request's run is listed by its title, and counts as running now.
      expect(html).toContain(`href="https://github.com/commonfabric/labs/actions/runs/12" target="_blank" rel="noopener">feat: a new page</a>`);
      expect(html).toContain(`<a class="bar run"`);
      expect(html).toContain("<dt>running now</dt><dd>1</dd>");
    });

    it("says how the newest finished run on main went, and leaves out runs that are out of date", async () => {
      const failed = run({ conclusion: "failure" });
      const read = (problem?: string) =>
        page(
          board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs: [failed], problem }]])),
          collection(),
          "?name=labs",
        );
      expect((await read()).html).toContain("The newest finished run on main failed 30 min ago.");
      expect((await read("rate limit hit")).html).not.toContain("The newest finished run on main");
    });

    it("scales its chart to the longest run but one in ten when that reaches past the median's headroom", async () => {
      const took = [10, 10, 10, 10, 10, 10, 10, 10, 60, 60, 100];
      const runs = took.map((minutes, index) =>
        run({
          id: 100 + index,
          updated_at: new Date(NOW - HOUR + minutes * MINUTE).toISOString(),
        })
      );
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs }]])),
        collection(),
        "?name=labs",
      );
      // The median is 10 minutes, and the longest run but one in ten is 60,
      // past 1.7 times 10, so 60 is the top and only the 100-minute run
      // reaches past it.
      expect(occurrences(html, `style="height:16.7%"`)).toBe(8);
      expect(occurrences(html, `<a class="bar green" style="height:100.0%"`)).toBe(2);
      expect(occurrences(html, `<a class="bar green over" style="height:100.0%"`)).toBe(1);
    });

    it("draws no chart when no run has taken any time", async () => {
      const instant = run({ updated_at: new Date(NOW - HOUR).toISOString() });
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs: [instant] }]])),
        collection(),
        "?name=labs",
      );
      expect(html).not.toContain(`class="runs-chart"`);
      expect(html).toContain(`<ol class="latest">`);
    });

    it("scales its chart so that one run that hung does not flatten the rest", async () => {
      const runs = [
        run({ id: 99, updated_at: new Date(NOW - HOUR + 300 * MINUTE).toISOString() }),
        ...Array.from({ length: 10 }, (_, index) => run({ id: 100 + index })),
      ];
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs }]])),
        collection(),
        "?name=labs",
      );
      // The scale's top is the median of the runs that passed, 30 minutes,
      // with its headroom above it.
      expect(occurrences(html, `style="height:58.8%"`)).toBe(10);
      expect(html).toContain(`<a class="bar green over" style="height:100.0%"`);
      expect(html).toContain(`<div class="median" style="bottom:58.8%"><span>median<br>30m</span></div>`);
    });

    it("lists the three newest runs under the chart", async () => {
      const runs = Array.from({ length: 5 }, (_, index) =>
        run({ id: 100 + index, display_title: `run ${index}`, head_commit: { message: `change ${index}` } }));
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs }]])),
        collection(),
        "?name=labs",
      );
      expect(occurrences(html, `<a class="what"`)).toBe(3);
      expect(html).toContain(">change 2</a>");
      expect(html).not.toContain(">change 3</a>");
    });

    it("links a workflow's run in progress, named for a screen reader", async () => {
      const { html } = await page(
        board([]),
        collection({ jobs: [job({ runningHref: "https://example.test/runs/9" })] }),
        "?name=labs",
      );
      expect(html).toContain(`<a class="going" href="https://example.test/runs/9" target="_blank" rel="noopener" title="running" aria-label="CI running">`);
    });

    it("keeps its attention section when nothing needs attention", async () => {
      const { html } = await page(board([]), collection(), "?name=labs");
      expect(html).toContain(`<section><h2>Needs attention</h2><p class="quiet">Nothing needs attention.</p></section>`);
    });

    it("counts a run in progress once when a job and a snapshot both carry it", async () => {
      const going = run({ status: "in_progress", conclusion: null });
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs: [going] }]])),
        collection({ jobs: [job({ runningHref: going.html_url })] }),
        "?name=labs",
      );
      expect(html).toContain("<dt>running now</dt><dd>1</dd>");
    });

    it("links a run's duration to the commit's CI Gantt for labs, and not for other repositories", async () => {
      const WEAVER = "commonfabric/commonfabric-weaver";
      const weaverMain = runSource(WEAVER, "ci.yml", "main");
      const { html: labs } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs: [run()] }]])),
        collection(),
        "?name=labs",
      );
      expect(labs).toContain(`<a href="/ci-gantt?repo=labs&amp;sha=${"a".repeat(40)}`);
      const { html: weaver } = await page(
        board(
          [tile("weaver ci trust", { repo: WEAVER, runSources: [weaverMain] })],
          {},
          new Map([[runSourceKey(weaverMain), {
            runs: [run({ html_url: "https://github.com/commonfabric/commonfabric-weaver/actions/runs/11" })],
          }]]),
        ),
        collection(),
        "?name=commonfabric-weaver",
      );
      expect(weaver).toContain(`<span class="took">30m 00s</span>`);
      expect(weaver).not.toContain("/ci-gantt");
    });

    it("charts as many of a source's newest runs as the recent-runs tile shows", async () => {
      const runs = Array.from(
        { length: RECENT_DISPLAY + 10 },
        (_, index) => run({ id: 100 + index, html_url: `https://example.test/runs/${100 + index}` }),
      );
      const { html } = await page(
        board([TRUST], {}, new Map([[runSourceKey(LABS_MAIN), { runs }]])),
        collection(),
        "?name=labs",
      );
      expect(html).toContain(`deno.yml ↗</a> · last ${RECENT_DISPLAY} runs · ${RECENT_DISPLAY} of ${RECENT_DISPLAY} passed`);
      expect(occurrences(html, `<a class="bar `)).toBe(RECENT_DISPLAY);
      expect(html).toContain(`runs/${100 + RECENT_DISPLAY - 1}"`);
      expect(html).not.toContain(`runs/${100 + RECENT_DISPLAY}"`);
    });

    it("says when a source's runs are unread or out of date", async () => {
      const { html } = await page(
        board(
          [TRUST, DURATION],
          {},
          new Map([
            [runSourceKey(LABS_MAIN), {
              runs: [run()],
              problem: "rate limit hit",
            }],
          ]),
        ),
        collection(),
        "?name=labs",
      );
      expect(html).toContain("The runs could not be brought up to date: rate limit hit. These are the last ones read.");
      expect(html).toContain(`<p class="quiet">The runs have not been read yet.</p>`);
    });

    it("lists its own workflows worst first, those with no verdict last, each saying how its run went", async () => {
      const { html } = await page(
        board([]),
        collection({
          jobs: [
            job({ workflow: "Lunch", status: "unknown", result: "no completed run" }),
            job(),
            job({ workflow: "Deploy", status: "bad", failing: true, result: "failure" }),
            job({ repo: "loom", workflow: "Tests (fast)" }),
          ],
        }),
        "?name=labs",
      );
      expect(html).toContain("1 passing · 1 failing · 1 with no verdict · <a");
      const at = (name: string) => html.indexOf(`">${name}</a>`);
      expect(at("Deploy")).toBeLessThan(at("CI"));
      expect(at("CI")).toBeLessThan(at("Lunch"));
      expect(html).toContain(`<li class="wf good"><span class="dot green"></span><a href="https://github.com/commonfabric/labs/actions/runs/1" target="_blank" rel="noopener" title="push · success · ran 20m 00s · 30m ago">CI</a><span class="age">30m</span></li>`);
      expect(html).toContain(`title="no completed run">Lunch</a><span class="why">no completed run</span>`);
      expect(html).not.toContain("Tests (fast)");
    });

    it("says its workflows are not read yet before the ci tile's first collection", async () => {
      const { status, html } = await page(board([TRUST]), undefined, "?name=labs");
      expect(status).toBe(200);
      expect(html).toContain("The ci tile has not finished reading the organization yet.");
      expect(html).toContain("Its workflows have not been read yet.");
    });

    it("turns orange for a repository whose workflows could not be listed", async () => {
      const { html } = await page(
        board([]),
        collection({ jobs: [], repos: ["gvisor"], unreadableRepos: ["commonfabric/gvisor"] }),
        "?name=gvisor",
      );
      expect(html).toContain(`<header class="hero warn">`);
      expect(html).toContain("</span>Unreadable</p>");
      expect(html).toContain("The workflows of this repository could not be listed.");
    });

    it("escapes what GitHub names", async () => {
      const { html } = await page(
        board([]),
        collection({
          jobs: [job({ workflow: "<b>CI</b>", status: "bad", failing: true, result: "failure" })],
        }),
        "?name=labs",
      );
      expect(html).toContain("&lt;b&gt;CI&lt;/b&gt;");
      expect(html).not.toContain("<b>CI</b>");
    });

    it("offers every repository in its switch, with its own selected", async () => {
      const { html } = await page(board([]), collection(), "?name=loom");
      expect(html).toContain(`<option value="/repos?name=labs">labs</option><option value="/repos?name=loom" selected>loom</option>`);
      // The heading leads back to the index.
      expect(html).toContain(`<b><a href="/repos">Repositories</a></b>`);
    });
  });

  it("returns a 404 naming a repository it does not know", async () => {
    const { status, html } = await page(board([]), collection(), "?name=%3Cx%3E");
    expect(status).toBe(404);
    expect(html).toContain(`The dashboard knows no repository named &lt;x&gt;. <a href="/repos">See every repository it knows.</a>`);
    expect(html).not.toContain("<x>");
  });

  it("serves one live route that reads the board and the collection it is given", async () => {
    const route = repoPagesRoute(
      board([TRUST], { "labs ci trust": { status: "good", value: "97.5%" } }),
      () => collection(),
    );
    expect(route.path).toBe(REPOS_PATH);
    expect(route.live).toBe(true);
    const url = new URL(`http://localhost${REPOS_PATH}?name=labs`);
    const html = await (await route.handler(new Request(url), url)).text();
    expect(html).toContain("97.5%");
    expect(html).toContain(`id="live-badge"`);
  });
});
