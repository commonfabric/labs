/**
 * The repository pages: one page for each repository the dashboard knows, and
 * an index of them all. A repository's page gathers everything the dashboard
 * has collected about it into one place. It opens on the repository's name,
 * set on the same status wash and texture a tile wears, with its standing, a
 * sentence about its main branch, and its key figures. Below that come what
 * needs attention, a chart and the latest runs of each of its workflow
 * snapshots, the tiles that report on it alone, and every job the ci tile read
 * in it.
 *
 * The pages render what the server already holds, the latest view of each
 * tile, the latest snapshot of each run source, and the ci tile's latest
 * collection, rather than asking GitHub again, so opening one costs no
 * requests and never disagrees with the dashboard. They are live
 * (live-page.ts), so an open page follows each collection as it lands.
 *
 * A repository is known once a tile names it, as the repository it reports on
 * or as the repository of one of its run sources, or once the ci tile's sweep
 * of the organization has read it. Each is known by its own name without the
 * owner, which is how the ci tile names a job's repository, so two
 * repositories of the same name under different owners share one page.
 */

import { tileContentRules } from "./chart-layout.ts";
import {
  CI_JOBS_PATH,
  type CiJobs,
  type Job,
  minutePrecision,
  shortName,
} from "./ci-jobs-page.ts";
import { LOOM_REPO, RECENT_DISPLAY, REPO, REPOS_PATH } from "./config.ts";
import { median, pullRequestLinks, runDurationMs } from "./lib.ts";
import { GREEN_STAR_RULES, greenStar, greenWords } from "./green-star.ts";
import { type LivePageContent, livePageResponse } from "./live-page.ts";
import { STATUS_EDGE, STATUS_WASH } from "./palette.ts";
import { textureRules } from "./render.ts";
import { statusDotRules } from "./status-dot.ts";
import { statusLayer } from "./theme.ts";
import { chartBody, newTab } from "./tile-render.ts";
import {
  compactSpan,
  escapeHtml,
  humanDuration,
  humanSpan,
  SPARKLINE_HEIGHT,
  STATUS_DOT,
  worstStatus,
} from "./tile-render-values.ts";
import { commitGanttHref, runOutcome } from "./tiles/recent-runs.ts";
import {
  type Route,
  type Run,
  type RunSource,
  runSourceKey,
  type Status,
  type Tile,
  type TileView,
} from "./types.ts";

/** What the server holds now, which the pages render. */
export interface Board {
  readonly tiles: readonly Tile[];
  /** The tile's latest view as the dashboard shows it, once it has one. */
  view(tile: Tile): TileView | undefined;
  /**
   * The latest snapshot of `source`'s runs, newest first, and why that
   * snapshot is missing or out of date when it is.
   */
  runs(source: RunSource): { runs: readonly Run[]; problem?: string };
}

/** Everything a page says about one repository. */
interface Repository {
  name: string; // without the owner, as the ci tile names it
  full: string; // "owner/name"
  jobs: readonly Job[];
  unreadable: boolean;
  measures: { tile: Tile; view: TileView | undefined }[];
  runs: { source: RunSource; runs: readonly Run[]; problem?: string }[];
}

const ORG = REPO.split("/")[0];

/** How many of a snapshot's newest runs a list under its chart names. */
const LATEST_RUNS = 3;

/** The share of a chart's runs that its scale's top reaches. */
const SCALE_PERCENTILE = 0.9;

/** The least a chart's scale reaches, as a multiple of its passing median. */
const MEDIAN_HEADROOM = 1.7;

const hrefOf = (name: string): string =>
  `${REPOS_PATH}?${new URLSearchParams({ name })}`;

const github = (repo: Repository): string =>
  `https://github.com/${escapeHtml(repo.full)}`;

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Every repository the board or the collection names, by name. */
function repositories(board: Board, jobs: CiJobs | undefined): Repository[] {
  const full = new Map<string, string>();
  const add = (name: string) => {
    if (!full.has(shortName(name))) {
      full.set(shortName(name), name.includes("/") ? name : `${ORG}/${name}`);
    }
  };
  for (const tile of board.tiles) {
    if (tile.repo !== undefined) add(tile.repo);
    for (const source of tile.runSources ?? []) add(source.repo);
  }
  for (const name of jobs?.repos ?? []) add(name);

  const sources = new Map<string, RunSource>();
  for (const tile of board.tiles) {
    for (const source of tile.runSources ?? []) {
      sources.set(runSourceKey(source), source);
    }
  }
  // Main before pull requests, and each by its workflow.
  const ordered = [...sources.values()].sort((a, b) =>
    (a.scope === "main" ? 0 : 1) - (b.scope === "main" ? 0 : 1) ||
    a.workflow.localeCompare(b.workflow)
  );
  return [...full].sort(([a], [b]) => a.localeCompare(b)).map((
    [name, repo],
  ) => ({
    name,
    full: repo,
    jobs: jobs?.jobs.filter((job) => job.repo === name) ?? [],
    unreadable: jobs?.unreadableRepos.some((full) => shortName(full) === name) ??
      false,
    measures: board.tiles.filter((tile) =>
      tile.repo !== undefined && shortName(tile.repo) === name
    ).map((tile) => ({ tile, view: board.view(tile) })),
    runs: ordered.filter((source) => shortName(source.repo) === name).map((
      source,
    ) => ({
      source,
      ...board.runs(source),
    })),
  }));
}

