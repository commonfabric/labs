/**
 * The page behind the ci tile. The tile carries one headline and the handful
 * of rows that fit under it; this is every job the tile read, at full width:
 * which repository and workflow it is, what its deciding run concluded, how
 * long that run took, and when it ran.
 *
 * It renders the tile's own last collection rather than asking GitHub again,
 * so opening it costs nothing and shows exactly what the tile is showing.
 * The heading says when that collection was, since the two are the same age.
 */

import { DETAIL_PAGE_STYLES } from "./detail-page.ts";
// From the render values rather than lib.ts, so the browser test that drives
// this page's own sorting can bundle it without the server-side half of the
// package coming with it.
import {
  compactSpan,
  escapeHtml,
  humanDuration,
  STATUS_DOT,
  STATUS_RANK,
} from "./tile-render-values.ts";
import { statusDotRules } from "./status-dot.ts";
import {
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  dashboardThemeToggle,
} from "./theme.ts";
import type { Status } from "./types.ts";

/** Where the page lives, and what the tile links to. */
export const CI_JOBS_PATH = "/ci";

/** One job the ci tile read, as both the tile and this page describe it. */
export interface Job {
  repo: string; // the repository's own name, without the owner
  workflow: string; // the workflow's name
  pinned: boolean; // kept in the tile's body even when it is passing
  // How the job reads: red for a failure somebody can still act on, orange for
  // one that has been failing too long to be news and for a job nothing could
  // be read for, gray for one with no verdict at all.
  status: Status;
  // Whether the deciding run failed, whatever age has done to the color.
  failing: boolean;
  // What decided the job: a run's conclusion, or why there is no verdict.
  result: string;
  // What started the deciding run, as GitHub names it: `push`, `schedule`,
  // `workflow_dispatch`, and the rest.
  event?: string;
  startedAt?: number; // when the deciding run started
  ranMs?: number; // how long it ran
  href: string; // the deciding run, or the workflow's own runs page
}

/** What one collection of the ci tile saw. */
export interface CiJobs {
  jobs: readonly Job[];
  repoCount: number;
  // Repositories whose workflow listing could not be read at all, so nothing
  // is known about the jobs behind them.
  unreadableRepos: readonly string[];
  collectedAt: number;
}

const STYLES = `
  ${DETAIL_PAGE_STYLES}
  .summary{display:flex;flex-wrap:wrap;gap:10px 34px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:4px}
  .summary div{display:flex;flex-direction:column;gap:2px}
  .summary dt{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-subtle)}
  .summary dd{margin:0;font-size:18px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
  /* The table keeps its own columns rather than shrinking them to nothing,
     so on a screen too narrow for all of them it scrolls inside this box and
     the page around it does not. */
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{text-align:left;font-weight:600;color:var(--text-subtle);font-size:11px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;padding:0 12px 5px 0}
  td{padding:5px 12px 5px 0;border-top:1px solid var(--divider);color:var(--text-secondary);vertical-align:top}
  td.measure{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text)}
  td.job{width:99%;word-break:break-word}
  /* Each row's way to GitHub, drawn as the dashboard draws a link so it reads
     as one: the job's run, the workflow's runs, or the repository's. */
  td a{color:var(--accent);text-decoration:none}
  td a:hover{text-decoration:underline}
  td.repo{white-space:nowrap;color:var(--text)}
  /* The same dot the dashboard uses, shape and all, so a reader who cannot
     tell the colors apart reads the shapes here too. */
  ${statusDotRules(9)}
  .dot{margin-right:7px;vertical-align:baseline}
  th button{font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;background:none;border:0;padding:0;cursor:pointer;display:inline-flex;align-items:baseline;gap:3px;white-space:nowrap}
  th button:hover{color:var(--text)}
  th button::after{content:"↕";opacity:.35;font-size:9px}
  th[aria-sort="ascending"] button::after{content:"↑";opacity:1}
  th[aria-sort="descending"] button::after{content:"↓";opacity:1}
  th[aria-sort="ascending"] button,th[aria-sort="descending"] button{color:var(--text)}
  /* The age says what the start time says, in far less room, so a narrow
     screen keeps the age and drops the timestamp rather than scrolling. */
  @media(max-width:760px){.at{display:none}}`;

