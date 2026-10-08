/**
 * The sorting the CI jobs page attaches to its table, exercised in a browser
 * against the page's own markup and script. The page is rendered by the same
 * function that serves it, so a column whose sort key stops being written
 * reaches these tests as a wrong order rather than passing quietly.
 */

import { assert, assertEquals } from "@std/assert";
import {
  CI_JOBS_SCRIPT,
  type CiJobs,
  ciJobsPage,
  type Job,
} from "./ci-jobs-page.ts";
import { updateMain } from "./live-page-client.ts";

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
    ranMs: 17 * MINUTE,
    href: "https://example.com/run",
    ...over,
  };
}

const JOBS: Job[] = [
  job({ repo: "zed", workflow: "Nightly", event: "schedule", ranMs: MINUTE, startedAt: NOW - 3 * HOUR }),
  job({ repo: "amp", workflow: "Audit", event: "push", ranMs: 40 * MINUTE, startedAt: NOW - 90 * HOUR }),
  job({
    repo: "loom",
    workflow: "Tests",
    event: "workflow_dispatch",
    status: "bad",
    failing: true,
    result: "failure",
    ranMs: 9 * MINUTE,
    startedAt: NOW - 2 * HOUR,
  }),
  job({ repo: "bay", workflow: "Deploy", event: "schedule", ranMs: 200 * MINUTE, startedAt: NOW - 30 * HOUR }),
];

const collected: CiJobs = {
  jobs: JOBS,
  repos: ["zed", "amp", "loom", "bay"],
  unreadableRepos: [],
  collectedAt: NOW,
};

// The `<main>` the server renders for `jobs`.
function mainFor(jobs: CiJobs): HTMLElement {
  return new DOMParser().parseFromString(
    `<main>${ciJobsPage(jobs, NOW).body}</main>`,
    "text/html",
  ).querySelector("main")!;
}

// The page as the server writes it, running its own script with the fixture
// standing in for the document.
function arrange(): HTMLElement {
  const previous = document.getElementById("ci-jobs-fixture");
  previous?.remove();
  const fixture = document.createElement("div");
  fixture.id = "ci-jobs-fixture";
  fixture.append(mainFor(collected));
  document.body.append(fixture);
  new Function("document", CI_JOBS_SCRIPT)(fixture);
  return fixture;
}

// What the page's live client does with a fresh rendering of `jobs`.
function update(fixture: HTMLElement, jobs: CiJobs): void {
  updateMain<Element>(fixture.querySelector("main")!, mainFor(jobs));
}

function rows(fixture: HTMLElement): HTMLTableRowElement[] {
  const table = fixture.querySelector<HTMLTableElement>("table[data-sortable]")!;
  return [...table.tBodies[0].rows];
}

function column(fixture: HTMLElement, index: number): string[] {
  return rows(fixture).map((row) => (row.cells[index].textContent ?? "").trim());
}

function heading(fixture: HTMLElement, index: number): HTMLButtonElement {
  return fixture.querySelector<HTMLButtonElement>(
    `th button[data-column="${index}"]`,
  )!;
}

Deno.test("ci jobs sorting: the served order is worst first", () => {
  const fixture = arrange();
  assertEquals(column(fixture, 0), ["loom", "amp", "bay", "zed"]);
});

Deno.test("ci jobs sorting: a heading sorts up, then down", () => {
  const fixture = arrange();
  const repository = heading(fixture, 0);

  repository.click();
  assertEquals(column(fixture, 0), ["amp", "bay", "loom", "zed"]);
  assertEquals(repository.parentElement?.getAttribute("aria-sort"), "ascending");

  repository.click();
  assertEquals(column(fixture, 0), ["zed", "loom", "bay", "amp"]);
  assertEquals(repository.parentElement?.getAttribute("aria-sort"), "descending");
});

Deno.test("ci jobs sorting: duration sorts by the span, not by how it is spelled", () => {
  const fixture = arrange();
  // As text "1m 00s" sorts before "40m 00s" and "3h 20m" before both, which
  // is the wrong order twice over; the sort key is what puts them right.
  heading(fixture, 4).click();
  assertEquals(column(fixture, 4), ["1m 00s", "9m 00s", "40m 00s", "3h 20m"]);
  heading(fixture, 4).click();
  assertEquals(column(fixture, 4), ["3h 20m", "40m 00s", "9m 00s", "1m 00s"]);
});

Deno.test("ci jobs sorting: age and start sort on the same moment", () => {
  const fixture = arrange();
  heading(fixture, 5).click();
  const oldestFirst = ["amp", "bay", "zed", "loom"];
  assertEquals(column(fixture, 0), oldestFirst);

  const again = arrange();
  heading(again, 6).click();
  assertEquals(column(again, 0), oldestFirst);
});