/** The jobs that count toward the repository's standing: those with a verdict. */
const judged = (repo: Repository) =>
  repo.jobs.filter((job) => job.status !== "unknown");

/**
 * How the repository stands: the worst of its jobs with a verdict and of its
 * measures, orange when its workflows could not be listed, and gray when
 * nothing about it has a color. A gray measure is left out, as the favicon
 * leaves out a gray tile, since a source that could not be read says nothing
 * about the repository; it is still listed among what needs attention.
 */
function standing(repo: Repository): Status {
  const statuses: Status[] = [
    ...judged(repo).map((job) => job.status),
    ...repo.measures.flatMap(({ view }) =>
      view === undefined || view.status === "unknown" ? [] : [view.status]
    ),
    ...(repo.unreadable ? ["warn" as const] : []),
  ];
  return statuses.length === 0 ? "unknown" : worstStatus(statuses);
}

const failingCount = (repo: Repository): number =>
  repo.jobs.filter((job) => job.failing).length;

/** The repository's standing in a word or two, which agrees with its color. */
function verdict(repo: Repository): string {
  const failing = failingCount(repo);
  if (failing > 0) return `${failing} failing`;
  const status = standing(repo);
  if (status === "warn" && repo.unreadable) return "Unreadable";
  return {
    good: "Passing",
    warn: "Worth watching",
    bad: "Needs attention",
    unknown: "No verdict",
  }[status];
}

/**
 * How a status orders in a list read worst first. Unknown comes last, which
 * puts the many repositories nothing is known about below every repository
 * that has a standing.
 */
const WORST_FIRST: Record<Status, number> = {
  bad: 0,
  warn: 1,
  good: 2,
  unknown: 3,
};

/** Where `repo` goes in a list read worst first: its standing, then failures. */
const rank = (repo: Repository): number =>
  WORST_FIRST[standing(repo)] * 1e6 - failingCount(repo);

/** Every run in progress across the repository, by its page on GitHub. */
function running(repo: Repository): Set<string> {
  return new Set([
    ...repo.jobs.flatMap((job) => job.runningHref ?? []),
    ...repo.runs.flatMap(({ runs }) =>
      runs.filter((run) => run.status === "in_progress").map((run) =>
        run.html_url
      )
    ),
  ]);
}

/** One thing that keeps the repository from standing well. */
interface Concern {
  status: Status;
  subject: string; // plain text
  detail: string; // trusted markup
  when?: string; // plain text
  href?: string;
}

/**
 * The things that keep the repository from standing well, worst first: each
 * job that is not passing, with how long ago its deciding run started, and
 * each measure that is not good, with its figure.
 */
function concerns(repo: Repository, now: number): Concern[] {
  const items: Concern[] = [
    ...(repo.unreadable
      ? [{
        status: "warn" as const,
        subject: "Workflows",
        detail: "could not be listed",
        href: `https://github.com/${repo.full}/actions`,
      }]
      : []),
    ...judged(repo).filter((job) => job.status !== "good").map((job) => ({
      status: job.status,
      subject: job.workflow,
      detail: escapeHtml(job.result),
      when: job.startedAt === undefined
        ? undefined
        : `${compactSpan(now - job.startedAt)} ago`,
      href: job.href,
    })),
    ...repo.measures.flatMap(({ tile, view }): Concern[] => {
      const status = view?.status ?? "unknown";
      if (status === "good") return [];
      const said = view === undefined ? "not collected yet" : view.sub ?? "";
      return [{
        status,
        subject: tile.label,
        detail: [
          view?.value === undefined ? "" : `<b>${view.value}</b>`,
          escapeHtml(said),
        ].filter((part) => part !== "").join(" · "),
        href: view?.href,
      }];
    }),
  ];
  return items.sort((a, b) => WORST_FIRST[a.status] - WORST_FIRST[b.status]);
}

// The wash and edge each status's surface takes, growing with the status as a
// tile's do. The page's own opening takes them for every status, as a tile
// does; a card among many takes them only for trouble, so that a page of
// passing cards stays quiet.
const surface = (selector: string, statuses: readonly Status[]): string =>
  statuses.map((status) =>
    `${selector}.${status}{border-color:${
      statusLayer(status, STATUS_EDGE[status])
    };background:${statusLayer(status, STATUS_WASH[status])}}`
  ).join("\n  ");

// The boxes that wear a status's surface and texture.
const CARDS = ["repo-card", "card"];

const STATUS_SURFACES = [
  surface(".hero", ["good", "warn", "bad"]),
  ...CARDS.map((card) => surface(`.${card}`, ["warn", "bad"])),
  surface(".wf", ["warn", "bad"]),
].join("\n  ");

const STATUS_TEXT = (["good", "warn", "bad", "unknown"] as const).map((
  status,
) => `.said-${status}{color:var(--status-${status}-text)}`).join("");