/** An ISO 8601 time cut to the minute, which is the precision a reader wants. */
function minutePrecision(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// A cell the reader can sort by carries the value to sort on, since what it
// shows is written to be read: "17m 03s" and "6d ago" do not order as text.
function cell(className: string, text: string, sortKey?: string): string {
  const key = sortKey === undefined
    ? ""
    : ` data-sort="${escapeHtml(sortKey)}"`;
  return `<td class="${className}"${key}>${escapeHtml(text)}</td>`;
}

function jobRow(job: Job, now: number): string {
  const when = job.startedAt === undefined
    ? { at: "—", ago: "—" }
    : {
      at: minutePrecision(job.startedAt),
      ago: `${compactSpan(now - job.startedAt)} ago`,
    };
  // Worst first is the order the page opens in, so the result sorts on how bad
  // it is before it sorts on what it says.
  const severity = `${STATUS_RANK.bad - STATUS_RANK[job.status]} ${job.result}`;
  // A job with no measurement sorts to one end rather than among the measured.
  const missing = "-1";
  return `<tr><td class="repo" data-sort="${
    escapeHtml(job.repo)
  }"><span class="dot ${STATUS_DOT[job.status]}"></span>${
    escapeHtml(job.repo)
  }</td><td class="job" data-sort="${
    escapeHtml(job.workflow)
  }"><a href="${escapeHtml(job.href)}" target="_blank" rel="noopener">${
    escapeHtml(job.workflow)
  }</a></td>${cell("measure", job.event ?? "—", job.event ?? "")}${
    cell("measure", job.result, severity)
  }${
    cell(
      "measure",
      job.ranMs === undefined ? "—" : humanDuration(job.ranMs),
      job.ranMs === undefined ? missing : String(job.ranMs),
    )
  }${
    cell(
      "measure at",
      when.at,
      job.startedAt === undefined ? missing : String(job.startedAt),
    )
  }${
    cell(
      "measure",
      when.ago,
      job.startedAt === undefined ? missing : String(job.startedAt),
    )
  }</tr>`;
}

/** Worst first, and within one status by repository and then by workflow. */
function ordered(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) =>
    STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
    a.repo.localeCompare(b.repo) ||
    a.workflow.localeCompare(b.workflow)
  );
}

const JOB_COLUMNS = [
  "repository",
  "workflow",
  "trigger",
  "result",
  "ran for",
  "started",
  "age",
];

function jobHead(): string {
  return `<thead><tr>${
    JOB_COLUMNS.map((name, index) =>
      `<th${
        name === "started" ? ` class="at"` : ""
      } aria-sort="none"><button type="button" data-column="${index}">${name}</button></th>`
    ).join("")
  }</tr></thead>`;
}

/** The parts of a table cell `makeTableSortable()` reads. */
export interface SortableCell {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

/** The parts of a table row `makeTableSortable()` reads. */
export interface SortableRow {
  readonly cells: ArrayLike<SortableCell>;
}

/** The parts of a column heading's button `makeTableSortable()` uses. */
export interface SortableHeading {
  getAttribute(name: string): string | null;
  readonly parentElement: {
    setAttribute(name: string, value: string): void;
  } | null;
  addEventListener(type: "click", listener: () => void): void;
}

/** The parts of a table `makeTableSortable()` uses. */
export interface SortableTable<Row extends SortableRow> {
  readonly tBodies: ArrayLike<{
    readonly rows: ArrayLike<Row>;
    appendChild(row: Row): unknown;
  }>;
  querySelectorAll(selectors: string): ArrayLike<SortableHeading>;
}

/**
 * Makes `table` sortable by any of its columns, ascending on the first click
 * of a heading and descending on the next. A cell sorts on its `data-sort`,
 * or on its text when it has none, as a number when both sides read as one.
 * Each sort starts from the order the rows were in when this was called, so a
 * column of equal values keeps that order beneath it. It reads only the table
 * it is given, which the page hands it and a test can fake, and the page
 * carries it serialized.
 */
export function makeTableSortable<Row extends SortableRow>(
  table: SortableTable<Row>,
): void {
  const body = table.tBodies[0];
  if (body === undefined) throw new Error("a sortable table has a body");
  const served = Array.from(body.rows);
  const headings = Array.from(
    table.querySelectorAll("th button[data-column]"),
  );
  let sortedBy = -1;
  let descending = false;

  const keyOf = (row: Row, column: number): string => {
    const cell = row.cells[column];
    return cell.getAttribute("data-sort") ?? (cell.textContent ?? "").trim();
  };

  const sortBy = (column: number): void => {
    descending = sortedBy === column ? !descending : false;
    sortedBy = column;
    const rows = served.slice().sort((a, b) => {
      const left = keyOf(a, column);
      const right = keyOf(b, column);
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      const order = left !== "" && right !== "" &&
          Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : left.localeCompare(right);
      return descending ? -order : order;
    });
    for (const row of rows) body.appendChild(row);
    for (const heading of headings) {
      const own = Number(heading.getAttribute("data-column")) === column;
      heading.parentElement?.setAttribute(
        "aria-sort",
        own ? (descending ? "descending" : "ascending") : "none",
      );
    }
  };

  for (const heading of headings) {
    heading.addEventListener("click", () => {
      sortBy(Number(heading.getAttribute("data-column")));
    });
  }
}

function summary(collected: CiJobs): string {
  const count = (status: Status) =>
    collected.jobs.filter((job) => job.status === status).length;
  // A job is counted as failing however old its failure is, since age decides
  // the color of its row and not whether it is failing.
  const failing = collected.jobs.filter((job) => job.failing).length;
  const unreadable =
    collected.jobs.filter((job) => job.status === "warn" && !job.failing)
      .length + collected.unreadableRepos.length;
  const facts: Array<[string, string]> = [
    // The same count the tile's header carries: the jobs it speaks for.
    ["jobs", String(collected.jobs.length - count("unknown"))],
    ["repositories", String(collected.repoCount)],
    ["passing", String(count("good"))],
    ["failing", String(failing)],
    ["unreadable", String(unreadable)],
    ["no verdict", String(count("unknown"))],
  ];
  return `<dl class="summary">${
    facts.map(([term, value]) =>
      `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join("")
  }</dl>`;
}

function frame(head: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CI jobs</title>
${DASHBOARD_THEME_HEAD}
<style>
${STYLES}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>CI jobs</b><span>${head}</span></div>
  ${body}
${dashboardThemeToggle()}
${DASHBOARD_THEME_CLIENT}
<script>{const table = document.querySelector("table[data-sortable]"); if (table) (${makeTableSortable.toString()})(table);}</script>
</body></html>`;
}

