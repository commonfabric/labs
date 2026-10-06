/**
 * The page behind the ci tile. The tile carries one headline and the handful
 * of rows that fit under it; this is every job the tile read, at full width:
 * which repository and workflow it is, what its deciding run concluded, how
 * long that run took, when it ran, and whether a run of it was going when the
 * tile last collected.
 *
 * It renders the tile's own last collection rather than asking GitHub again,
 * so opening it costs nothing and shows exactly what the tile is showing.
 * The heading says when that collection was, since the two are the same age.
 * The page is live (live-page.ts), so an open copy follows the tile's
 * collections, in whatever order the reader has sorted it.
 */

import type { LivePageContent } from "./live-page.ts";
import { LIVE_PAGE_UPDATE } from "./live-page-client.ts";
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
import type { Status } from "./types.ts";

/** Where the page lives, and what the tile links to. */
export const CI_JOBS_PATH = "/ci";

/** One job the ci tile read, as both the tile and this page describe it. */
export interface Job {
  repo: string; // the repository's own name, without the owner
  workflow: string; // the workflow's name
  // The workflow's file, which no other workflow in its repository shares.
  path: string;
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
  // The newest of the job's runs that is in progress, when one is.
  runningHref?: string;
}

/** A repository's own name, without the owner, as a `Job` names it. */
export function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

/** What one collection of the ci tile saw. */
export interface CiJobs {
  jobs: readonly Job[];
  // Every repository the collection read, by its own name without the owner.
  repos: readonly string[];
  // Repositories whose workflow listing could not be read at all, so nothing
  // is known about the jobs behind them.
  unreadableRepos: readonly string[];
  collectedAt: number;
}