const STYLES = `
  ${tileContentRules(SPARKLINE_HEIGHT)}
  ${statusDotRules(9)}
  ${GREEN_STAR_RULES}
  ${textureRules(["hero", ...CARDS])}
  ${STATUS_SURFACES}
  ${STATUS_TEXT}
  body{max-width:1600px}
  .top span a{color:var(--accent);text-decoration:none}
  .top b a{color:inherit;text-decoration:none}.top b a:hover{color:var(--accent)}
  .switch select{font:inherit;font-size:12px;color:var(--text-secondary);background:var(--surface);border:1px solid var(--border-strong);border-radius:999px;padding:3px 10px;cursor:pointer}
  .switch select:hover{border-color:var(--border-hover);color:var(--text-strong)}
  /* A box that is a link reads as the box it is; a link in prose reads as
     a link. */
  .owner a,.concern,.bar,.latest .what a,.latest .result,.card,.wf a,.repo-card,.names a{color:inherit;text-decoration:none}
  .latest .took a,.lede a,h2 .meta a{color:var(--accent);text-decoration:none}
  h2{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font:600 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:0;color:var(--text);margin:18px 0 8px}
  h2 .meta{font-size:11px;font-weight:400;color:var(--text-muted)}
  .panel>:first-child,.panel>section:first-child>h2{margin-top:0}
  .problem{font-size:12px;color:var(--status-warn-text);margin:-4px 0 10px}
  .quiet{font-size:12px;color:var(--text-muted);margin:0}

  /* The opening of a repository's page: its name on its status's surface,
     its standing, and its key figures, in one band. */
  .hero{position:relative;isolation:isolate;overflow:hidden;background:var(--surface);border:1px solid var(--border-strong);border-radius:14px;padding:16px 22px;display:flex;flex-wrap:wrap;gap:14px 32px;align-items:center}
  .hero .standing{flex:1 1 28ch;min-width:0}
  .owner{display:flex;gap:14px;flex-wrap:wrap;margin:0;font-size:11px;color:var(--text-muted)}
  .owner a:hover{color:var(--accent)}
  .hero h1{font-size:38px;line-height:1.05;font-weight:650;letter-spacing:-.02em;margin:4px 0 0;overflow-wrap:anywhere}
  .standing-line{display:flex;align-items:center;gap:9px;margin:0;font-size:19px;font-weight:600}
  .standing-line .dot{width:12px;height:12px}
  .story{margin:5px 0 0;font-size:13px;line-height:1.45;color:var(--text-secondary)}
  .vitals{display:flex;gap:28px;margin:0}
  .vitals div{display:flex;flex-direction:column-reverse;gap:2px}
  .vitals dt{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);white-space:nowrap}
  .vitals dd{margin:0;font-size:24px;font-weight:600;line-height:1.1;color:var(--text)}
  .vitals dd small{font-size:13px;font-weight:500;color:var(--text-muted)}

  /* The panels between the opening and the measures. */
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 18px;min-width:0}

  /* What needs attention, one line each. */
  .concerns{list-style:none;margin:0 -18px;padding:0}
  .concerns li{border-top:1px solid var(--divider)}.concerns li:last-child{border-bottom:1px solid var(--divider)}
  .concern{display:grid;grid-template-columns:auto minmax(0,max-content) minmax(0,1fr) auto;align-items:baseline;gap:10px;padding:5px 18px;font-size:12px}
  a.concern:hover{background:var(--surface-deep)}
  .concern .subject{font-weight:600;color:var(--text)}
  .concern .detail{color:var(--text-secondary);min-width:0}
  .concern .detail b{font-weight:600;color:var(--text)}
  .concern .when{color:var(--text-muted);font-variant-numeric:tabular-nums}

  /* A snapshot's runs: a bar for each, as tall as the run took. */
  .runs section+section{margin-top:18px}
  .chart-frame{max-width:calc(var(--bars) * 24px + 64px);margin-left:auto}
  /* The top margin holds a star over the diamond of a failed run cut square. */
  .runs-chart{position:relative;height:96px;margin:24px 64px 0 0;border-bottom:1px solid var(--border-strong)}
  .bars{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:flex-end;gap:2px}
  .bar{flex:1 1 0;max-width:22px;min-width:2px;border-radius:4px 4px 0 0;position:relative;background:var(--status-unknown);opacity:.9;transition:opacity .1s}
  .bar:hover{opacity:1;outline:1px solid var(--text-muted);outline-offset:1px}
  .bar.green{background:var(--status-good)}.bar.red{background:var(--status-bad)}.bar.run{background:var(--running);opacity:.6}
  .bar.over{border-radius:0}
  .bar.red::after{content:"";position:absolute;left:50%;top:-10px;width:7px;height:7px;transform:translateX(-50%);background:var(--status-bad);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
  /* A star stands over its bar, and over the diamond of a failed run. */
  .bar span.green-star{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%);margin:0;font-size:11px}
  .bar.red span.green-star{bottom:calc(100% + 12px)}
  .median{position:absolute;left:0;right:0;border-top:1px dashed var(--text-faint);pointer-events:none}
  .median span{position:absolute;left:100%;top:0;transform:translateY(-50%);margin-left:10px;font-size:10px;line-height:1.25;color:var(--text-muted);white-space:nowrap}
  .chart-foot{margin-right:64px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:5px;font-size:10px;color:var(--text-muted)}
  .legend{display:flex;gap:12px}.legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .key{width:8px;height:8px;border-radius:2px;background:var(--status-unknown)}
  .key.green{background:var(--status-good)}.key.red{background:var(--status-bad)}.key.run{background:var(--running)}
  .latest{list-style:none;margin:8px 0 0;padding:0}
  .latest li{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;align-items:baseline;gap:10px;padding:4px 0;border-top:1px solid var(--divider);font-size:12px}
  .latest .what{color:var(--text);overflow:clip;overflow-clip-margin:3px;text-overflow:ellipsis;white-space:nowrap}
  .latest .what:has(:focus-visible){white-space:normal}
  .latest .what .pr{color:var(--accent)}.latest .what .pr:hover{text-decoration:underline}
  .latest .what a:hover,.latest .took a:hover{color:var(--accent)}
  .latest .result{color:var(--text-muted)}
  .latest .took,.latest time{color:var(--text-muted);font-variant-numeric:tabular-nums;text-align:right}
  .latest time{min-width:40px}

  /* The workflows, two to a line. */
  .wfs{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px 6px}
  .wf{display:flex;align-items:center;gap:7px;padding:3px 8px;border:1px solid transparent;border-radius:7px;font-size:12px;min-width:0}
  .wf a{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
  .wf a:hover{color:var(--accent)}
  .wf .going{flex:none;display:inline-flex}
  .wf .age{margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums}
  .wf.unknown{flex-wrap:wrap;row-gap:0}
  .wf.unknown a{color:var(--text-muted)}
  .wf .why{flex-basis:100%;padding-left:16px;font-size:11px;color:var(--text-faint)}

  /* The measures: every tile that reports on the repository alone, in a row. */
  .measures{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
  .card{position:relative;isolation:isolate;overflow:hidden;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:11px 13px;min-width:0}
  a.card:hover{border-color:var(--border-hover)}
  .card .lbl{font-size:10px;margin-bottom:4px}
  /* A card's headline shrinks with the card, so a narrow one still says it
     whole. */
  .card{container-type:inline-size}
  .card .big{font-size:clamp(14px,16cqi,20px)}
  .card .sub{font-size:11px;white-space:normal;margin-top:3px}
  .card .card-plot{margin-top:auto;padding-top:2px}

  /* On a screen large enough, the page is one screen: the parts are laid on
     a grid as tall as the window, and a panel with more than its room
     scrolls within itself. */
  .screen{display:flex;flex-direction:column;gap:12px}
  @media(min-width:1000px) and (min-height:620px){
    /* The page is as tall as the window, and the grid takes what its heading
       and the theme switch under it leave. The middle row keeps a floor, so
       a window too short for it scrolls rather than crushing the runs. */
    body{height:100dvh;display:flex;flex-direction:column}
    main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
    .screen{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);grid-template-rows:auto minmax(280px,1fr) auto}
    .hero,.measures{grid-column:1/-1}
    /* The measures keep to one row, however many there are. */
    .measures{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(0,260px)}
    .panel{min-height:0;overflow:auto}
    /* Each source's chart takes what room its share of the panel has, so a
       tall screen draws taller bars rather than leaving the panel empty. */
    .runs{display:flex;flex-direction:column;gap:18px}
    .runs section{flex:1 1 0;display:flex;flex-direction:column}
    .runs section+section{margin-top:0}
    .chart-frame{flex:1 1 auto;display:flex;flex-direction:column;width:100%;min-height:0;max-height:260px}
    .runs-chart{flex:1 1 auto;height:auto;min-height:48px}
  }

  /* The index: a card for each repository in trouble, and a name for each
     of the rest. */
  .lede{font-size:15px;color:var(--text-secondary);margin:4px 0 0}
  .repo-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
  .repo-card{position:relative;isolation:isolate;overflow:hidden;display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
  a.repo-card:hover{border-color:var(--border-hover)}
  .repo-card .rc-name{display:flex;align-items:center;gap:9px;font-size:18px;font-weight:600;color:var(--text)}
  .repo-card .rc-word{font-size:13px;font-weight:600;margin-top:2px}
  .repo-card .rc-worst{font-size:12px;color:var(--text-secondary)}
  .repo-card .rc-worst b{font-weight:600}
  .repo-card .rc-facts{font-size:12px;color:var(--text-muted)}
  .names{display:flex;flex-wrap:wrap;gap:8px}
  .names a{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--text-secondary);background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:5px 12px}
  .names a:hover{border-color:var(--border-hover);color:var(--text-strong)}
  .names.quiet-names a{background:transparent;font-size:12px;padding:3px 10px}
  @media(max-width:700px){.hero{padding:16px}.hero h1{font-size:32px}.vitals{flex-wrap:wrap;gap:14px 24px}.concern{grid-template-columns:auto minmax(0,1fr) auto}.concern .detail{grid-column:2/-1;grid-row:2}.latest li{grid-template-columns:auto minmax(0,1fr) auto}.latest .result,.latest .took{display:none}.runs-chart,.chart-foot{margin-right:44px}.chart-foot .legend{order:3;flex-basis:100%;flex-wrap:wrap;gap:4px 12px}}`;