Deno.test("ci jobs sorting: the result sorts on how bad it is, then on what it says", () => {
  const fixture = arrange();
  heading(fixture, 3).click();
  assertEquals(column(fixture, 3), ["failure", "success", "success", "success"]);
});

Deno.test("ci jobs sorting: the trigger separates cron runs from the rest", () => {
  const fixture = arrange();
  heading(fixture, 2).click();
  assertEquals(column(fixture, 2), [
    "push",
    "schedule",
    "schedule",
    "workflow_dispatch",
  ]);
});

Deno.test("ci jobs sorting: sorting one column clears the mark on the last", () => {
  const fixture = arrange();
  heading(fixture, 0).click();
  heading(fixture, 2).click();

  assertEquals(heading(fixture, 0).parentElement?.getAttribute("aria-sort"), "none");
  assertEquals(
    heading(fixture, 2).parentElement?.getAttribute("aria-sort"),
    "ascending",
  );
});

Deno.test("ci jobs sorting: equal values keep the order the page was served in", () => {
  const fixture = arrange();
  // Two jobs share a trigger, and the worst of them was served first.
  heading(fixture, 2).click();
  const repos = column(fixture, 0);
  assert(
    repos.indexOf("bay") < repos.indexOf("zed"),
    "the served order breaks the tie",
  );
});

Deno.test("ci jobs sorting: a live update keeps the reader's sort and the rows that did not change", () => {
  const fixture = arrange();
  const duration = heading(fixture, 4);
  duration.click();
  const before = rows(fixture);
  const link = before[2].cells[1].querySelector("a");

  // The amp job reran and took as long again.
  const rerun = "https://example.com/rerun";
  update(fixture, {
    ...collected,
    jobs: JOBS.map((job) => job.repo === "amp" ? { ...job, href: rerun } : job),
  });

  assertEquals(column(fixture, 4), ["1m 00s", "9m 00s", "40m 00s", "3h 20m"]);
  assertEquals(
    heading(fixture, 4).parentElement?.getAttribute("aria-sort"),
    "ascending",
  );
  // Every row is kept, and in the one that changed only the workflow's link
  // is replaced.
  const after = rows(fixture);
  after.forEach((row, index) => assert(row === before[index]));
  assertEquals(after[2].cells[0].textContent, "amp");
  assert(after[2].cells[0] === before[2].cells[0]);
  const relinked = after[2].cells[1].querySelector("a");
  assert(relinked !== link);
  assertEquals(relinked?.getAttribute("href"), rerun);

  // The heading still sorts, and knows which way it went last.
  heading(fixture, 4).click();
  assertEquals(column(fixture, 4), ["3h 20m", "40m 00s", "9m 00s", "1m 00s"]);
});

Deno.test("ci jobs sorting: a live update adding a job places it in the reader's sort", () => {
  const fixture = arrange();
  heading(fixture, 0).click();

  update(fixture, {
    ...collected,
    jobs: [...JOBS, job({ repo: "cat", workflow: "Lint" })],
  });

  assertEquals(column(fixture, 0), ["amp", "bay", "cat", "loom", "zed"]);
  assertEquals(
    heading(fixture, 0).parentElement?.getAttribute("aria-sort"),
    "ascending",
  );
});

Deno.test("ci jobs sorting: a live update to a page nobody sorted keeps the served order", () => {
  const fixture = arrange();

  update(fixture, {
    ...collected,
    jobs: [...JOBS, job({ repo: "cat", workflow: "Lint" })],
  });

  assertEquals(column(fixture, 0), ["loom", "amp", "bay", "cat", "zed"]);
});

Deno.test("ci jobs sorting: a live update that moves a job keeps every row that did not change", () => {
  const fixture = arrange();
  heading(fixture, 2).click();
  const before = new Map(rows(fixture).map((row) => [row.cells[0].textContent, row]));

  // The bay job fails, which moves it up the order the page is served in.
  update(fixture, {
    ...collected,
    jobs: JOBS.map((job) =>
      job.repo === "bay"
        ? { ...job, status: "bad", failing: true, result: "failure" }
        : job
    ),
  });

  assertEquals(column(fixture, 2), [
    "push",
    "schedule",
    "schedule",
    "workflow_dispatch",
  ]);
  assertEquals(column(fixture, 0), ["amp", "bay", "zed", "loom"]);
  for (const row of rows(fixture)) {
    const repo = row.cells[0].textContent;
    assertEquals(row === before.get(repo), repo !== "bay", `${repo} kept`);
  }
});

Deno.test("ci jobs sorting: a new column starts ascending after one sorted descending", () => {
  const fixture = arrange();
  heading(fixture, 0).click();
  heading(fixture, 0).click();
  heading(fixture, 4).click();

  assertEquals(
    heading(fixture, 4).parentElement?.getAttribute("aria-sort"),
    "ascending",
  );
  assertEquals(column(fixture, 4), ["1m 00s", "9m 00s", "40m 00s", "3h 20m"]);
});
