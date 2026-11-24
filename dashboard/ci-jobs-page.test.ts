/**
 * The page behind the ci tile: what each of its states renders, the order it
 * puts jobs in, and what it says about a job it has no verdict or no reading
 * for. The page is a pure function of one collection, so every test here hands
 * it one and reads back the HTML of the live page that frames it.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type CiJobs,
  CI_JOBS_PATH,
  ciJobsPage,
  ciJobsStatus,
  type Job,
  followSorting,
  sortTable,
} from "./ci-jobs-page.ts";
import { LIVE_PAGE_UPDATE } from "./live-page-client.ts";
import { livePage, livePageResponse } from "./live-page.ts";
import { faviconHref } from "./favicon.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 22, 14, 30);

function job(over: Partial<Job> = {}): Job {
  return {
    repo: "labs",
    workflow: "CI",
    path: ".github/workflows/ci.yml",
    pinned: false,
    status: "good",
    failing: false,
    result: "success",
    event: "push",
    startedAt: NOW - HOUR,
    ranMs: 17 * MINUTE + 3_000,
    href: "https://github.com/commonfabric/labs/actions/runs/1",
    ...over,
  };
}

function collection(over: Partial<CiJobs> = {}): CiJobs {
  return {
    jobs: [job()],
    repos: ["labs"],
    unreadableRepos: [],
    collectedAt: NOW - 2 * MINUTE,
      ...over,
  };
}

// The page as the ci tile's route serves it.
function pageHtml(collected: CiJobs | undefined, now: number): string {
  return livePage(ciJobsPage(collected, now));
}

// The repository cell of each row, in the order the page put them in.
function rowRepos(html: string): string[] {
  return [...html.matchAll(/<td class="repo"[^>]*>.*?<\/span><a [^>]*>([^<]*)</g)]
    .map((match) => match[1]);
}

Deno.test("ci jobs page: a job carries its result, duration, and when it ran", () => {
  const html = pageHtml(collection(), NOW);

  assertStringIncludes(html, "<title>CI jobs</title>");
  assertStringIncludes(html, `href="/"`);
  assertStringIncludes(html, "collected 2026-09-22 14:28 UTC · 2m ago");
  assertStringIncludes(html, ">labs<");
  assertStringIncludes(html, ">CI</a>");
  assertStringIncludes(html, ">success<");
  assertStringIncludes(html, ">push<");
  assertStringIncludes(html, ">17m 03s<");
  assertStringIncludes(html, ">2026-09-22 13:30 UTC<");
  assertStringIncludes(html, ">1h ago<");
  assertStringIncludes(
    html,
    `href="https://github.com/commonfabric/labs/actions/runs/1"`,
  );
});

Deno.test("ci jobs page: the summary counts each state of a job", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        // A failure old enough to have gone orange is still a failure.
        job({ repo: "amp", status: "warn", failing: true, result: "failure" }),
        job({ repo: "raia", status: "warn", result: "rate limit hit" }),
        job({ repo: "pond", status: "unknown", result: "no completed run" }),
      ],
      repos: ["labs", "loom", "amp", "raia", "gvisor"],
      unreadableRepos: ["commonfabric/gvisor"],
    }),
    NOW,
  );

  for (const [term, value] of [
    // The job with no verdict is not one the counts speak for.
    ["jobs", "4"],
    ["repositories", "5"],
    ["passing", "1"],
    ["failing", "2"],
    // The unreadable repository counts beside the job that could not be read,
    // and the orange failure counts with the failures rather than here.
    ["unreadable", "2"],
    ["no verdict", "1"],
    ["running", "0"],
  ]) {
    assertStringIncludes(html, `<dt>${term}</dt><dd>${value}</dd>`);
  }
});

Deno.test("ci jobs page: a job with a run in progress has a running dot after its name", () => {
  const running = "https://github.com/commonfabric/loom/actions/runs/7";
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({ repo: "loom", runningHref: running }),
        // A workflow whose first run is still going has no verdict yet.
        job({
          repo: "pond",
          status: "unknown",
          result: "no completed run",
          runningHref: "https://github.com/commonfabric/pond/actions/runs/8",
        }),
      ],
      repos: ["labs", "loom", "pond"],
    }),
    NOW,
  );

  // The dot follows the workflow's own link and leads to the run in progress.
  assertStringIncludes(
    html,
    `>CI</a><a class="dot run" href="${running}" target="_blank" rel="noopener" title="running" aria-label="CI running"></a></td>`,
  );
  assertStringIncludes(
    html,
    `>CI</a><a class="dot run" href="https://github.com/commonfabric/pond/actions/runs/8"`,
  );
  assertEquals(html.match(/class="dot run"/g)?.length, 2);
  assertStringIncludes(html, `<dt>running</dt><dd>2</dd>`);
});

Deno.test("ci jobs page: jobs are ordered worst first, then by name", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ repo: "zed" }),
        job({ repo: "pond", status: "unknown", result: "no completed run" }),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        job({ repo: "arc" }),
        job({ repo: "bay", status: "warn", result: "auth failed" }),
        job({ repo: "amp", status: "bad", result: "timed_out" }),
      ],
      repos: ["zed", "pond", "loom", "arc", "bay", "amp"],
    }),
    NOW,
  );

  // The job with no verdict is listed under the table, not through it.
  assertEquals(rowRepos(html), ["amp", "loom", "bay", "arc", "zed", "pond"]);
  assertStringIncludes(html, "Workflows with no verdict · 1");
});

Deno.test("ci jobs page: two jobs in one repository sort by workflow", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ workflow: "Nightly" }),
        job({ workflow: "Audit" }),
      ],
    }),
    NOW,
  );

  const workflows = [...html.matchAll(/>([^<]*)<\/a>/g)].map((m) => m[1]);
  assertEquals(workflows.filter((name) => name === "Audit").length, 1);
  assert(
    html.indexOf(">Audit</a>") < html.indexOf(">Nightly</a>"),
    "the earlier name comes first",
  );
});

Deno.test("ci jobs page: a job with no run is listed apart, linked at its workflow", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({
          repo: "pond",
          workflow: "Preview",
          status: "unknown",
          result: "no completed run",
          startedAt: undefined,
          ranMs: undefined,
          href: "https://github.com/commonfabric/labs/actions/workflows/x.yml",
        }),
      ],
    }),
    NOW,
  );

  assertStringIncludes(html, "Workflows with no verdict · 1");
  assertStringIncludes(html, "/actions/workflows/x.yml");
  assertStringIncludes(html, `<dt>no verdict</dt><dd>1</dd>`);
  // It says why it has no verdict, and carries none of the table's measures.
  assertStringIncludes(html, `<td class="measure">no completed run</td></tr>`);
  assertEquals([...html.matchAll(/data-sort="-1"/g)].length, 0);
});

Deno.test("ci jobs page: a job whose workflow changed since it failed says so", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({
          repo: "crm",
          workflow: "Nightly export",
          status: "unknown",
          result: "changed since it failed",
          href: "https://github.com/commonfabric/crm/actions/runs/9",
        }),
      ],
    }),
    NOW,
  );

  // It leaves the table for the section below it, linked at the failure it
  // no longer counts, with the reason beside it.
  assertStringIncludes(html, "Workflows with no verdict · 1");
  assertStringIncludes(
    html,
    `href="https://github.com/commonfabric/crm/actions/runs/9"`,
  );
  assertStringIncludes(
    html,
    `<td class="measure">changed since it failed</td></tr>`,
  );
  assertStringIncludes(html, `<dt>failing</dt><dd>0</dd>`);
});

Deno.test("ci jobs page: a job whose run left no timing shows dashes, not a made-up time", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ startedAt: undefined, ranMs: undefined })],
    }),
    NOW,
  );

  assertEquals([...html.matchAll(/<td class="measure[^>]*>—<\/td>/g)].length, 3);
});

Deno.test("ci jobs page: unreadable repositories get their own section", () => {
  const html = pageHtml(
    collection({ unreadableRepos: ["commonfabric/pond"] }),
    NOW,
  );

  assertStringIncludes(html, "Repositories that could not be read · 1");
  assertStringIncludes(html, `<a href="/repos?name=pond">pond</a>`);
  assertStringIncludes(html, `https://github.com/commonfabric/pond/actions`);

  const none = pageHtml(collection(), NOW);
  assert(!none.includes("Repositories that could not be read"));
});

Deno.test("ci jobs page: a repository or workflow name carrying markup is escaped", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ workflow: `<img src=x onerror="alert(1)">` })],
      unreadableRepos: [`commonfabric/<script>`],
    }),
    NOW,
  );

  // The page carries a theme script of its own, so the check is that neither
  // name reached the markup unescaped, not that no script tag is present.
  assert(!html.includes("<img"));
  assert(!html.includes("commonfabric/<script>"));
  assert(!html.includes("<script></a>"));
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;");
  assertStringIncludes(html, "commonfabric/&lt;script&gt;/actions");
  assertStringIncludes(html, `?name=%3Cscript%3E">&lt;script&gt;</a>`);
});

Deno.test("ci jobs page: a job's status is a shape as well as a color", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job(),
        job({ repo: "loom", status: "bad", failing: true, result: "failure" }),
        job({ repo: "bay", status: "warn", failing: true, result: "failure" }),
      ],
    }),
    NOW,
  );

  // The dashboard's own shapes: a circle passing, a diamond failing, a
  // triangle warning, so the three read apart without their colors.
  assertStringIncludes(html, ".dot.green::before{border-radius:50%");
  assertStringIncludes(html, ".dot.red::before{inset:-1px;clip-path:polygon(");
  assertStringIncludes(html, ".dot.amber::before{clip-path:polygon(");
  for (const shade of ["green", "red", "amber"]) {
    assertStringIncludes(html, `<span class="dot ${shade}"></span>`);
  }
});

Deno.test("ci jobs page: every column carries the value it sorts on", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ event: "schedule", ranMs: 92_000 })],
    }),
    NOW,
  );

  // What the cells show is written to be read, so each carries its own key.
  assertStringIncludes(html, `data-sort="labs"`);
  assertStringIncludes(html, `data-sort="CI"`);
  assertStringIncludes(html, `data-sort="schedule"`);
  // Worst first: the result sorts on how bad it is before what it says.
  assertStringIncludes(html, `data-sort="3 success"`);
  assertStringIncludes(html, `data-sort="92000"`);
  assertStringIncludes(html, `data-sort="${NOW - HOUR}"`);
  assertStringIncludes(html, "<table data-sortable>");
  for (const column of ["repository", "workflow", "trigger", "result", "ran for", "started", "age"]) {
    assertStringIncludes(html, `>${column}</button>`);
  }
  assertEquals(
    [...html.matchAll(/aria-sort="none"/g)].length,
    7,
    "a served page is sorted by nothing in particular",
  );
});

Deno.test("ci jobs page: a job with nothing to measure sorts apart from the measured", () => {
  const html = pageHtml(
    collection({
      jobs: [job({ status: "warn", result: "auth failed", startedAt: undefined, ranMs: undefined, event: undefined })],
    }),
    NOW,
  );

  assertEquals([...html.matchAll(/data-sort="-1"/g)].length, 3);
  assertStringIncludes(html, `data-sort=""`);
});

Deno.test("ci jobs page: every row links to its repository's page and to what GitHub has on its job", () => {
  const html = pageHtml(
    collection({
      jobs: [
        job({ href: "https://github.com/commonfabric/labs/actions/runs/1" }),
        job({
          repo: "gvisor",
          workflow: "CodeQL",
          status: "bad",
          failing: true,
          result: "failure",
          href: "https://github.com/commonfabric/gvisor/actions/runs/2",
        }),
        job({
          repo: "pond",
          workflow: "Preview",
          status: "unknown",
          result: "no completed run",
          startedAt: undefined,
          ranMs: undefined,
          href: "https://github.com/commonfabric/pond/actions/workflows/p.yml",
        }),
      ],
      unreadableRepos: ["commonfabric/crm"],
    }),
    NOW,
  );

  // Two links per row, whichever table the row is in, and none missing: the
  // repository's page in this tab, then GitHub in a new one.
  const rows = [
    ...html.matchAll(/<tr(?: data-served="[^"]*")?><td class="repo"[\s\S]*?<\/tr>/g),
  ]
    .map((match) => match[0]);
  assertEquals(rows.length, 4);
  for (const row of rows) {
    const links = [...row.matchAll(/<a href="([^"]*)"([^>]*)>/g)];
    assertEquals(links.length, 2, row);
    const [page, github] = links;
    assert(page[1].startsWith("/repos?name="), row);
    assert(!page[2].includes("target="), row);
    assert(github[1].startsWith("https://github.com/"), row);
    assertStringIncludes(github[2], `target="_blank"`);
  }
  assertEquals(
    rows.map((row) => row.match(/href="(\/repos[^"]*)"/)?.[1]),
    [
      "/repos?name=gvisor",
      "/repos?name=labs",
      "/repos?name=pond",
      "/repos?name=crm",
    ],
  );
  for (
    const href of [
      "https://github.com/commonfabric/labs/actions/runs/1",
      "https://github.com/commonfabric/gvisor/actions/runs/2",
      "https://github.com/commonfabric/pond/actions/workflows/p.yml",
      "https://github.com/commonfabric/crm/actions",
    ]
  ) {
    assertStringIncludes(html, `href="${href}" target="_blank"`);
  }
  // Drawn as a link, not as the text around it.
  assertStringIncludes(html, "td a{color:var(--accent)");
});

Deno.test("ci jobs page: nothing collected yet says so rather than showing an empty table", () => {
  const html = pageHtml(undefined, NOW);

  assertStringIncludes(html, "has not finished a collection yet");
  assert(!html.includes("<table>"));
});

Deno.test("ci jobs page: the tab's favicon wears the ci tile's color", () => {
  const iconOf = (collected: CiJobs | undefined) =>
    pageHtml(collected, NOW).match(/<link rel="icon"[^>]*href="([^"]*)"/)
      ?.[1];
  const failing = job({ workflow: "Lint", status: "bad", failing: true });

  assertEquals(ciJobsStatus(collection()), "good");
  assertEquals(iconOf(collection()), faviconHref("good"));
  assertEquals(
    ciJobsStatus(collection({ unreadableRepos: ["commonfabric/loom"] })),
    "warn",
  );
  assertEquals(ciJobsStatus(collection({ jobs: [job(), failing] })), "bad");
  assertEquals(
    iconOf(collection({ jobs: [job(), failing] })),
    faviconHref("bad"),
  );
  // A job with no verdict leaves the color to the others, and with no others
  // the favicon is empty.
  const silent = job({ status: "unknown" });
  assertEquals(ciJobsStatus(collection({ jobs: [silent, failing] })), "bad");
  assertEquals(ciJobsStatus(collection({ jobs: [silent] })), "unknown");
  assertEquals(iconOf(collection({ jobs: [silent] })), "data:,");
  assertEquals(iconOf(undefined), "data:,");
});

Deno.test("ci jobs page: the response is the page as HTML", async () => {
  const response = livePageResponse(ciJobsPage(collection(), NOW));

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertStringIncludes(await response.text(), "<title>CI jobs</title>");
  assertEquals(CI_JOBS_PATH, "/ci");
});

Deno.test("ci jobs page: the page is live, with everything it renders inside main", () => {
  const html = pageHtml(collection(), NOW);
  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));

  assertStringIncludes(html, `id="live-badge"`);
  assertStringIncludes(html, "/events?page=");
  assertStringIncludes(main, "collected 2026-09-22 14:28 UTC · 2m ago");
  assertStringIncludes(main, "<table data-sortable>");
  assertStringIncludes(main, `<tr data-served="3 labs CI .github/workflows/ci.yml">`);
  // The page's own script comes first, so it is listening for updates before
  // the page opens its stream.
  assert(html.indexOf("const sortTable") < html.indexOf("new EventSource"));
});

Deno.test("ci jobs page: each row carries the key it was served in order of", () => {
  // A job's key is its own, whatever the jobs around it are, and two
  // workflows one repository gives the same name have keys of their own.
  const html = pageHtml(
    collection({
      jobs: [
        job({ repo: "b", path: "a.yml" }),
        job({ repo: "a", path: "b.yml" }),
        job({ repo: "a", path: "a.yml" }),
        job({
          repo: "c",
          path: "a.yml",
          status: "bad",
          failing: true,
          result: "failure",
        }),
      ],
    }),
    NOW,
  );

  assertEquals(
    [...html.matchAll(/<tr data-served="([^"]*)">/g)].map((match) => match[1]),
    ["0 c CI a.yml", "3 a CI a.yml", "3 a CI b.yml", "3 b CI a.yml"],
  );
});

// The parts of a page the sorting functions use, over plain objects.
// `ci-jobs-page.browser.test.ts` runs the same functions against the page's
// own markup in a browser.
class FakeCell {
  constructor(
    readonly textContent: string,
    readonly sortKey?: string,
  ) {}

  getAttribute(name: string): string | null {
    return name === "data-sort" ? this.sortKey ?? null : null;
  }
}

class FakeRow {
  constructor(
    readonly name: string,
    readonly served: string,
    readonly cells: FakeCell[],
  ) {}

  getAttribute(name: string): string | null {
    return name === "data-served" ? this.served : null;
  }
}

class FakeBody {
  rows: FakeRow[] = [];

  appendChild(row: FakeRow): FakeRow {
    this.rows = [...this.rows.filter((other) => other !== row), row];
    return row;
  }
}

class FakeHeading {
  sort = "none";
  table: FakeTable | null = null;
  readonly #listeners: (() => void)[] = [];
  readonly parentElement = {
    setAttribute: (name: string, value: string) => {
      if (name === "aria-sort") this.sort = value;
    },
  };

  constructor(readonly column: number) {}

  getAttribute(name: string): string | null {
    return name === "data-column" ? String(this.column) : null;
  }

  addEventListener(_type: "click", listener: () => void): void {
    this.#listeners.push(listener);
  }

  closest(_selectors: "table"): FakeTable | null {
    return this.table;
  }

  click(): void {
    for (const listener of this.#listeners) listener();
  }
}

// A table of jobs with a name column that sorts on its text and a duration
// column that sorts on its key, in the order the page served them.
class FakeTable {
  readonly body = new FakeBody();
  tBodies = [this.body];
  headings = [new FakeHeading(0), new FakeHeading(1)];

  constructor(rows: [string, string][], readonly sortable = true) {
    this.body.rows = rows.map(([name, ms], served) =>
      new FakeRow(name, `${served} ${name}`, [
        new FakeCell(` ${name} `),
        new FakeCell("", ms),
      ])
    );
    for (const heading of this.headings) heading.table = this;
  }

  hasAttribute(name: string): boolean {
    return name === "data-sortable" && this.sortable;
  }

  querySelectorAll(selectors: string): FakeHeading[] {
    return selectors === "th button[data-column]" ? this.headings : [];
  }

  order(): string[] {
    return this.body.rows.map((row) => row.name);
  }

  marks(): string[] {
    return this.headings.map((heading) => heading.sort);
  }
}

// A page, or a rendering of one, holding `tables`.
class FakeRoot {
  constructor(readonly tables: FakeTable[]) {}

  querySelectorAll(_selectors: "table"): FakeTable[] {
    return this.tables;
  }
}

class FakePage extends FakeRoot {
  #update?: (event: { readonly detail: FakeRoot }) => void;

  addEventListener(
    _type: typeof LIVE_PAGE_UPDATE,
    listener: (event: { readonly detail: FakeRoot }) => void,
  ): void {
    this.#update = listener;
  }

  // What the live client does before it applies `rendering`.
  update(rendering: FakeRoot): void {
    this.#update!({ detail: rendering });
  }
}

Deno.test("ci jobs sorting: a column of numbers sorts as numbers, up then down", () => {
  const table = new FakeTable([["b", "200"], ["a", "9"], ["c", "40"]]);

  sortTable(table, { column: 1, descending: false });
  // As text, "200" would come before "40" and "9".
  assertEquals(table.order(), ["a", "c", "b"]);
  assertEquals(table.marks(), ["none", "ascending"]);

  sortTable(table, { column: 1, descending: true });
  assertEquals(table.order(), ["b", "c", "a"]);
  assertEquals(table.marks(), ["none", "descending"]);
});

Deno.test("ci jobs sorting: a cell with no key sorts on its text", () => {
  const table = new FakeTable([["zed", "1"], ["amp", "2"], ["loom", "3"]]);
  sortTable(table, { column: 0, descending: false });
  assertEquals(table.order(), ["amp", "loom", "zed"]);
});

Deno.test("ci jobs sorting: equal values keep the order the rows were served in", () => {
  const table = new FakeTable([["worst", "5"], ["middle", "5"], ["best", "1"]]);

  sortTable(table, { column: 1, descending: false });
  assertEquals(table.order(), ["best", "worst", "middle"]);
  sortTable(table, { column: 1, descending: true });
  assertEquals(table.order(), ["worst", "middle", "best"]);
  // Not the order the last sort left them in.
  sortTable(table, { column: 0, descending: true });
  sortTable(table, { column: 1, descending: false });
  assertEquals(table.order(), ["best", "worst", "middle"]);
});

Deno.test("ci jobs sorting: a table without a body is refused", () => {
  const table = new FakeTable([]);
  table.tBodies = [];
  assertThrows(
    () => sortTable(table, { column: 0, descending: false }),
    Error,
    "a sortable table has a body",
  );
});

Deno.test("ci jobs sorting: a heading sorts up on its first click and down on its next", () => {
  const table = new FakeTable([["b", "2"], ["a", "1"], ["c", "3"]]);
  followSorting(new FakePage([table]));

  table.headings[0].click();
  assertEquals(table.order(), ["a", "b", "c"]);
  assertEquals(table.marks(), ["ascending", "none"]);
  table.headings[0].click();
  assertEquals(table.order(), ["c", "b", "a"]);
  assertEquals(table.marks(), ["descending", "none"]);
});

Deno.test("ci jobs sorting: a new column starts ascending after one sorted descending", () => {
  const table = new FakeTable([["b", "2"], ["a", "1"]]);
  followSorting(new FakePage([table]));

  table.headings[0].click();
  table.headings[0].click();
  table.headings[1].click();
  assertEquals(table.marks(), ["none", "ascending"]);
  assertEquals(table.order(), ["a", "b"]);
});

Deno.test("ci jobs sorting: a table not marked sortable is left alone", () => {
  const table = new FakeTable([["b", "2"], ["a", "1"]], false);
  const page = new FakePage([table]);
  followSorting(page);

  table.headings[0].click();
  assertEquals(table.order(), ["b", "a"]);
  page.update(new FakeRoot([table]));
  assertEquals(table.order(), ["b", "a"]);
});

Deno.test("ci jobs sorting: a rendering arrives sorted the way the reader sorted the page", () => {
  const table = new FakeTable([["b", "2"], ["a", "1"]]);
  const page = new FakePage([table]);
  followSorting(page);
  table.headings[1].click();
  table.headings[1].click();

  const rendering = new FakeTable([["c", "3"], ["b", "2"], ["a", "1"], [
    "d",
    "4",
  ]]);
  page.update(new FakeRoot([rendering]));
  assertEquals(rendering.order(), ["d", "c", "b", "a"]);
  assertEquals(rendering.marks(), ["none", "descending"]);
});

Deno.test("ci jobs sorting: a rendering arriving before any sort stays as served", () => {
  const page = new FakePage([new FakeTable([["b", "2"], ["a", "1"]])]);
  followSorting(page);

  const rendering = new FakeTable([["b", "2"], ["a", "1"]]);
  page.update(new FakeRoot([rendering]));
  assertEquals(rendering.order(), ["b", "a"]);
  assertEquals(rendering.marks(), ["none", "none"]);
});

Deno.test("ci jobs sorting: a heading that arrived in a rendering sorts the table it was placed in", () => {
  const table = new FakeTable([["b", "2"], ["a", "1"]]);
  const page = new FakePage([table]);
  followSorting(page);

  // The rendering's headings replace the page's, and its table is dropped.
  const rendering = new FakeTable([["b", "2"], ["a", "1"]]);
  page.update(new FakeRoot([rendering]));
  table.headings = rendering.headings;
  for (const heading of table.headings) heading.table = table;

  table.headings[0].click();
  assertEquals(table.order(), ["a", "b"]);
  table.headings[0].click();
  assertEquals(table.order(), ["b", "a"]);
});