// Moving to another repository is choosing it. The listener is on the
// document, so a switch that arrives with a rendering works as well.
const SCRIPT = `
  document.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-repo-switch]');
    if (select) location.href = select.value;
  });`;

function switcher(repos: readonly Repository[], current?: string): string {
  const options = repos.map((repo) =>
    `<option value="${escapeHtml(hrefOf(repo.name))}"${
      repo.name === current ? " selected" : ""
    }>${escapeHtml(repo.name)}</option>`
  ).join("");
  return `<label class="switch"><select data-repo-switch aria-label="Repository">${
    current === undefined
      ? `<option selected disabled>Go to a repository…</option>`
      : ""
  }${options}</select></label>`;
}

const dot = (status: Status): string =>
  `<span class="dot ${STATUS_DOT[status]}"></span>`;

/**
 * The newest finished run on main, in a sentence, when there is a main whose
 * runs are up to date.
 */
function mainStory(repo: Repository, now: number): string | undefined {
  const main = repo.runs.find(({ source }) => source.scope === "main");
  if (main === undefined || main.problem !== undefined) return undefined;
  const last = main.runs.find((run) => run.status === "completed");
  if (last === undefined) return undefined;
  const ago = `${humanSpan(now - Date.parse(last.updated_at))} ago`;
  const going = main.runs[0]?.status === "in_progress"
    ? " Another is running now."
    : "";
  const said = last.conclusion === "success"
    ? "passed"
    : last.conclusion === null
    ? "finished"
    : ["failure", "timed_out", "startup_failure"].includes(last.conclusion)
    ? "failed"
    : `was ${last.conclusion.replaceAll("_", " ")}`;
  return `The newest finished run on main ${said} ${ago}.${going}`;
}