/** The whole page for one collection, or the page saying there is not one. */
export function ciJobsPage(
  collected: CiJobs | undefined,
  now = Date.now(),
): string {
  if (collected === undefined) {
    return frame(
      "",
      `<p class="empty">The ci tile has not finished a collection yet. It reads every repository in the organization, which takes a few seconds, and this page shows what it last saw.</p>`,
    );
  }

  // A workflow with no run on the default branch has nothing to report in any
  // of the table's columns, and a workflow only a pull request triggers is
  // one of these. They go under the table rather than through it, where
  // thirteen rows of dashes would sit between the failures and everything
  // that passed.
  const judged = collected.jobs.filter((job) => job.status !== "unknown");
  const silent = ordered(collected.jobs.filter((job) => job.status === "unknown"));
  const rows = ordered(judged).map((job) => jobRow(job, now)).join("");
  const unjudged = silent.length === 0
    ? ""
    : `<h2>Workflows with no verdict · ${silent.length}</h2>
  <div class="scroll"><table><thead><tr><th>repository</th><th>workflow</th><th>why</th></tr></thead><tbody>${
      silent.map((job) =>
        `<tr><td class="repo"><span class="dot ${
          STATUS_DOT[job.status]
        }"></span>${escapeHtml(job.repo)}</td><td class="job"><a href="${
          escapeHtml(job.href)
        }" target="_blank" rel="noopener">${
          escapeHtml(job.workflow)
        }</a></td><td class="measure">${escapeHtml(job.result)}</td></tr>`
      ).join("")
    }</tbody></table></div>`;
  const unreadable = collected.unreadableRepos.length === 0
    ? ""
    : `<h2>Repositories that could not be read · ${collected.unreadableRepos.length}</h2>
  <div class="scroll"><table><thead><tr><th>repository</th></tr></thead><tbody>${
      collected.unreadableRepos.map((repo) =>
        `<tr><td class="repo"><span class="dot amber"></span><a href="https://github.com/${
          escapeHtml(repo)
        }/actions" target="_blank" rel="noopener">${
          escapeHtml(repo)
        }</a></td></tr>`
      ).join("")
    }</tbody></table></div>`;

  return frame(
    `collected ${minutePrecision(collected.collectedAt)} · ${
      escapeHtml(compactSpan(now - collected.collectedAt))
    } ago`,
    `${summary(collected)}
  <h2>Jobs · ${judged.length}</h2>
  <div class="scroll"><table data-sortable>${jobHead()}<tbody>${rows}</tbody></table></div>
  ${unjudged}
  ${unreadable}`,
  );
}

/** The page as the response the tile's route answers with. */
export function ciJobsResponse(
  collected: CiJobs | undefined,
  now?: number,
): Response {
  return new Response(ciJobsPage(collected, now), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
