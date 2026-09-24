/**
 * The sorting the CI jobs page attaches to its table, exercised in a browser
 * against the page's own markup. The page is rendered by the same function
 * that serves it, so a column whose sort key stops being written reaches these
 * tests as a wrong order rather than passing quietly.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiJobs,
  ciJobsPage,
  type Job,
  makeTableSortable,
} from "./ci-jobs-page.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 22, 14, 30);

function job(over: Partial<Job> = {}): Job {
  return {
    repo: "labs",
    workflow: "CI",
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
  repoCount: 4,
  unreadableRepos: [],
  collectedAt: NOW,
};

// The page as the server writes it, with its own table wired for sorting.
function arrange(): HTMLElement {
  const previous = document.getElementById("ci-jobs-fixture");
  previous?.remove();
  const fixture = document.createElement("div");
  fixture.id = "ci-jobs-fixture";
  const html = ciJobsPage(collected, NOW);
  fixture.innerHTML = html.slice(html.indexOf("<body>") + 6);
  document.body.append(fixture);
  makeTableSortable<HTMLTableRowElement>(
    fixture.querySelector<HTMLTableElement>("table[data-sortable]")!,
  );
  return fixture;
}

function column(fixture: HTMLElement, index: number): string[] {
  const table = fixture.querySelector<HTMLTableElement>("table[data-sortable]")!;
  return [...table.tBodies[0].rows].map((row) =>
    (row.cells[index].textContent ?? "").trim()
  );
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