/** The repository's name, standing, main branch, and key figures. */
function hero(
  repo: Repository,
  jobs: CiJobs | undefined,
  now: number,
): string {
  const status = standing(repo);
  const failing = failingCount(repo);
  const verdicts = judged(repo);
  const story = [
    mainStory(repo, now),
    jobs === undefined
      ? "Its workflows have not been read yet."
      : repo.unreadable
      ? "Its workflows could not be listed."
      : repo.jobs.length === 0
      ? "It has no active workflows."
      : undefined,
  ].filter((line) => line !== undefined).join(" ");
  const main = repo.runs.find(({ source }) => source.scope === "main");
  const mainMedian = main === undefined
    ? undefined
    : passedMedian(main.runs.slice(0, RECENT_DISPLAY), now);
  const vitals: Array<[string, string]> = [
    ...(verdicts.length === 0 ? [] : [
      [
        "workflows passing",
        `${verdicts.filter((job) => job.status === "good").length}<small> of ${verdicts.length}</small>`,
      ] as [string, string],
      ["failing", String(failing)] as [string, string],
    ]),
    ["running now", String(running(repo).size)],
    ...(mainMedian === undefined ? [] : [
      ["main run, median", compactSpan(mainMedian)] as [string, string],
    ]),
  ];
  return `<header class="hero ${status}"><div class="texture"></div><div class="named">
    <p class="owner"><a href="${github(repo)}" target="_blank" rel="noopener">${
    escapeHtml(repo.full)
  } ↗</a><a href="${github(repo)}/pulls" target="_blank" rel="noopener">pull requests ↗</a><a href="${
    github(repo)
  }/actions" target="_blank" rel="noopener">actions ↗</a>${
    jobs === undefined
      ? ""
      : `<span>workflows read ${
        escapeHtml(compactSpan(now - jobs.collectedAt))
      } ago</span>`
  }</p>
    <h1>${escapeHtml(repo.name)}</h1>
  </div><div class="standing"><p class="standing-line said-${status}">${
    dot(status)
  }${escapeHtml(verdict(repo))}</p>
    ${story === "" ? "" : `<p class="story">${escapeHtml(story)}</p>`}
  </div><dl class="vitals">${
    vitals.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
      .join("")
  }</dl></header>`;
}

/**
 * What needs attention, as a section that is there whether or not anything
 * does, so the panel holding it keeps its shape, and its reader's scroll
 * position, from one rendering to the next.
 */
function concernList(items: readonly Concern[]): string {
  if (items.length === 0) {
    return `<section><h2>Needs attention</h2><p class="quiet">Nothing needs attention.</p></section>`;
  }
  return `<section><h2>Needs attention <span class="meta">${items.length}</span></h2>
  <ul class="concerns">${
    items.map((item) => {
      const body = `${dot(item.status)}<span class="subject">${
        escapeHtml(item.subject)
      }</span><span class="detail">${item.detail}</span><span class="when">${
        escapeHtml(item.when ?? "")
      }</span>`;
      return `<li>${
        item.href === undefined
          ? `<div class="concern">${body}</div>`
          : `<a class="concern" href="${escapeHtml(item.href)}"${
            newTab(item.href)
          }>${body}</a>`
      }</li>`;
    }).join("")
  }</ul></section>`;
}

/** How long `run` has taken so far, or took. */
const tookMs = (run: Run, now: number): number | undefined =>
  run.status === "in_progress"
    ? now - Date.parse(run.run_started_at)
    : runDurationMs(run);

/** The median time of those of `runs` that passed, when any did. */
function passedMedian(runs: readonly Run[], now: number): number | undefined {
  const passed = runs.filter((run) => run.conclusion === "success")
    .flatMap((run) => tookMs(run, now) ?? []);
  return passed.length === 0 ? undefined : median(passed);
}

/** The line a run is named by: the change it tested, or its pull request. */
const runTitle = (run: Run, source: RunSource): string =>
  source.scope === "main"
    ? (run.head_commit?.message ?? run.display_title).split("\n", 1)[0]
    : run.display_title;