const STYLES = `
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
  /* The running dot follows the workflow's name rather than leading the row. */
  td.job .dot{margin:0 0 0 7px}
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
export function minutePrecision(at: number): string {
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

/**
 * The workflow's name, linked to where `job` points, and after it a blue dot
 * linked to the run in progress, when one is.
 */
function workflowLink(job: Job): string {
  const running = job.runningHref === undefined
    ? ""
    : `<a class="dot run" href="${
      escapeHtml(job.runningHref)
    }" target="_blank" rel="noopener" title="running" aria-label="${
      escapeHtml(job.workflow)
    } running"></a>`;
  return `<a href="${escapeHtml(job.href)}" target="_blank" rel="noopener">${
    escapeHtml(job.workflow)
  }</a>${running}`;
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
  return `<tr data-served="${
    escapeHtml(servedKey(job))
  }"><td class="repo" data-sort="${
    escapeHtml(job.repo)
  }"><span class="dot ${STATUS_DOT[job.status]}"></span>${
    escapeHtml(job.repo)
  }</td><td class="job" data-sort="${escapeHtml(job.workflow)}">${
    workflowLink(job)
  }</td>${cell("measure", job.event ?? "—", job.event ?? "")}${
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

/**
 * A key for `job` that puts it where `ordered` does and that no other job
 * shares. A repository's name has no spaces in it. Each row carries its key,
 * which says nothing about the rows around it, so a row that has not changed
 * keeps its markup however the rows around it move.
 */
function servedKey(job: Job): string {
  const rank = STATUS_RANK.bad - STATUS_RANK[job.status];
  return `${rank} ${job.repo} ${job.workflow} ${job.path}`;
}

/** Worst first, and within one status by repository and then by workflow. */
function ordered(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => servedKey(a).localeCompare(servedKey(b)));
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

/** The parts of a table cell `sortTable()` reads. */
export interface SortableCell {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

/** The parts of a table row `sortTable()` reads. */
export interface SortableRow {
  getAttribute(name: string): string | null;
  readonly cells: ArrayLike<SortableCell>;
}

/** The parts of a column heading's button the sorting functions use. */
export interface SortableHeading<Row extends SortableRow> {
  getAttribute(name: string): string | null;
  readonly parentElement: {
    setAttribute(name: string, value: string): void;
  } | null;
  addEventListener(type: "click", listener: () => void): void;
  closest(selectors: "table"): SortableTable<Row> | null;
}

/** The parts of a table the sorting functions use. */
export interface SortableTable<Row extends SortableRow> {
  readonly tBodies: ArrayLike<{
    readonly rows: ArrayLike<Row>;
    appendChild(row: Row): unknown;
  }>;
  hasAttribute(name: string): boolean;
  querySelectorAll(selectors: string): ArrayLike<SortableHeading<Row>>;
}

/** The parts of a page, or of a rendering of it, `followSorting()` reads. */
export interface SortableRoot<Row extends SortableRow> {
  querySelectorAll(selectors: "table"): ArrayLike<SortableTable<Row>>;
}

/** The parts of a page `followSorting()` uses. */
export interface SortablePage<Row extends SortableRow>
  extends SortableRoot<Row> {
  addEventListener(
    type: typeof LIVE_PAGE_UPDATE,
    listener: (event: { readonly detail: SortableRoot<Row> }) => void,
  ): void;
}

/** The column a reader sorted a table by, and which way. */
export interface SortOrder {
  readonly column: number;
  readonly descending: boolean;
}

/**
 * Puts the rows of `table` in `order` and marks its headings to say so. A cell
 * sorts on its `data-sort`, or on its text when it has none, as a number when
 * both sides read as one. Rows the column holds equal go in the order the page
 * is served in, by the key each row carries as its `data-served`. It reads only
 * the table it is given, which the page hands it and a test can fake, and the
 * page carries it serialized.
 */
export function sortTable<Row extends SortableRow>(
  table: SortableTable<Row>,
  order: SortOrder,
): void {
  const body = table.tBodies[0];
  if (body === undefined) throw new Error("a sortable table has a body");
  const keyOf = (row: Row): string => {
    const cell = row.cells[order.column];
    return cell.getAttribute("data-sort") ?? (cell.textContent ?? "").trim();
  };
  const served = (row: Row) => row.getAttribute("data-served") ?? "";
  const rows = Array.from(body.rows).sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const compared = left !== "" && right !== "" &&
        Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? leftNumber - rightNumber
      : left.localeCompare(right);
    return (order.descending ? -compared : compared) ||
      served(a).localeCompare(served(b));
  });
  for (const row of rows) body.appendChild(row);
  const headings = table.querySelectorAll("th button[data-column]");
  for (const heading of Array.from(headings)) {
    const own = Number(heading.getAttribute("data-column")) === order.column;
    heading.parentElement?.setAttribute(
      "aria-sort",
      own ? (order.descending ? "descending" : "ascending") : "none",
    );
  }
}

/**
 * Sorts the sortable tables in `page` by a column when its heading is
 * clicked, ascending on the first click and descending on the next, and sorts
 * each fresh rendering of the page the same way before it is applied. The
 * rendering arrives in the order the page was served in, and sorted like the
 * page it compares equal wherever nothing changed, so those rows are kept.
 * Every heading on the page came either with the page or with a rendering, so
 * each is listened to as it arrives. It reads only the page it is given, which
 * a test can fake, and the page carries it serialized.
 */
export function followSorting<Row extends SortableRow>(
  page: SortablePage<Row>,
): void {
  let order: SortOrder | undefined;
  const listen = (root: SortableRoot<Row>): SortableTable<Row>[] => {
    const tables = Array.from(root.querySelectorAll("table"))
      .filter((table) => table.hasAttribute("data-sortable"));
    for (const table of tables) {
      const headings = table.querySelectorAll("th button[data-column]");
      for (const heading of Array.from(headings)) {
        heading.addEventListener("click", () => {
          const column = Number(heading.getAttribute("data-column"));
          order = {
            column,
            descending: order?.column === column && !order.descending,
          };
          // The heading may have arrived in a rendering and been placed in
          // the table the page already had.
          sortTable(heading.closest("table") ?? table, order);
        });
      }
    }
    return tables;
  };
  listen(page);
  page.addEventListener(LIVE_PAGE_UPDATE, (event) => {
    const tables = listen(event.detail);
    if (order === undefined) return;
    for (const table of tables) sortTable(table, order);
  });
}

/** The page's own script, which keeps its table sortable. */
export const CI_JOBS_SCRIPT = `
  const LIVE_PAGE_UPDATE = ${JSON.stringify(LIVE_PAGE_UPDATE)};
  const sortTable = ${sortTable.toString()};
  (${followSorting.toString()})(document);`;

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
    ["repositories", String(collected.repos.length)],
    ["passing", String(count("good"))],
    ["failing", String(failing)],
    ["unreadable", String(unreadable)],
    ["no verdict", String(count("unknown"))],
    [
      "running",
      String(
        collected.jobs.filter((job) => job.runningHref !== undefined).length,
      ),
    ],
  ];
  return `<dl class="summary">${
    facts.map(([term, value]) =>
      `<div><dt>${term}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join("")
  }</dl>`;
}

function content(head: string, body: string): LivePageContent {
  return {
    title: "CI jobs",
    styles: STYLES,
    head,
    body,
    script: CI_JOBS_SCRIPT,
  };
}

/** The page for one collection, or the page saying there is not one. */
export function ciJobsPage(
  collected: CiJobs | undefined,
  now = Date.now(),
): LivePageContent {
  if (collected === undefined) {
    return content(
      "",
      `<p class="empty">The ci tile has not finished a collection yet. It reads every repository in the organization, which takes a few seconds, and this page shows what it last saw.</p>`,
    );
  }

  // A workflow with no verdict has nothing to report in the table's trigger,
  // result, and timing columns, and a workflow only a pull request triggers is
  // one of these. They go under the table rather than through it, where
  // thirteen rows of dashes would sit between the failures and everything
  // that passed. One with a run in progress carries the running dot there as
  // it would in the table.
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
        }"></span>${escapeHtml(job.repo)}</td><td class="job">${
          workflowLink(job)
        }</td><td class="measure">${escapeHtml(job.result)}</td></tr>`
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

  return content(
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