/**
 * A bar for each of the newest runs, oldest on the left, each as tall as the
 * run took and colored by what it concluded, with the median of the runs
 * that passed drawn across and named in the gutter to its right. The scale's
 * top is the longest run but one in ten, so a single run that hung does not
 * flatten the rest, and at least MEDIAN_HEADROOM times the median, so the
 * runs around it keep room to differ; a bar past the top is cut square. A
 * star stands over a bar whose commit the repository's green branch is or
 * was at. Each bar links to its run for a pointer, and the keyboard passes
 * over it, since the list under the chart links the newest runs and the
 * section's heading links every run on GitHub.
 */
function runsChart(shown: readonly Run[], source: RunSource, now: number) {
  const took = shown.map((run) => tookMs(run, now) ?? 0);
  const sorted = [...took].sort((a, b) => a - b);
  const middle = passedMedian(shown, now);
  const top = Math.max(
    sorted[Math.floor((sorted.length - 1) * SCALE_PERCENTILE)] ?? 0,
    (middle ?? 0) * MEDIAN_HEADROOM,
  );
  if (top <= 0) return "";
  const bars = shown.map((run, index) => ({ run, took: took[index] }))
    .reverse().map(({ run, took }) => {
      const { dot, text } = runOutcome(run);
      const height = Math.max(4, Math.min(100, (took / top) * 100));
      const title = [
        `${runTitle(run, source)} — ${text}`,
        humanDuration(took),
        `${compactSpan(now - Date.parse(run.run_started_at))} ago`,
        ...(run.green === undefined ? [] : [greenWords(run.green)]),
      ].join(" · ");
      return `<a class="bar ${dot}${
        took > top ? " over" : ""
      }" style="height:${height.toFixed(1)}%" href="${
        escapeHtml(run.html_url)
      }" target="_blank" rel="noopener" tabindex="-1" title="${
        escapeHtml(title)
      }">${greenStar(run.green)}</a>`;
    }).join("");
  const line = middle === undefined ? "" : `<div class="median" style="bottom:${
    ((middle / top) * 100).toFixed(1)
  }%"><span>median<br>${escapeHtml(compactSpan(middle))}</span></div>`;
  const present = new Set(shown.map((run) => runOutcome(run).dot));
  const keys = [
    ["green", "passed"],
    ["red", "failed"],
    ["gray", "cancelled or retried"],
    ["run", "running"],
  ].filter(([key]) => present.has(key)).map(([key, words]) =>
    `<span><i class="key ${key}"></i>${words}</span>`
  ).join("");
  const age = (run: Run) =>
    escapeHtml(`${compactSpan(now - Date.parse(run.run_started_at))} ago`);
  // The frame is only as wide as its bars, so the ages under it stand under
  // the oldest bar and the newest.
  return `<div class="chart-frame" style="--bars:${shown.length}"><div class="runs-chart" role="img" aria-label="${
    escapeHtml(
      `${shown.length} runs, each as tall as it took${
        middle === undefined ? "" : `; median ${humanDuration(middle)}`
      }`,
    )
  }"><div class="bars">${bars}</div>${line}</div>
  <div class="chart-foot"><span>${
    age(shown[shown.length - 1])
  }</span><span class="legend">${keys}</span><span>${
    age(shown[0])
  }</span></div></div>`;
}

function latestRow(
  run: Run,
  source: RunSource,
  all: readonly Run[],
  now: number,
): string {
  const { dot, text } = runOutcome(run);
  const title = runTitle(run, source);
  const took = tookMs(run, now);
  // The commit Gantt charts the labs and loom runs alone.
  const gantt = source.repo === REPO || source.repo === LOOM_REPO
    ? commitGanttHref(run, all)
    : null;
  const duration = took === undefined
    ? ""
    : gantt === null
    ? humanDuration(took)
    : `<a href="${escapeHtml(gantt)}" title="CI Gantt for ${
      escapeHtml(run.head_sha.slice(0, 7))
    }">${humanDuration(took)}</a>`;
  const started = Date.parse(run.run_started_at);
  return `<li><span class="dot ${dot}"></span><span class="what">${
    greenStar(run.green)
  }${pullRequestLinks(title, source.repo, run.html_url)}</span><a class="result" href="${
    escapeHtml(run.html_url)
  }" target="_blank" rel="noopener">${
    escapeHtml(text)
  }</a><span class="took">${duration}</span><time title="${
    Number.isFinite(started) ? minutePrecision(started) : ""
  }">${
    Number.isFinite(started) ? `${compactSpan(now - started)} ago` : ""
  }</time></li>`;
}

function runSection(
  { source, runs, problem }: Repository["runs"][number],
  now: number,
): string {
  const heading = source.scope === "main" ? "Main branch" : "Pull requests";
  const shown = runs.slice(0, RECENT_DISPLAY);
  const finished = shown.filter((run) => run.status === "completed");
  const passed = finished.filter((run) => run.conclusion === "success").length;
  const going = shown.filter((run) => run.status === "in_progress").length;
  // Every run of the source, not only those charted, on GitHub.
  const history = `https://github.com/${source.repo}/actions/workflows/${
    encodeURIComponent(source.workflow)
  }?${new URLSearchParams({
    query: source.scope === "main" ? "branch:main" : "event:pull_request",
  })}`;
  const meta = [
    `<a href="${escapeHtml(history)}" target="_blank" rel="noopener">${
      escapeHtml(source.workflow)
    } ↗</a>`,
    shown.length === 0 ? "" : `last ${plural(shown.length, "run")}`,
    finished.length === 0 ? "" : `${passed} of ${finished.length} passed`,
    going === 0 ? "" : `${going} running`,
  ].filter((part) => part !== "").join(" · ");
  const note = problem === undefined
    ? ""
    : problem === "pending"
    ? `<p class="quiet">The runs have not been read yet.</p>`
    : `<p class="problem">${
      escapeHtml(
        `The runs could not be brought up to date: ${problem}. These are the last ones read.`,
      )
    }</p>`;
  return `<section data-focus-key="${escapeHtml(runSourceKey(source))}">
  <h2>${heading} <span class="meta">${meta}</span></h2>${note}${
    shown.length === 0 ? "" : `${runsChart(shown, source, now)}
  <ol class="latest">${
      shown.slice(0, LATEST_RUNS).map((run) =>
        latestRow(run, source, runs, now)
      ).join("")
    }</ol>`
  }</section>`;
}

/** One tile's view, as a card among the repository's measures. */
function measureCard({ tile, view }: Repository["measures"][number]): string {
  const status = view?.status ?? "unknown";
  const hint = view?.href === undefined
    ? ""
    : `<span class="drill" aria-hidden="true">↗</span>`;
  const inner = `<div class="texture"></div><p class="lbl">${dot(status)} ${
    escapeHtml(tile.label)
  }<span class="spacer"></span>${view?.aside ?? ""}${hint}</p><p class="big said-${status}">${
    view?.value ?? "—"
  }</p><p class="sub">${
    escapeHtml(view === undefined ? "not collected yet" : view.sub ?? "")
  }</p><div class="card-plot">${
    view === undefined ? "" : chartBody(view)
  }</div>`;
  return view?.href === undefined
    ? `<div class="card ${status}" data-focus-key="${escapeHtml(tile.label)}">${inner}</div>`
    : `<a class="card ${status}" data-focus-key="${escapeHtml(tile.label)}" href="${
      escapeHtml(view.href)
    }"${newTab(view.href)}>${inner}</a>`;
}

/**
 * One job, as a line naming it and saying how long ago its deciding run
 * started, or, for one with no verdict, why. What started that run, what it
 * concluded, and how long it ran are its tooltip; a job that is not passing
 * says what its run concluded among what needs attention as well.
 */
function jobRow(job: Job, now: number): string {
  const said = job.status === "unknown" ? [job.result] : [
    job.event ?? "",
    job.result,
    job.ranMs === undefined ? "" : `ran ${humanDuration(job.ranMs)}`,
    job.startedAt === undefined ? "" : `${compactSpan(now - job.startedAt)} ago`,
  ];
  const going = job.runningHref === undefined
    ? ""
    : `<a class="going" href="${
      escapeHtml(job.runningHref)
    }" target="_blank" rel="noopener" title="running" aria-label="${
      escapeHtml(job.workflow)
    } running"><span class="dot run"></span></a>`;
  // A job with no verdict says why on a line of its own.
  const when = job.status === "unknown"
    ? `<span class="why">${escapeHtml(job.result)}</span>`
    : `<span class="age">${
      job.startedAt === undefined ? "" : compactSpan(now - job.startedAt)
    }</span>`;
  return `<li class="wf ${job.status}">${dot(job.status)}<a href="${
    escapeHtml(job.href)
  }" target="_blank" rel="noopener" title="${
    escapeHtml(said.filter((fact) => fact !== "").join(" · "))
  }">${escapeHtml(job.workflow)}</a>${going}${when}</li>`;
}

function workflowSection(
  repo: Repository,
  jobs: CiJobs | undefined,
  now: number,
): string {
  if (jobs === undefined) {
    return `<h2>Workflows</h2><p class="quiet">The ci tile has not finished reading the organization yet. This fills in once it has.</p>`;
  }
  if (repo.unreadable) {
    return `<h2>Workflows</h2><p class="quiet">The workflows of this repository could not be listed.</p>`;
  }
  if (repo.jobs.length === 0) {
    return `<h2>Workflows</h2><p class="quiet">The repository has no active workflows.</p>`;
  }
  const count = (status: Status) =>
    repo.jobs.filter((job) => job.status === status).length;
  const meta = [
    `${count("good")} passing`,
    `${failingCount(repo)} failing`,
    count("unknown") === 0 ? "" : `${count("unknown")} with no verdict`,
  ].filter((part) => part !== "").join(" · ");
  // Worst first, then by name; those with no verdict go last.
  const ordered = [...repo.jobs].sort((a, b) =>
    WORST_FIRST[a.status] - WORST_FIRST[b.status] ||
    a.workflow.localeCompare(b.workflow)
  );
  return `<h2>Workflows <span class="meta">${meta} · <a href="${CI_JOBS_PATH}">every job ↗</a></span></h2>
  <ul class="wfs">${ordered.map((job) => jobRow(job, now)).join("")}</ul>`;
}

function repositoryBody(
  repo: Repository,
  jobs: CiJobs | undefined,
  now: number,
): string {
  const measures = repo.measures.length === 0
    ? ""
    : `<div class="measures">${repo.measures.map(measureCard).join("")}</div>`;
  // On a screen large enough, the page is one screen: the opening across the
  // top, the runs on the left, what needs attention and the workflows on the
  // right, and the measures across the foot. A part with more than its room
  // holds scrolls within itself.
  return `<div class="screen">${hero(repo, jobs, now)}
  <div class="panel runs">${
    repo.runs.length === 0
      ? `<h2>Runs</h2><p class="quiet">No tile follows this repository's runs.</p>`
      : repo.runs.map((runs) => runSection(runs, now)).join("")
  }</div>
  <div class="panel side">${concernList(concerns(repo, now))}<section>${
    workflowSection(repo, jobs, now)
  }</section></div>
  ${measures}</div>`;
}

/**
 * A repository in trouble, as a card on the index naming its standing and the
 * worst thing wrong with it.
 */
function repoCard(repo: Repository, now: number): string {
  const status = standing(repo);
  const going = running(repo).size;
  const facts = [
    plural(repo.jobs.length, "workflow"),
    going === 0 ? "" : `${going} running`,
    repo.measures.length === 0 ? "" : plural(repo.measures.length, "measure"),
  ].filter((fact) => fact !== "").join(" · ");
  const worst = concerns(repo, now)[0];
  const trouble = `<span class="rc-word said-${status}">${
    escapeHtml(verdict(repo))
  }</span>${
    worst === undefined
      ? ""
      : `<span class="rc-worst">${escapeHtml(worst.subject)} · ${worst.detail}</span>`
  }`;
  return `<a class="repo-card ${status}" href="${
    escapeHtml(hrefOf(repo.name))
  }"><div class="texture"></div><span class="rc-name">${dot(status)}${
    escapeHtml(repo.name)
  }</span>${trouble}<span class="rc-facts">${escapeHtml(facts)}</span></a>`;
}

function indexBody(repos: readonly Repository[], now: number): string {
  const ordered = [...repos].sort((a, b) => rank(a) - rank(b));
  const troubled = ordered.filter((repo) =>
    standing(repo) === "bad" || standing(repo) === "warn"
  );
  const passing = ordered.filter((repo) => standing(repo) === "good");
  const quiet = ordered.filter((repo) => standing(repo) === "unknown");
  const lede = `${plural(repos.length, "repository", "repositories")}. ${
    troubled.length === 0
      ? "None needs"
      : `${troubled.length} ${troubled.length === 1 ? "needs" : "need"}`
  } attention, ${passing.length} ${
    passing.length === 1 ? "is" : "are"
  } passing, and ${quiet.length} ${
    quiet.length === 1 ? "has" : "have"
  } nothing to report.`;
  const names = (members: readonly Repository[], quiet: boolean) =>
    `<div class="names${quiet ? " quiet-names" : ""}">${
      members.map((repo) =>
        `<a href="${escapeHtml(hrefOf(repo.name))}">${
          quiet ? "" : dot(standing(repo))
        }${escapeHtml(repo.name)}</a>`
      ).join("")
    }</div>`;
  const group = (title: string, members: readonly Repository[], body: string) =>
    members.length === 0
      ? ""
      : `<h2>${title} <span class="meta">${members.length}</span></h2>${body}`;
  return `<p class="lede">${escapeHtml(lede)}</p>
  ${
    group(
      "Not passing",
      troubled,
      `<div class="repo-cards">${
        troubled.map((repo) => repoCard(repo, now)).join("")
      }</div>`,
    )
  }
  ${group("Passing", passing, names(passing, false))}
  ${group("Nothing to report", quiet, names(quiet, true))}`;
}

/**
 * The page `url` asks for: the repository its `name` names, or the index when
 * it names none. The response is a 404 when the name is one the dashboard does
 * not know.
 */
export function repoPageResponse(
  board: Board,
  jobs: CiJobs | undefined,
  url: URL,
  now = Date.now(),
): Response {
  const repos = repositories(board, jobs);
  const name = url.searchParams.get("name");
  const content = (
    title: string,
    current: Repository | undefined,
    body: string,
  ): LivePageContent => ({
    title: escapeHtml(title),
    heading: `<a href="${REPOS_PATH}">Repositories</a>`,
    styles: STYLES,
    head: switcher(repos, current?.name),
    body,
    script: SCRIPT,
    status: current && standing(current),
  });
  if (name === null) {
    return livePageResponse(
      content("Repositories", undefined, indexBody(repos, now)),
    );
  }
  const repo = repos.find((repo) => repo.name === name);
  if (repo === undefined) {
    return livePageResponse(
      content(
        name,
        undefined,
        `<p class="lede">The dashboard knows no repository named ${
          escapeHtml(name)
        }${
          jobs === undefined ? " yet; it is still reading the organization" : ""
        }. <a href="${REPOS_PATH}">See every repository it knows.</a></p>`,
      ),
      404,
    );
  }
  return livePageResponse(
    content(repo.name, repo, repositoryBody(repo, jobs, now)),
  );
}

/**
 * The live route serving the index and every repository's page, from `board`
 * and the ci tile's latest collection, which `jobs` returns.
 */
export function repoPagesRoute(
  board: Board,
  jobs: () => CiJobs | undefined,
): Route {
  return {
    path: REPOS_PATH,
    handler: (_req, url) => repoPageResponse(board, jobs(), url),
    live: true,
  };
}
