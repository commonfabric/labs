# Dashboard — modular dev/company status board

A small Deno server that renders a glanceable board of status tiles and
updates their markup in place over Server-Sent Events. Every tile is one file
with a fixed interface; a single file registers them.

## Run

```bash
cd <repo root>
deno task dashboard      # = deno run … packages/dashboard/server.ts
# open http://localhost:8731
```

Tiles that read GitHub need `GH_TOKEN` (or `GITHUB_TOKEN`) set in the
environment. The other token-gated tiles gray out cleanly until their env vars
are set (see below).

The root `deno task dashboard` command starts the server once. Watch mode and
dashboard-specific tests are package tasks:

```bash
cd packages/dashboard
deno task watch
deno task test
```

The dashboard uses dark mode on its first visit. The switch at the bottom right
of each page cycles through dark, light, and the operating-system preference.
It saves that choice for the dashboard and all of its drill-down pages. Inline
charts and generated CI Gantt images use the active theme as well.

## Architecture

```
dashboard/
  types.ts      the interface: Tile, TileView, Status, Ctx, Route
  config.ts     port, repo, tunable status thresholds
  palette.ts    THE ONE PLACE status colors, washes and dot shapes are chosen
  theme.ts      light/dark surface colors, theme switch markup and browser behavior
  lib.ts        shared helpers (github, memo, escapeHtml, sparkline, strip, …)
  ctx.ts        shared, memoized data sources handed to every tile (ctx.runs)
  favicon.ts    runtime status priority and access to generated PNG favicon copies
  favicon-png.generated.ts  generated runtime PNG favicon copies
  favicon-artwork.ts  build/test-only SVG source for those favicon copies
  version.ts    the browser/server compatibility version a page reloads on
  dashboard-message.ts  shared message storage and fade timing
  render.ts     renderTile(view) + the page shell/CSS
  server.ts     generic runtime: scheduler, SSE, route mounting, page assembly
  registry.ts   THE ONE REGISTRATION POINT — the array of tiles
  tiles/*.ts     one tile per file
```

`server.ts` knows nothing about individual tiles. It runs a single ticker,
collects each tile that is due (respecting its `intervalMs`), renders the
results uniformly, mounts any drill-down routes a tile declares, and pushes new
tile markup as each independent collection completes. Every registered tile has
a gray placeholder labeled with its id in its registered position until its
first collection completes, so slow collectors do not leave holes in the board.
A later ticker pass skips a tile or shared workflow fetch that is still
updating. It starts every other due collection, so pending work does not pause
the rest of the dashboard. A collection that remains active for one minute
turns its tile gray with "refresh still pending" while retaining its last value
and visuals. Its completed view replaces that pending state. A tile with
`showOnlyCompletedViews` keeps its last completed color and values, ignores
intermediate views, and still shows the pending warning. An intermediate view
that carries no chart keeps the chart already on the tile, so a tile drawing
its chart from the slower half of its collection has one throughout. A
completed view carries every part of a tile, so a chart its collection no
longer draws leaves the tile.
A tile whose `collect()` throws is desaturated to a gray "unknown" — it keeps
its last-known value and shows a short reason (e.g. "source unreachable"), with
the full error in the server log — so one unreachable source never blanks or
breaks the board.

The text field centered between the dashboard identity and freshness indicator
is a shared message. Editing the field and leaving it saves the text for every
connected dashboard and persists it in the dashboard cache. The message remains
fully visible for two hours. It then fades linearly for four hours, after which
the server replaces it with the empty string. A new edit starts the timing
again.

GitHub CI tiles declare the workflow snapshots they read in `runSources`. The
scheduler fetches each workflow independently. When a workflow fetch completes,
the scheduler collects every due tile that reads it from the same stored
snapshot and publishes those tile updates together. Each workflow can trigger a
tile once per collection interval. A tile with several workflows can update
once for each workflow as they arrive. This keeps a repository's build, trust,
duration, and recent-run views in agreement when their intervals coincide.

A workflow snapshot is read a page at a time, and the pages have to describe
one moment. A page after the first asks GitHub for the runs created at or
before the run the page before it ended on, rather than for an offset into a
list that shifts as runs land. That run is one the window already holds, so the
page has to carry it; a page that comes back without it was cut from a moment
that never held that run, and the fetch fails rather than joining the two. This
reads the same whichever side went stale. The cost is the one run each page
repeats, which is why the window is up to the configured maximum rather than
exactly it. The runs that do come back are ordered newest-first by the
collection, not by the order the pages arrived in. A fetch whose newest run is older than the newest run already held
read a stale view of the workflow: the scheduler keeps the snapshot it has and
names the source, and the next fetch that reaches a current view clears that.
Together these keep a stale read from putting a run from weeks back at the head
of a window, where every CI tile takes the state of the tree from.

The recent-main-runs tile reads both the Labs and Loom snapshots. It rebuilds
and sorts the combined list whenever either snapshot arrives. If one snapshot
has not arrived yet, it shows the runs from the available snapshot in gray and
names the pending source. If a later refresh fails, it keeps the last good
snapshot for that source and shows the combined list in gray with the error.

Each event connection receives the current tile snapshot before it waits for
new collections. The browser reconciles that snapshot by tile ID, leaving
unchanged elements, focus, and scroll positions in place. Routine data updates
never navigate the page. The page shell — the styles and the client script —
arrives only with a full page load, so the server hands the browser a
compatibility version and the page reloads itself as soon as the server reports
a different one. A deployed image uses the commit its publishing workflow
checked out, which is fixed for the life of the image, so every display on that
image agrees. A server started from a checkout reports the moment it started
instead, because the code under it changes between one start and the next: a
watched restart therefore pulls every open page onto the code that restart is
serving, and the version in the page source says which start served it.
An unattended display reloads when it reconnects to a server reporting a
different version.

An unattended display also survives the server going away. Every serving tick
sends a heartbeat down each open event connection, so a browser can tell a
server with nothing new to report from a stream that has stopped delivering.
The page watches its own stream from the same one-second tick that paints the
freshness indicator, and reopens the stream once the server has been silent for
the length of time it takes that indicator to turn red. That covers each way a
stream dies. The browser reconnects one that ended in a network error by
itself. It gives up for good on one whose reconnect was answered by an error
page, which is what the Tailscale proxy in front of the pod returns while the
server restarts. And a connection that outlives a sleeping laptop stays open
with nothing ever coming down it, which the browser never reports at all.

A stream that was delivering and then closed is reopened immediately. One that
has never delivered is reopened once per silence interval, so a server that
refuses or fails connections costs one request an interval however long it is
away, while one that accepts a connection and then drops it is followed as fast
as it flaps. The silence interval is the fastest tile's collection interval
plus a serving tick plus ten seconds. That keeps it clear of the heartbeat
period, which is one serving tick, by the whole of the fastest tile's interval.
A heartbeat slower than the silence interval would replace a healthy stream on
every page tick.

The indicator and the reconnect run off different clocks and mean different
things. The indicator counts from the last tile update, so red means the data
is old. The reconnect counts from the last event of any kind, heartbeats
included, so reaching the interval means the server cannot be heard at all. A
page can be red on a perfectly good stream, when every collector has been slow
at once. The header badge is what tells the two apart, reading OFFLINE instead
of LIVE whenever the page has no stream it is hearing the server on.

Reopening the stream and saying whether the server can be heard are separate
questions and get separate answers. Reopening is paced, because each attempt
costs a request. Saying so is not. The browser reports a connection dropping as
it drops, whether it means to retry or has given up, and the badge turns over on
the next tick — a second, not an interval. Stopping the server therefore stands
the page down almost at once, and the badge comes back the moment any event
arrives on a stream again, including a heartbeat. The elapsed interval is only
the last resort, for a connection that stays open with nothing coming down it,
which is the one case the browser reports nothing about at all. A background
tab's timers are throttled to about one a minute and a sleeping machine's stop
altogether, so the page checks its stream on becoming visible and on the browser
regaining the network as well as on its own tick.

The tab favicon follows the most urgent visible tile. It is red when any tile is
red, orange when there are no red tiles but at least one orange tile, and green
otherwise. Gray tiles do not turn the favicon gray. The page uses one URL-backed
PNG favicon. Scalable source artwork is used only to generate and verify those
raster assets; it is not part of the runtime dependency graph. The green face is
a rounded square, the orange warning face is a triangle, and the red faces are
octagons. The eyes and mouth of the warning face sit ten percent of the canvas
height below the level the other faces use, which places them in the wide part
of the triangle instead of near its apex. The red favicon starts sad and
becomes a crying face after the dashboard stays red for one continuous hour. The
server retains the elapsed time across reloads. Returning below red resets it
once every collector due in the same pass has finished.

After changing `favicon-artwork.ts`, regenerate the embedded PNGs and their
content-based cache version from the dashboard package directory:

```bash
cd packages/dashboard
deno task regenerate-favicons
deno task test-favicon-raster
```

## Add a tile

1. Create `tiles/my-tile.ts`:

```ts
import type { Status, Tile, TileView } from "../types.ts";

export const myTile: Tile = {
  id: "my-tile",          // unique, stable
  label: "my tile",       // header before collection; defaults to id
  intervalMs: 60_000,     // how often collect() runs
  // wide: true,           // optional full-width placement
  // runSources: [{ repo: "owner/repo", workflow: "ci.yml" }],
  async collect(ctx): Promise<TileView> {
    // ctx.runs() -> shared CI runs; ctx.env("KEY") -> env var.
    // If a required env var is missing, return a gray "unknown" view — don't throw.
    const s: Status = "good";
    return { label: "my tile", status: s, value: "42", sub: "things" };
  },
  // routes: [{ path: "/my-drilldown", handler: (req, url) => new Response("…") }],
};
```

2. Register it in `registry.ts` (import + one line in the `TILES` array).

That's it. Remove a tile by deleting its line from `registry.ts` (and its file).

### Philosophy and values

The dashboard is something people glance at all day, often out of the corner of
an eye, so a tile's first duty is to inform without adding anxiety. Keep it calm
by default. There are only three signals — good, warn, and bad, plus a gray
"unknown" when a source is missing or a collector fails — because green should
mean "fine," red should mean "a person should act on this now," and there is
little in between worth manufacturing. Red has to stay rare and trustworthy: if
tiles sit red or amber most of the time, people stop seeing them, and a board
everyone has learned to ignore is worse than no board. A tile earns a color
change; it never reaches for one to get attention.

A signal is carried by four things at once, so that no one of them has to be
read on its own. Losing any single cue still leaves a state legible, which is
what a person who cannot separate red from green is doing all day.

The first is color, chosen so the four stay apart for that person too. Green
sits at a teal and amber at an orange rather than at a yellow, which puts the
two on the blue/yellow axis; red/green color blindness leaves that axis
working, and good against warn is otherwise the hardest pair on the dashboard.
Every pair of statuses is measured in `palette.test.ts`, which simulates the
two common forms of red/green color blindness and fails if any pair comes
within reach of reading as one color.

The second is the shape of the header dot: a circle for good, a triangle for
warn, a diamond for bad, and a hollow ring for unknown. A shape survives any
kind of color vision, and any distance at which the dot is still visible at all.

The third is weight. A tile's background wash and its border both get stronger
as its status gets more serious, so a good tile is the quietest thing on the
dashboard and a red one the loudest. That ordering holds with the color taken
away altogether.

The fourth is texture, behind the tile. A gray tile is covered in a grid of
tiny dots, an amber tile in broad wavy lines, and a red tile in zig-zags. The
lines are wide and faint rather than fine and dark, which puts enough of the
pattern on the tile to catch the eye without any one line drawing it. The
zig-zag covers a little under half of a red tile, and the longer, gentler wave
about a third of an amber one. Green tiles
are left plain, which is the calm the rest of the dashboard is measured against.
Every texture fades out down the tile: it is whole for the tile's top seventh,
thins from there, and is gone seven tenths of the way down, which leaves the
sub line and the foot of a chart on plain color.

Everything the dashboard draws over a texture has to stay legible against it,
and the faintest marks are the ones that decide how strong a texture can be: a
tile's title, its drill-down hint, its running badge, and the times, dividers
and pop-out arrows down the recent-runs list. Those are set against the lightest the background
reaches under a texture band rather than against the tile's flat color. The
dividers and the arrows are fractions of white rather than fixed grays,
because the surface they sit on is tinted by the status and a gray that reads
on one wash washes out on another.

`palette.ts` holds all of this, and it is the only place any of it is chosen.
A status color that appears anywhere — a tile, a dot, a headline, a run cell,
a drill-down row, the favicon — comes from there. A shade that follows from
another is worked out there too rather than written down beside it, so a change
to a color carries without a second edit. Sparkline strokes fade from a
transparent version of their own series color over the shared chart axis. The
shape a dot takes is geometry rather than color, and lives with the rest of the
tile's CSS.

Think about how a tile makes someone feel before you think about what it
measures. Prefer an honest gray "unknown" over a false green — a tile that
can't tell "healthy" from "I couldn't reach the source," and stays green while
blind, is worse than one that admits it doesn't know. Report on the system,
never on individuals: no per-person leaderboards, no "who broke the build,"
nothing that turns the dashboard into a place to rank or shame people. And be
wary of the number that looks like progress but isn't — coverage percentage,
lines of code, raw PR counts — anything that becomes a bad target the moment
someone optimizes for it, or whose only job is to look busy. If a metric would
quietly pressure people into gaming it, leave it off. This is a quiet
instrument panel a tired person should be able to trust at 2am, not a
scoreboard and not a surveillance tool.

A tile is about as wide as a business card, and every line on it is set without
wrapping. A line longer than that width is not shortened by the renderer so much
as cut off by it, and a line that ends in an ellipsis has taken the whole line
and delivered none of it. So the headline figure and the sub line under it are
what a tile has room to say. Text can go below them — the host names down the
production tile, the run list on the full-width recent runs — but only text
short enough to be read whole at the width the tile is actually given. Something
longer is not a longer tile, it is a page.

That page is an ordinary drill-down — a route the tile declares, reached through
the tile's `href` and indicated by the top-right arrow. The tile's `hint` supplies
the tooltip and accessible link description. `/bench` holds the histories behind
the benchmark and duration tiles, and `/test-selection` holds the manifest behind
the two test tiles. A page has the width to spell a test's whole name, so nothing
on one has to be abbreviated.

Where a tile has more than one candidate for its sub line, the one that explains
the color it is wearing wins. The test selection tile carries the count of the
corpus a pull request would run under its headline share, and gives that line
up to whichever of two conditions is in force: the lane past its budget where
there is one, and otherwise the count of tests no lane can hold. A stale
manifest colors the tile too and competes for neither line, because its own
figure is the age badge in the header.

### The `TileView` a tile returns

| field | meaning |
|---|---|
| `label` | header text (plain; escaped for you) |
| `status` | `good` / `warn` / `bad` / `unknown` → green / orange / red / gray |
| `value` | big headline (trusted HTML — escape data with `escapeHtml`) |
| `sub` | sub line (plain; escaped for you) |
| `extra` | trusted inline HTML under the value (sparkline / strip / list) |
| `duration` | a span in milliseconds, rendered (via `humanSpan`) in the chart's bottom-left corner |
| `aside` | trusted inline HTML minor header facet (e.g. an MTD or a "running" badge) |
| `href` | makes the whole tile a link (an `http…` link opens a new tab) |
| `hint` | tooltip for the top-right `↗` drill arrow and accessible link description, e.g. `"commits ↗"` |

## Tiles

| tile | source | needs |
|---|---|---|
| labs ci, labs ci trust, labs ci duration | GitHub Actions (`deno.yml` on main in `commonfabric/labs`), via the REST API | `GH_TOKEN` (or `GITHUB_TOKEN`) |
| loom ci, loom ci trust, loom ci duration | the same three tiles for `commonfabric/loom` (`test-fast.yml` on main) | `GH_TOKEN` (read access to loom); optional `DASHBOARD_LOOM_REPO` |
| recent main runs | Labs and Loom main-run snapshots, refreshed independently and merged chronologically whenever either arrives; each row is tagged with its repo | `GH_TOKEN` |
| commit CI Gantt → `/ci-gantt` | job and step timing for every successful main workflow run attached to one commit, linked from run durations in recent main runs | `GH_TOKEN` |
| CI duration history → `/bench?view=ci` | labs and loom job, shard-group, and end-to-end workflow duration trends. The duration tiles open their matching repository view | `GH_TOKEN` |
| CI run Gantt → `/bench?view=gantt` | detailed labs or loom job phases from `scripts/ci-gantt.ts`, backed by the CI history cache | `GH_TOKEN` |
| flaky tests | how many tests the test-selection publisher measured disagreeing with themselves often enough to keep off pull requests, read from the newest selection manifest. The headline names what it counts, so it reads `25 flaky tests`, or `no flaky tests` when there are none. The line under it says what the count was drawn from: the span of history a flake share is measured over, which the manifest's `FLAKE_WINDOW_DAYS` dial names, and how long ago the publisher measured. The sparkline plots the count across every available manifest. Which tests they are is on the page behind it. Amber from one, red from ten. Gray with a dash when no manifest is available, the newest readable manifest has an empty corpus, or none of the manifests it looked at can be read, naming the shape it found in that last case. Readable history remains visible when the newest object cannot be read | optional `GH_TOKEN` for publisher activity |
| test selection | what share of the corpus the newest selection manifest would have a pull request run, read from the same manifest. The manifest's packing is built with nothing mandatory, so the share is the one a pull request touching no test would get; a real one re-packs against its own diff and spends part of the same budget on what that diff makes mandatory. Amber once that manifest is over eight hours old, because selection quality decays with it, and amber too while the corpus holds a test costing more on its own than a whole lane's budget, since no packing can place one and a pull request then runs it only where its own diff makes it mandatory. Red when a lane's projected work is past the budget the manifest was packed to. Both of the last two take the sub line off the corpus count, the red one first. The sparkline plots the selected percentage across every available manifest, using each manifest's own corpus size. Gray on the same conditions as the flaky tests tile, including an empty latest corpus | optional `GH_TOKEN` for publisher activity |
| test selection detail → `/test-selection` | the manifest behind both test tiles, at full width: every lane against its budget and how many tests it holds, every test held back as flaky with the rate it was measured at, and every test no lane can hold. Both tiles link here, the flaky tests tile straight to its flaky section | none |
| coverage debt | the repository's whole uncovered-line count and what a median day does to it, read from the `perf-metrics` artifact of each day's newest successful `main` run (`docs/development/COVERAGE.md`). The headline is the count; under it a signed rate gives the median day's move over the last three weeks, and the chart spans eight weeks with those days highlighted. Its vertical scale uses the highlighted days, so older extremes can extend outside the chart. Amber means that median is a rise, which takes more than half the days in the window, so a day that added debt says nothing on its own. It never turns red, and it goes gray rather than stand on a stale number: when five days have passed with nothing measured, and until the window holds a week of days to take a median over. A run whose pattern compile cache missed is passed over, because a cold run reaches branches a warm one does not and reads about a tenth of a percent low. It looks for a landing every five minutes, which costs one request when none has happened; the figure itself cannot exist until a run's Coverage Check uploads it, about twelve minutes after the commit lands | `GH_TOKEN` |
| production | a direct synthetic HTTP check of the public commonfabric.com site, synthetic HTTP checks of `/_health` on estuary and rapids, plus a name or reachability check for all three and for the bastion, the production and staging shells, the LLM gateway, and the sandbox service. When every host is well the headline counts them up. When a host has nothing behind it at all, the headline names that host, as in `bastion down`, and counts them when there is more than one, as in `2 hosts down`. Otherwise it names the worst condition seen, such as a response time or an HTTP status. Estuary and rapids keep their response times in the body while the tile is green or orange. Commonfabric.com stays out of the body while it is good. Hosts without a health request stay out for as long as they answer, and a red tile drops all the green hosts. Red means the tile found nothing at the other end — a name with no A or AAAA record, a tailnet host the proxy cannot reach, or an HTTP request that never connected — and it also means a server health response other than 200, a health response over 1000 ms, or a commonfabric.com 5xx response. Orange means a health response over 500 ms, a commonfabric.com 4xx response or response over 2500 ms, or a resolver that failed, which leaves the tile unable to say either way. Hosts outside the tailnet are looked up by the dashboard itself. Tailnet hosts go through `PROD_PROXY`, because a dashboard that needs that proxy has no view of Tailscale's MagicDNS. Estuary and rapids are covered there by their health requests. The bastion has no health endpoint, so it gets a SOCKS5 connect that leaves the name for the proxy to resolve. The bastion records that connect in its own logs, so a bastion that answers is left alone for an hour and counts as reachable in between. One that does not answer is asked again on the next refresh, since a connect that reaches nothing leaves nothing behind. With no `PROD_PROXY` set, every host is looked up locally | optional `COMMON_FABRIC_URL`, `ESTUARY_URL`, `RAPIDS_URL`, `BASTION_HOST`, `PROD_PROXY`; `PROD_URL` remains an alias for `ESTUARY_URL` |
| prod errors | SigNoz trace error rate for one service (errored spans / all spans): last-12h headline, with a per-hour sparkline over the retained trace history (~2 weeks) and the last-12h slice that feeds the headline highlighted. Scoped to `PROD_SERVICE` — the same SigNoz holds staging and one-off perf runs, whose rates are not production's. Gray (not red) when SigNoz is unreachable. Pops out to the SigNoz logs explorer | `SIGNOZ_URL`, `SIGNOZ_API_KEY`; optional `PROD_SERVICE`, `SIGNOZ_UI_URL` for the pop-out |
| cloud spend | BigQuery billing export, after credits, projected to month-end from the available part of a 14-day daily-cost window early in the month. The header shows actual MTD spend. The highlighted part of the 45-day chart shows the days used for the estimate | `GCP_BILLING_TABLE` (+ Workload Identity, or `GCP_SA_KEY` locally), optional `GCP_DAILY_BUDGET` |
| github spend | the organization's whole metered GitHub bill, projected to month-end in USD: every product its billing report carries, added into one figure. The 45-day chart labels the line with MTD spend, and the header shows the same total. A report that stopped being written more than four days ago is unavailable rather than a run of $0 days. A month whose report cannot be read breaks the line across those days rather than charting them as $0. "What the GitHub figure covers" below says which spend reaches the API | `GH_TOKEN` (with org billing read); optional `GH_BILLING_ORG` |
| cubic spend | the spend row's slot for Cubic, the code review service. Cubic's API reports no billing figure, so the tile stays green and says why it shows none | none |
| all benchmarks | a scale-invariant index of benchmark performance on `benchmarks.yml` main runs, trended over ~45 days (each run vs the last, geometric mean of per-benchmark changes, so every benchmark weighs the same, divided by the same run's machine calibration so a busy host does not read as a code change): red when the most recent run failed or produced no valid data (the main signal), with a `failed (was <trend>)` headline when cached measurements are available and `failed` otherwise; orange only on a broad across-the-board rise from a CPU measured in the preceding twelve hours. Adding or removing a benchmark is a non-event. Drills through to the per-benchmark history | `GH_TOKEN` |
| key benchmarks | the same index and status rules as all benchmarks, restricted to `topic board/journey` and `topic board scale/100`. Machine calibration still uses the run's calibration measurements. Counts and data availability refer to the selected benchmarks. Opens the per-benchmark history with "key only" checked | `GH_TOKEN` |
| performance history → `/bench?view=runtime` | runtime benchmark trends, labs or loom CI duration history, and a detailed CI run Gantt. Historical views support windows from 1 through 45 days, date axes, and duration sorting. CI includes end-to-end workflow time, every job, and slowest-shard group lines | `GH_TOKEN` |
| model spend | OpenAI + Anthropic + OpenRouter usage APIs. Headline is the projected full-month spend (extrapolated from the recent daily rate, spilling into last month when this month is under two weeks old), summed across providers. OpenAI and Anthropic (which expose per-day cost) are charted as one line each over ~45 days, with a recent daily-rate slice highlighted and each line's MTD in the right gutter; OpenRouter (monthly total only, abbreviated "OR") is folded into the totals. The subtitle is the bullet-separated key (`OpenAI • Anthropic • OR $0`); the combined MTD sits in the header (the `aside` slot); the span the chart covers is in its bottom-left corner (the `duration` slot). A provider we can't read shows `$???` and drops the tile to gray, but the rest still chart and total; a provider whose cost report stopped being written more than four days ago is one of those | any of `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`, `OPENROUTER_KEY`; optional `MODEL_MONTHLY_BUDGET` |
| discord online | Discord gateway presence, team vs visitors over time | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` (Server Members + Presence intents) |
| dau | distinct identities active per UTC day on one named service, counted from the `user.did` attribute on the `memory.transact` and `memory.subscriber.sync` spans in SigNoz. The headline is the last day that ran to the end (today is still filling, and a part-day always reads as a drop); the sparkline is the retained history. Gray while the named service has no such spans — which is the resting state until a deployment's tracing is switched on. It counts keypairs rather than people; see [dau](#dau) below | `SIGNOZ_URL`, `SIGNOZ_API_KEY`; optional `PROD_SERVICE`, `DAU_EXCLUDE_DIDS`, `SIGNOZ_UI_URL` |
| github users | organization members plus outside collaborators, with each roster's size charted over about two months. The headline counts unique users across both rosters | `GH_TOKEN` (with org Members read) |

The **production** tile starts gray and says `waiting for connectivity` until
its direct **commonfabric.com** check receives an HTTP response. It performs no
other host checks before that signal. The confirmation lasts for the process
lifetime, so an unreachable host is then reported as an outage even when every
host is unreachable together.

The **labs ci** and **loom ci** headlines use the most recent completed workflow
attempt that was not cancelled. A cancelled attempt neither sets the headline
nor ends the streak beneath it, so a run cancelled by a newer push leaves the
previous result showing. While GitHub reruns a workflow, the prior attempt's
conclusion remains visible and the tile marks the activity as **build
rerunning**. A new workflow run still appears as **next build running**.

The **labs ci trust** and **loom ci trust** percentages score each run by its
first attempt that was not cancelled: the run is first-try green when that
attempt succeeded. A run whose every attempt was cancelled is left out of the
percentage. The run listing carries only a run's latest attempt, so the tile
requests a rerun's earlier attempts from GitHub, once each, and holds them while
the run stays in the trust window. An earlier attempt that cannot be read turns
the tile gray, keeping its last value, until a later collection reads it.

The **labs ci duration** and **loom ci duration** tiles use successful main push
runs. Each duration starts when GitHub creates the workflow run for the landed
commit and ends when that run finishes, so it includes runner queueing and
reruns.

### Test selection history

The flaky tests and test selection tiles share a manifest reader and a cache of
counts in `fabric-wall-test-selection.json` under the dashboard cache directory.
Collection reads every page of the public manifest listing and plots every
available manifest at its generation time. The listing determines the chart's
span; the dashboard imposes no date window. A successful refresh removes cached
counts for objects that are no longer listed.

A stored body says which shape it was written in, and this dashboard reads
anything at or under its own. A body from further ahead it passes over, taking
the newest one behind it, across the same stretch of the store a lane looks
back over. Where it can read none of them it says so and names the shape it
found, rather than reporting the store empty. Anything else unreadable ends the
search where it stands, because a corrupt object is not a reader waiting to be
deployed.

Each object passed over is read once and then left alone for as long as the
process runs, so neither the walk nor a refresh fetches it again. That is held
in memory rather than in the cache file, because what a reader can validate
belongs to the build holding it and a later build may accept what this one
passed over. Every other failed read is tried again on the next refresh.

An empty corpus or an unreadable manifest leaves a gap. Connected stretches
share one vertical scale, and an isolated measurement appears as a dot. A
measured zero remains a measurement. An unreadable historical object adds a
`history warning` badge; the next scheduled collection can fill that gap.
The latest full manifest supplies the headlines and detail page. Historical
collection retains only counts and downloads at most three inventories at a
time. Cached counts survive dashboard restarts. Cache failures add a warning
without hiding readable measurements. The headline is published as soon as the
latest manifest is readable, before historical collection finishes.

Both tiles refresh their measurements and activity independently every 30 seconds.
With `GH_TOKEN` or `GITHUB_TOKEN` set, a
**running** badge lights while the Test Selection workflow on main is queued or
running, including reruns of older workflow runs. The tiles share the workflow
lookup and keep the last known badge while that lookup is pending. A failed
lookup shows **activity unknown** alongside the available measurements. Public
manifest reads work without GitHub credentials. Each refresh checks for newly
published manifests; unchanged objects reuse the cached inventory or counts.

### What the GitHub figure covers

The **github spend** tile reads the organization's billing usage report, which
carries one row per product, SKU, repository and day. The tile adds up every
row, so the figure is the organization's whole metered GitHub bill rather than
any one product's share of it. GitHub meters these products, and a product the
organization does not use simply has no row:

| product | what it bills for |
|---|---|
| `actions` | workflow minutes on every runner size, plus Actions and cache storage |
| `packages` | Packages storage and bandwidth |
| `codespaces` | Codespaces compute, storage, and prebuild storage |
| `git_lfs` | Git LFS storage and bandwidth |
| `copilot` | Copilot seats (`copilot_for_business`, `copilot_enterprise`, `copilot_standalone`) and the AI credits Copilot consumes |
| `ghec` | GitHub Enterprise Cloud seat licenses (`ghec_licenses`) |
| `ghas` | Advanced Security seat licenses, whole and by tier |
| `models` | model inference |
| `sandbox` | Copilot sandbox compute, memory, and snapshots |
| `spark` | Spark AI credits |

Seat licenses arrive as billed dollars in that same report, so Copilot seats
and Enterprise Cloud licenses are inside the figure without any per-seat price
having to be configured here.

One caveat applies to the projection rather than to the figure. GitHub dates
every row by the day the usage occurred, and the month-end projection carries
the recent daily rate across the remaining days, which suits spend that accrues
daily. A charge posted as a single lump instead of as a daily series would be
carried across the month as though it recurred, overstating the projection
while leaving month-to-date correct. No such charge has been observed here, and
seat licenses are the products to watch for one: compare the headline with the
month-to-date total beside it the first month a seat-licensed product appears.

What the API does not expose, and the figure therefore excludes:

- **A subscription billed outside the usage report.** An organization's plan
  reaches the API only when its licensing is metered, as `ghec_licenses` rows.
  An organization billed for its plan as a flat subscription — a **Team** plan,
  which has no product or SKU of its own at all, or an **Enterprise** plan whose
  licensing has not moved to metered billing — has no row for it, and its
  seat cost is absent from the figure. `orgs/{org}` reports the seat counts
  (`plan.name`, `plan.seats`, `plan.filled_seats`) but never a price, so there
  is nothing to add up from.
- **Anything billed at the enterprise account rather than the organization.**
  The usage report is scoped to one organization. An enterprise account's own
  report is a separate endpoint under `enterprises/{enterprise}`, needs
  enterprise-level administration, and is not read here.

Both gaps are silent: the figure is a true total of what GitHub reports, not a
total of what GitHub charges. Check it against the billing page the tile links
to before treating it as the whole bill.

## Credentials

Every tile that reads a private source is gated on its own env var(s) and grays
out until they are set. The GitHub tiles need `GH_TOKEN`; every other
private-source tile is independently optional — set only the ones you want, and
the rest stay gray without breaking the board. Each key below lists what it
powers, the rights it needs, and how to mint it. (`commonfabric.com` and
`production` need no key.)

Almost every credential is shown only once at creation — copy it immediately;
if you lose it you have to regenerate.

### `GH_TOKEN` (or `GITHUB_TOKEN`)

Powers **labs ci**, **labs ci trust**, **labs ci duration**, the **loom**
counterparts, **recent main runs**, **coverage debt**, **github spend**, and
**github users**. It also powers the optional publisher-activity indicators on
**flaky tests** and **test selection**; their public measurements need no token.
Needs
repo **Actions: read** on both `commonfabric/labs` and `commonfabric/loom`;
the github-ci-spend tile additionally needs org **Administration: read** on
`commonfabric`. The **github users** tile needs org **Members: read**. One
fine-grained token can carry all of these permissions:

The account that owns the token must be a member of the organization. GitHub's
member endpoint returns both concealed and public members to an authenticated
organization member; other callers see only public memberships.

1. GitHub → your avatar → **Settings** → **Developer settings** → **Personal
   access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Set **Resource owner** to the **commonfabric** organization (not your
   personal account) — org ownership is what unlocks the billing permission.
3. **Repository access** → **Only select repositories** → `commonfabric/labs`
   and `commonfabric/loom`.
4. **Repository permissions**: set **Actions** and **Contents** to **Read-only**.
5. **Organization permissions**: set **Members** to **Read-only** for GitHub
   users. Set **Administration** to **Read-only** for github spend. Only an org
   owner or billing manager can grant the latter permission. Skip either
   permission when its tile is not needed.
6. **Generate token** and copy it (`github_pat_…`, shown once).

If you only need the labs CI tiles, keep `commonfabric` as the resource owner,
select only `commonfabric/labs`, and grant Actions/Contents read without any
organization permissions. Classic PATs also work (use `read:org` for GitHub
users and `admin:org` for github spend). If the org requires approval for
fine-grained tokens, yours stays pending until an owner approves it.

### `SIGNOZ_URL` + `SIGNOZ_API_KEY`

Powers **prod errors**. Needs a read-only (Viewer) key on the SigNoz query API;
creating one requires an Admin.

1. In SigNoz (Cloud at `app.signoz.cloud`, or your self-hosted URL) → **Settings**
   → **Service Accounts** → **New Service Account** (e.g. `dashboard-reader`).
2. Assign it the **signoz-viewer** role (read-only query access).
3. Open the service account → **Keys** tab → **Add Key**, name it, optionally set
   an expiry → **Create**, and copy the key (opaque string, shown once). It's sent
   as the `SIGNOZ-API-KEY` header.
4. Set `SIGNOZ_URL` to the instance base URL — `https://<region>.app.signoz.cloud`
   for Cloud (`us`, `eu`, …), or your self-hosted host (default UI port `8080`).

Don't use an **ingestion** key (`signoz-ingestion-key`, write-only for telemetry);
the tile needs the read/query API key.

### `GCP_BILLING_TABLE` (+ Workload Identity, or `GCP_SA_KEY`)

Powers **cloud spend**. The tile queries BigQuery over its REST API — no `bq` or
`gcloud` CLI. There's no API key for BigQuery (a key doesn't identify a
principal), so it authenticates as a service account and gets an access token one
of two ways: in GKE the metadata server hands one out for the pod's own account
(Workload Identity, no key stored); locally, set `GCP_SA_KEY` to a service-account
key JSON and the tile signs a JWT and exchanges it for a token. The account needs
**BigQuery Job User** on the query project plus **BigQuery Data Viewer** on the
dataset.

1. Console → **Billing** → select the billing account → **Billing export**.
2. Create a BigQuery **dataset** to hold the export (a US or EU multi-region
   location lets it backfill).
3. Under **Billing export** → **Standard usage cost**, choose the project and
   dataset → **Save**. Data starts landing after a few hours.
4. The export table is named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`; set
   `GCP_BILLING_TABLE` to `project.dataset.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`.
   The query runs in that table's project, so the service account needs Job User
   there.
5. In the GKE deploy this is already provisioned: the infra repo's
   `tofu/gke/dashboard.tf` creates the service account, binds the pod's Kubernetes
   service account to it with Workload Identity, and grants **roles/bigquery.jobUser**
   on the project plus **roles/bigquery.dataViewer** on the export dataset (point
   `dashboard_billing_dataset` at that dataset). Enabling the tile is then just
   setting `GCP_BILLING_TABLE`.
6. For local development instead, grant those two roles to a service account,
   download a key for it, and set `GCP_SA_KEY` to the file's contents.

The tile covers every project tied to the exported billing account. Its figures
are money that account actually pays: the export's `cost` column plus the credits
the same rows carry, which are negative amounts. Every kind of credit counts —
promotional credits, committed- and sustained-use discounts, and the free tier —
because none of them is money the account pays. The credit is not a figure the
tile reports on its own; it is simply absent from the spend, in the same way that
the usage GitHub's plan includes is absent from the ci-spend figures.

It shows the estimated full-month spend as its headline and the actual
month-to-date value in the header. The estimate uses every settled day in the
current month. During the first half of the month, it fills that rate window from
the prior month's tail until it covers 14 days or reaches the first available
billing day. The chart shows up to 45 finished UTC days and highlights the part
used for the estimate.

Which days are finished matters, because the export lands a day's usage in
batches spread over the day or two after it ends, and works on several days at
once. A day it has not finished holds only part of that day's cost. Such a day
belongs in the month-to-date total, where it is a running figure, and not in the
rate behind the projection or at the end of the chart, where it would read as
spend falling away.

Nothing in the export marks a day as complete, so the tile establishes it two
ways at once, and a day has to satisfy both.

The first is how much of the day the export has accounted for. Alongside cost,
the query totals the billable time on each day's usage — the seconds of instance,
disk, and other metered life the export has recorded. A running fleet books close
to the same amount every day, and unlike cost it does not move when a promotion
or a price change lands, so a day holding less than half of the day before it is
one the export is still filling in. A fleet that really does shrink trips this
for the day it shrinks on, and then the days after it stand against the new level
and the window moves on.

The second is how long the export has had. It records when it last added a
material batch to each day, which the tile turns into how long the export is
currently taking to finish with a day. That figure is measured from the export's
own record across the window rather than assumed here, so it follows an export
that speeds up or slows down. A day is finished once the export has had that long
since the day ended. The newest day in the window is never finished, because the
export has written nothing after it to show it has moved past it.

Each check covers where the other is blind. Billable time alone would accept a
day the export happens to be most of the way through; elapsed time alone would
accept a day the export has fallen behind on. When no day passes both for more
than four days the tile goes gray and says how far behind it is, rather than
projecting a month from stale history.

Both checks read only the export's `regular` rows. Invoice adjustments and
rounding corrections arrive weeks after the fact and carry no usage, so counting
them would make a long-closed day look freshly written.

A promotional credit is finite, so the spend the tile reports rises when a grant
runs out even though nothing about the usage changed. How much of a grant is left
is not in the billing export: Google publishes it only in the console's billing
credits page.

A grant may also arrive in monthly tranches that land on a few days rather than
spreading across the month. The rate window is a fortnight, so it either covers
those days or it does not, and the projection steps up or down as they pass out
of it. The month-to-date figure in the header carries whatever has landed so far
and is the one to read when a tranche is due but has not arrived.

### `OPENAI_ADMIN_KEY`

Powers the OpenAI share of **model spend**. Needs an organization **Admin** key —
only an org **Owner** can create one, and a project key (`sk-proj-…`) gets a 401
on the costs endpoint.

1. Go to **platform.openai.com → Settings → Organization → Admin keys**.
2. **Create new admin key**, name it, **Create**.
3. Copy it (`sk-admin-…`, distinct from `sk-proj-…`, shown once). Treat it like a
   root credential — it grants full org management.

### `ANTHROPIC_ADMIN_KEY`

Powers the Anthropic share of **model spend**. Needs an **Admin** key
(`sk-ant-admin01-…`), created by an org admin/owner; a normal API key is rejected
by the cost-report endpoint. Console admin keys have no selectable scopes — they
carry full Admin API access, so guard one like a root credential.

1. Open [Claude Console → Settings → Admin keys](https://platform.claude.com/settings/admin-keys).
   You must be an organization admin.

2. Click **Create key**, name it `dashboard-reader`, and choose an expiration.
   The key must begin with `sk-ant-admin01-`. Copy it immediately; Anthropic
   shows it only once.
   [Anthropic instructions](https://platform.claude.com/docs/en/manage-claude/admin-api-keys)

   The dashboard does not rotate this key automatically. A longer lifetime
   reduces how often an operator must replace the secret and restart the
   dashboard. Record the expiration and replace the key before that date.

3. Store it without putting it in shell history:

   ```zsh
   read -s "new_anthropic_key?Paste the new key: "
   echo
   if [[ "$new_anthropic_key" != sk-ant-admin01-* ]]; then
     echo "The key must begin with sk-ant-admin01-." >&2
   else
     printf %s "$new_anthropic_key" |
       gcloud secrets versions add \
         k8s-stage-dashboard-anthropic-admin-key \
         --project=commontools-core \
         --data-file=-
   fi
   unset new_anthropic_key
   ```

4. Confirm that `kubectl` addresses the stage cluster:

   ```zsh
   kubectl config current-context
   ```

   It must print
   `gke_commontools-core_us-central1_gke-cluster-stage`. Then force the
   Kubernetes secret to refresh:

   ```zsh
   kubectl annotate externalsecret dev-dashboard-anthropic \
     -n dev-dashboard \
     force-sync="$(date +%s)" \
     --overwrite
   ```

5. Watch the ExternalSecret and wait for its `REFRESHED` timestamp to change.
   Stop the watch with Control-C after it reports `READY` as `True`:

   ```zsh
   kubectl get externalsecret dev-dashboard-anthropic \
     -n dev-dashboard \
     --watch \
     -o 'custom-columns=REFRESHED:.status.refreshTime,READY:.status.conditions[0].status'
   ```

6. Restart the dashboard so its environment reloads, then wait for the rollout
   to finish:

   ```zsh
   kubectl rollout restart deployment/dev-dashboard -n dev-dashboard
   kubectl rollout status deployment/dev-dashboard -n dev-dashboard
   ```

### `OPENROUTER_KEY`

Powers the OpenRouter share of **model spend**. A plain inference key (`sk-or-…`)
is enough — the tile only reads the key's own month-to-date usage via
`GET /api/v1/key`, so no admin/management key is needed.

1. **openrouter.ai → Settings → Keys** → **Create API Key**, name it, **Create**.
2. Copy the `sk-or-…` key (shown once).

Use a normal key, not a **Management** key — management keys can't call
`/api/v1/key`.

### `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID`

Powers **discord online**. Needs a bot with the **Server Members** and
**Presence** privileged intents, invited to the server, plus the server id.
The guild must contain a role named exactly `Team` or `Team Member`; without
either, the tile remains unknown. The names are equivalent. Online members with
either role count as team; every other online member counts as a visitor.

1. **discord.com/developers/applications → New Application**, name it, **Create**.
2. **Bot** (left sidebar) → **Reset Token** → copy the token (shown once).
3. Still on the Bot page → **Privileged Gateway Intents** → toggle **Server
   Members Intent** and **Presence Intent** ON → **Save Changes**. Without both,
   the gateway closes the connection with error `4014` (disallowed intents).
4. Under **Installation** (or OAuth2 → URL Generator), select the **`bot`** scope,
   copy the install link, open it, pick your server, **Authorize**.
5. In Discord: **User Settings → Advanced → Developer Mode** ON, then right-click
   the server → **Copy Server ID** → that's `DISCORD_GUILD_ID` (an 18–20 digit
   number).

Resetting the token invalidates the previous one, breaking anything still using
it.

**Optional, non-secret knobs** (no key; they tune behavior):

| env var | tile | purpose |
|---|---|---|
| `GH_BILLING_ORG` | github spend | org login for billing (default: the org from `DASHBOARD_REPO` — `commonfabric`). |
| `MODEL_MONTHLY_BUDGET` | model spend | combined monthly USD budget across providers. |
| `GCP_SA_KEY` | cloud spend | a service-account key JSON (the whole file, as the value) for local development; in GKE, Workload Identity supplies the token and this is unset. |
| `GCP_DAILY_BUDGET` | cloud spend | daily USD budget. The projected month is compared with this daily rate multiplied by the number of days in the month. |
| `ESTUARY_URL` | production | the estuary server as an origin. The tile checks `/_health` on it and links to it. Defaults to `https://estuary.saga-castor.ts.net`. `PROD_URL` remains an alias when `ESTUARY_URL` is unset. |
| `RAPIDS_URL` | production | the rapids server as an origin. The tile checks `/_health` on it and links to it. Defaults to `https://rapids.saga-castor.ts.net`. |
| `BASTION_HOST` | production | the deployment bastion's hostname. A URL is also accepted; its hostname is used, along with its port when it carries one, which otherwise is 22. A tailnet name is checked hourly by connecting through `PROD_PROXY`, and any other name by an A and AAAA lookup on every refresh. Defaults to `bastion.saga-castor.ts.net`. |
| `PROD_PROXY` | production | optional proxy for reaching tailnet hosts. Use `socks5h://127.0.0.1:1055` with the Tailscale userspace proxy. Also accepts `socks5://`, `http://`, and `https://`; invalid values and URLs containing credentials fail closed instead of fetching directly. Setting it also moves the tailnet name checks onto the proxy, since a dashboard that needs a proxy cannot resolve MagicDNS names itself. The bastion check needs a SOCKS5 proxy to do that, and stays gray over an `http://` or `https://` one. |
| `COMMON_FABRIC_URL` | production | override the public-site URL (e.g. the `www` host if the apex redirects). |
| `DASHBOARD_REPO` | CI tiles, github users | which repo the CI tiles read. Its owner is the organization the **github users** tile reads (default `commonfabric/labs`). |
| `DASHBOARD_CACHE_DIR` | server caches | directory for all persistent dashboard cache files (default: the platform temp directory). |
| `SIGNOZ_UI_URL` | prod errors, dau | browser-facing SigNoz URL for the explorer pop-outs: **prod errors** links to `/logs/logs-explorer` and **dau** to `/traces-explorer` under it. Defaults to `SIGNOZ_URL` when that is a public `https://` URL. An in-cluster `http://` URL, which a browser cannot reach, leaves both tiles with no pop-out at all, so set this whenever the server reaches SigNoz over one. |
| `PROD_SERVICE` | prod errors, dau | the `service.name` production reports under in SigNoz, which both trace-reading tiles scope to. Defaults to `toolshed-production`. A name outside `[A-Za-z0-9._-]` is ignored, since it lands inside a query expression. |
| `DAU_EXCLUDE_DIDS` | dau | comma-separated identity DIDs to leave out of the count — the server's own identity, `MEMORY_SERVICE_DIDS`, background services. Until it is set the count is an upper bound. See [dau](#dau) below. |

<a id="dau"></a>
**What the dau tile counts.** Distinct `user.did` values per UTC day, over the
`memory.transact` and `memory.subscriber.sync` spans of one named service, read from
the same SigNoz the prod errors tile uses. `user.did` is the memory session principal,
which is the signature-checked `session.open` issuer, so no new instrumentation is
involved. `docs/features/active-user-counting.md` records what the number means.
Four things bound it, and they are worth knowing before quoting it:

- **It counts identities, not people.** An identity is a keypair. One person with a
  browser mnemonic and a `cf id derive` passphrase is two; one key shared across a team
  is one. The tile says "active identities" for that reason.
- **Some identities are not people at all.** The server's own identity and the DIDs in
  `MEMORY_SERVICE_DIDS` are principals in the same way a user is. Name them in
  `DAU_EXCLUDE_DIDS`; until then the count is an upper bound.
- **Read-only sessions are invisible.** `session.open` emits no span, so someone who
  connects and only reads is never attributed, and a day of purely read-only traffic
  reports zero.
- **The history is as long as trace retention**, roughly a fortnight, and that retention
  is a live setting on the SigNoz database rather than anything this repository holds.

Head sampling below 1.0 would not scale this number down, it would drop identities out
of it, and no arithmetic afterwards would put them back.

The tile is gray whenever the named service has no identity-bearing spans in the
retained window, which is the resting state for a deployment whose tracing is switched
off. It needs no second change to light up once that deployment starts exporting.

Notes:

- **One GitHub token:** every GitHub tile uses `GH_TOKEN`. The github-ci-spend
  tile also needs org billing read. The **github users** tile needs org Members
  read. A second token would not reduce exposure because the process would hold
  both, so there is just one. With Actions read alone, those two tiles gray out
  and the other GitHub tiles still work.
- **`github spend`** shows the **projected** full-month GitHub total. Its recent
  daily rate uses at least two weeks and reaches into last month early in a
  month. Spend is net of discounts and included usage. The projection is
  compared with the organization's product budgets added together, which is
  what it has authorized itself to spend. Only the budgeted products' share of
  the projection goes into that comparison: a product with no budget of its own
  is taken to be spending within one, so it counts toward the headline without
  moving the color. The light therefore turns on the products someone actually
  set a limit for, and taking up a product nobody has budgeted cannot redden
  the tile on its own. The budget printed beside the headline covers the same
  products the headline does — the budgets that exist, plus each unbudgeted
  product's own projection standing in for the budget it lacks — so the
  headline sits at or under it exactly when the tile is green. Printing the
  configured total alone would show a headline above its budget on a green
  tile. An organization with no product budget at all leaves the projection
  uncompared. A
  source that has stopped reporting turns the tile gray. The billing report is
  one pipeline across every product the organization uses, so any product's row
  dates it. Four days without a row is a stopped feed rather than a slow one. A
  classic-plan organization falls back to minutes against its included
  allowance.
- **`all benchmarks`** trends one **scale-invariant index per CPU** on the
  `benchmarks.yml` runs on main over ~45 days. The job runs `deno bench --json`
  over the bench files that workflow lists — micro-benchmarks across the runner,
  utils, fuse, and memory packages, plus the topic-board navigation and scaling
  benchmarks, which drive a browser end to end and so report in seconds where
  the others report in nanoseconds. It uploads the report as a
  `bench-results` artifact with 90-day retention. There is no committed
  history. Each CPU's index compares a run with the previous run on the same
  CPU. It multiplies the previous index by the **geometric mean of the
  per-benchmark changes**, then **divides out the machine**. Every benchmark
  weighs the same regardless of size.
  **Only a broad, across-the-board move shifts an index.** A regression in one
  benchmark barely registers, however slow that benchmark is. The drill-down
  covers individual benchmarks. A summed total would instead be dominated by
  the few slowest benchmarks. Each CPU has its own colored line. The headline
  shows the largest established trend among CPUs measured in the preceding
  twelve hours. A second line names how many benchmarks the latest run measured
  and the highlighted window when applicable.
  **Red** marks the **most recent run failing outright, or finishing green on CI
  with no readable benchmark data**. A successful run with no usable output is
  treated as failed. Either failure sets the headline to `failed (was <trend>)`
  when cached measurements are available. Its trend window and eligible CPUs
  are determined as of the latest measurements, even when those measurements
  are older than twelve hours. With no measurements, the headline is **failed**.
  The tile links to the benchmark history. The second line describes the failure
  in place of the count and the window. A run that
  failed outright dates the outage and counts
  it: **last good 2 days ago · 12 runs failed**. The count reads back through
  the newest-first run list. It stops at the first completed run that did not
  fail, so a cancelled run ends it. The date comes from the newest run that
  passed, including one that passed on a later attempt, and it is read from the
  run list the collection paged rather than from the trend's 45-day window. That
  list runs to the end of the first page past 45 days, so an older outage is
  dated whenever the run that ended it is still on the last page fetched. With
  no passing run anywhere on the list there is nothing to date the outage from,
  and the line is the count alone: **last 12 runs failed**. A run that finished green
  with nothing readable reads **no benchmark data**. A **running** badge sits in
  the header while a run is under way, wherever in the list it sits — a rerun
  keeps its original place instead of moving to the head. The badge says the
  color may be about to move; the runs that have finished still set it. The red
  state reads the workflow-run list and the latest run's cached result. It
  therefore fires when the artifacts cannot be read. **Orange** means at least
  one CPU measured in the preceding twelve hours has an index **trending up**
  past 5%. Each CPU trend uses the runs in the last
  `BENCH_TREND_MAX_AGE_DAYS` or the newest `BENCH_TREND_MIN_RUNS`, whichever set
  is larger. This matches the window rule used for the CI duration median. The
  corresponding line still spans the full ~45 days. Its trend window is
  brighter. Green means every eligible established CPU is flat or falling. When
  no CPU has been measured in the preceding twelve hours and the tile is not in
  the failed state, it turns gray and reports **no recent benchmark data**.
  A benchmark runs either to a fixed
  time budget or for a fixed number of iterations, and neither is a
  measurement. The run's wall clock therefore barely moves with performance.
  The per-operation times do move, so the tile trends those values instead.
  Because the index comes from artifacts, the tile also turns gray when no
  in-window run has readable data and the latest run is neither failed nor
  empty. A collection leaves its
  last completed color and values in place until the workflow status and
  artifact refresh have both settled. A collection that takes more than a
  minute says **refresh still pending** without changing that color. A newly
  loaded dashboard keeps its neutral placeholder until its first collection
  settles. An empty completed fetch shows **benchmark data unavailable**.
  Adding or removing a benchmark does not move an index. The benchmark is
  absent from one side of that adjacent comparison, so it drops out of the
  geometric mean. When two runs share no selected positive measurements, the
  whole index step stays unchanged, including machine calibration. Both tiles
  use the same workflow runs and artifacts when collecting concurrently.
  A CPU change starts another line instead of connecting measurements from
  unlike machines. A CPU model is not a machine, though. The runner group has
  served six processor models over a forty-five day stretch, and two runs on
  one model have measured a fifth apart on work that touches no repository code
  at all, because a run gets whatever share of a shared host the other tenants
  leave it. So the workflow also runs
  `packages/dashboard/machine-calibration.bench.ts`, whose benchmarks call no
  repository code, and each step divides their geometric mean out of the
  product benchmarks' one. What is left is what the repository did. Those
  calibration benchmarks are the tile's ruler rather than one of the things it
  measures: they are absent from the index, from the benchmark count, and from
  the drill-down. A run from before the calibration landed carries none, and
  the step into or out of it is left uncorrected rather than guessed at. The
  index also reads **one run per `BENCH_TREND_BUCKET_MS`**, matching the
  workflow's four-hourly cron, so a rerun or a manual dispatch minutes from a
  scheduled run does not put two samples of one moment into the fit. The
  drill-down keeps every run. A gap longer than one fifth of the chart width
  breaks a
  CPU's line. Any sample isolated by those breaks appears as a point. A CPU
  with one sample also appears as a point until another sample can form a line.
  A large rise reads as a fold multiplier (`▲44×`) once it passes 4x. This
  avoids a long percentage. The trend is the difference between the start and
  the end of whichever of **two robust fits** describes the samples more
  closely, measured on the samples themselves rather than extended past them.
  The first fit is a run of **flat levels meeting at change points**, which is
  the shape a series takes when a change lands and shifts it. Levels are
  medians, so a lone spike moves none of them, and a boundary counts as a change
  point only when the two levels either side sit more than 4 standard errors of
  their difference apart, with at least 3 samples supporting each — so noise
  produces no levels, and one stray sample is not a level. The second fit is a
  **straight line** through the median of the pairwise log-slopes, which is the
  shape a series takes when it drifts, and it wins when its total deviation
  is at least a tenth smaller. Reporting the difference across the fit rather
  than a slope extended over the window means a shift reads at its true size
  wherever in the window it sits: a shift in the newest samples is the one worth
  catching soonest, and a slope through it would report a fraction of it. The
  samples are first grouped into at most 64 equal-sized runs, each replaced by
  its median, which bounds the change-point search and gives every group the
  same weight however unevenly the runs arrive. With fewer than 7 distinct
  days in the window the trend is marked new: there is too little data to claim one.
  The window is capped by the 90-day artifact retention, so it shows at most ~45
  days and only as far back as the job has run.
  - The tile collects every minute, which is what the run state needs: a
    benchmark run lasts about an hour, so a slower collection could miss one from
    start to finish and never show its **running** badge. Each collection pages
    the run list. It publishes only the completed view, so a partial refresh
    cannot temporarily replace the last settled status. The artifact history
    behind it is left alone while the last refresh is recent and already covers
    the runs that list names. Nothing new has been sampled, so there is nothing
    to download.
  - The tile drills through to the per-benchmark history behind `/bench`, which the
    tile's collection keeps warm in the background. The collection lists
    benchmark runs on main. It samples one completed run per shortest-view
    bucket, whatever color it finished, downloads that artifact, and unzips it
    in the process. It then reads each benchmark's timings and CPU. A run's
    color does not say whether it measured anything: `deno bench` exits
    non-zero when one benchmark throws, having already written a complete report
    of the rest, and dropping those runs cost about a seventh of the history in
    blocks a dozen runs long. The artifact decides instead. A report without a
    CPU identity, or one that will not parse, is cached as unusable instead of
    being pooled with measurements from unknown machines; because a run
    attempt's artifact never changes, that verdict is kept rather than retried,
    while a read that failed outright is retried.
    Cache entries written before CPU identity was stored are fetched again.
    Each completed artifact check is persisted before it is counted as
    finished. Only new runs and attempts are fetched after the first fill or a
    server restart. The shortest-view buckets are about 8 minutes wide. The
    first cache fill can therefore download more artifacts.
  - Its **runtime benchmarks** view at `/bench?view=runtime` shows one colored
    line per CPU for **every** benchmark. The lines share a calendar-time axis.
    A late-starting CPU line sits at the right. A single sample appears as a
    point. A stale line visibly ends short of the current date. The dashboard
    tile leaves out the CPU legend to keep the compact chart readable.
    Selectors choose which measurement to plot (**p0** = the fastest sample,
    **mean** = the arithmetic mean, **p75**, **p99**, **p99.5**, **p99.9**,
    **p100** = the slowest) and whether to group by source **file** or sort by
    latest **duration** or **trend**. The mean selector was once labeled
    `p50`, and `?stat=p50` still opens it so that a saved link does not quietly
    fall back to the default column.
    A "key only" checkbox limits the rows and CPU legend to `topic board/journey`
    and `topic board scale/100`. The key benchmarks tile opens this view with
    `key=1` in the URL. Metric, sort, and window changes preserve the filter.
    Clearing it restores the full list. A "hide green" checkbox drops the steady
    ones. A slider from 1
    through 45 days changes the visible calendar range. The displayed samples
    are spread across at most 200 time buckets, so a shorter window uses more of
    the collected samples per day. Each graph chooses its vertical scale after
    ignoring the two lowest and two highest displayed values; those points stay
    in the line but no longer determine the scale, so they may clip instead of
    flattening the rest of the history. A graph with fewer than 20 values uses
    its complete range. Keyboard arrows adjust the window without
    moving focus. Enter applies the range immediately. Another selector carries
    the range into its own navigation, and leaving the controls applies it
    directly. Each row shows one latest value and trend from the CPU with the
    most benchmark samples in the selected window. A tie uses the CPU with the
    newest sample, then its name for a stable result. That representative CPU
    also sets the row color and sorting. A numbered CPU key identifies the
    representative series and links to its definition. The same key and a
    color swatch appear in one CPU legend after all benchmark graphs instead
    of repeating processor names in every row. It includes the full processor
    identity reported by the artifacts, the number of benchmark graphs and runs
    shown for that CPU, and the observed date range. The page reads from the
    server cache so it re-renders instantly. Its progress panel stays visible as
    Idle between
    collections. During collection it shows cached, queued, requested,
    responded, outstanding, and failed artifact checks. Changing the range
    leaves the server collection running and joins it from the new page. The
    page closes with a **rerun hand-off**: a link to GitHub, where the run is
    started. It targets the newest completed run when that run failed, whose
    **Re-run all jobs** repeats it, and the workflow otherwise, whose **Run
    workflow** starts a fresh run. The dashboard's GitHub token is read-only, so
    the board cannot start a run itself, and GitHub decides whether the viewer
    may start one.
  - The **CI duration history** view at `/bench?view=ci` selects either labs
    `deno.yml` or loom `test-fast.yml`. It charts every job's start-to-finish
    duration on one calendar-time axis. An overall row measures the workflow
    from the first job
    start to the last job completion. Jobs that share the trailing-parenthesis
    base name used by `scripts/ci-gantt.ts` are shown together. Each group starts
    with a slowest-shard line, followed by the individual shard lines. The
    slider covers 1 through 45 days. It keeps every successful main build when
    there are at most 200. Larger sets keep exactly 200 builds spread evenly
    through the chronological run sequence. A coverage label compares the
    sampled builds shown with every successful main build in the selected
    range. The view can group by job or sort every line by latest duration or
    robust trend. Its graphs use the same vertical-scale trimming as runtime
    benchmark history.
    It renders cached history immediately. The progress panel remains visible
    as Idle between collections, then shows live collection progress with
    cached, queued, requested, responded, outstanding, and failed run counts.
    On both history pages, a failed collection remains in the Idle panel until
    a later collection for that history view succeeds.
    Open runtime benchmark and CI history pages check for newer server data once
    a minute. An open Gantt regenerates every 30 minutes and whenever its tab
    becomes visible. CI refreshes share a 30-minute GitHub freshness window, so
    multiple pages do not repeat the same API reads. Runtime and CI history
    checks wait through the same window after GitHub rejects a collection.
    Moving the window slider starts or joins the matching collection without
    cancelling wider-window work already in progress.
  - Every GitHub API request made by the three performance views reserves rate
    capacity before it starts. Each guarded request batch reads GitHub's current
    rate-limit status before reserving. Collection stops before projected
    in-flight requests would pass 80% of the token's hourly core limit. It also
    stops at 720 REST request points in a rolling minute, which is 80% of
    GitHub's documented 900-point limit. The page reports either boundary as a
    rate limit hit. It does not wait or retry there. Reservations and request
    times are locked and stored in the fixed
    `fabric-wall-github-rate-limit.json` file in the dashboard cache directory, so
    overlapping dashboard processes and restarts share the same budget. Tokens
    are represented by SHA-256 hashes in that file. Only `/bench` collection
    reserves capacity or can be stopped by the ledger. Other dashboard GitHub
    requests do not read or update it and proceed normally.
  - Completed workflow-attempt timings are written atomically to two places in
    the dashboard cache directory, split by how much of each attempt a view
    needs. The fixed `fabric-wall-ci-run-index.json` file holds one entry per
    attempt: its run metadata and the duration of each job. That is everything
    the CI duration charts read, and it is small enough to hold in memory for
    the whole retention window. The `fabric-wall-ci-gantt` directory beside it
    holds one gzipped file per attempt carrying every job's steps, which is
    around forty times larger per attempt before compression and is what the
    Gantt views draw. Steps repeat the same few names and the same timestamp
    prefixes over and over, so an attempt compresses to roughly a twentieth of
    its size, and every attempt the run index keeps can afford to keep its
    detail. An attempt loses its detail only when it leaves the index
    altogether, so nothing GitHub would have to serve again is discarded early.
    A Gantt request reads only the attempt files for the runs on its chart, at
    most the 150 the range slider allows, and a duration refresh reads none of
    them. The runs on a chart are read and handed to the renderer one at a time,
    so serving a chart never holds all of its timings at once.
    An attempt whose file is missing, or holds a layout this version cannot
    read, is collected from GitHub again, so a chart never draws a run with no
    timings and a damaged file repairs itself.
    A `fabric-wall-ci-job-history.json` file in the cache directory holds a
    layout the dashboard does not read, and reaches hundreds of megabytes. A
    process that finds one deletes it, along with its lock and any temporary
    file left beside it, without parsing it, and collects the current window
    from GitHub instead.
    A workflow run is kept as the fields the dashboard reads rather than as
    GitHub returns it. A run in a query result carries its repository, head
    repository, whole head commit, and both actors, which is around fifty times
    the size of the fields any view uses, and a discovery window is thousands of
    runs held for the length of the freshness window.
    CI history and the detailed `/bench?view=gantt` view use the same entries.
    The three performance views share one selector and preserve the applicable
    repository, range, sort, and runtime statistic while moving between them.
    They also share the styles for their page header, selector, controls,
    progress panel, time axis, and history rows.
    The next collection loads those timings before reading GitHub, so it only
    fetches jobs for new sampled runs, uncached Gantt runs, and new attempts.
    Cached history remains visible when no GitHub token is configured or a
    refresh fails. Each completed response is placed in the shared cache and
    persisted while the rest of its collection continues, including responses
    from a window the browser has since left.
    The cache also stores each window's exact sampled run attempts, partial-read
    state, last completed refresh, and the complete set of successful-run
    timestamps used by its coverage label. A new dashboard process therefore
    renders the same chart, warning, and coverage while honoring the remaining
    part of the 30-minute freshness window without querying GitHub. Dashboard
    processes that share the file lock it while merging and atomically replacing
    entries. Attempts referenced by the last completed chart remain in the
    cache while a rerun is being collected. An interrupted or rate-limited
    collection records that its earlier manifest is no longer fresh, so a
    restart keeps the completed chart visible but resumes collection.
  - Runtime benchmark artifact results are written atomically to
    the fixed `fabric-wall-benchmark-history.json` file in the dashboard cache
    directory.
    Successful reads and definitive empty results are retained for 60 days. A
    failed read remains uncached so a later scheduled collection can establish
    whether the artifact exists. Dashboard processes that share the file lock it
    while merging and replacing the stored run attempts. The exact run attempts
    behind the last completed refresh, including the reason for a definitive
    empty result, are stored in the same file. Attempts used by that completed
    refresh remain available while a rerun is incomplete. Restarting the
    dashboard therefore reconstructs the same chart without immediately
    rediscovering benchmark runs that are still within the 30-minute freshness
    window. An interrupted replacement is persisted as stale and is retried.
- **Deploying these gated tiles** follows the same pattern as the existing ones:
  add the value to Secret Manager, wire an ExternalSecret in
  `dashboard-secrets.yaml`, and add the env to `03-deployment.yaml` (see the
  Deploying section below).

Everything below is a tunable constant in `config.ts`:

- **Status thresholds:** `TRUST_GOOD`/`TRUST_WARN` (first-try-green %), `DUR_GOOD`/`DUR_WARN` (median CI minutes).
- **Data windows:** The shared fetch returns at most `CI_RUNS_MAX=200` workflow runs and stops at `CI_RUNS_MAX_AGE_DAYS=60` days. CI trust uses the newest `TRUST_RUNS_MAX=160` fetched runs. CI duration uses whichever is larger: `DUR_MIN_RUNS=20` passing runs or `DUR_MAX_AGE_HOURS=6` hours. The benchmark trend uses the same larger-of-the-two idea in days: `BENCH_TREND_MIN_RUNS=20` runs or `BENCH_TREND_MAX_AGE_DAYS=14` days. Recent runs shows `RECENT_DISPLAY=50` entries.
- **ci-trust cell grid:** The grid has up to `TRUST_RUNS_MAX=160` square cells in rows of `TRUST_COLS=40`. On wide tiles, the squares stop growing and the columns spread out to keep the grid clear of the subheading while preserving its equal left, right, and bottom insets. First-try successes are green. In-progress runs are blue. Completed runs that lower the trust percentage are red. Ignored runs, a run cancelled on every attempt among them, are gray.

## Local development

Local-first: no build step, no deployment, a single process on `localhost`.

- One-shot: `deno task dashboard`.
- Watch mode from `packages/dashboard` (reloads the server on any edit to a tile
  or the core): `deno task watch`.

Env knobs for the dev loop:

- `GH_TOKEN` (or `GITHUB_TOKEN`) — required for the GitHub tiles. GitHub spend
  also needs Administration read. GitHub users also needs Members read. Without
  the token, those tiles stay gray.
- `DASHBOARD_PORT` — run several instances at once (e.g. one per branch) without clashing.
- `DASHBOARD_REPO` — point the CI tiles at any repo. Its owner selects the
  organization for GitHub users.
- `ESTUARY_URL` and `RAPIDS_URL` — point either production-tile health check at
  a local server. `PROD_URL` remains an alias for `ESTUARY_URL`.
- `COMMON_FABRIC_URL` — replace the public-site target in the production tile.
- `BASTION_HOST` — replace the default bastion hostname the production tile
  checks.
- `PROD_PROXY` — route the estuary and rapids health checks through a proxy, for
  example `socks5h://127.0.0.1:1055` with a local Tailscale userspace proxy.
- The other credential envs (see **Credentials** above — `SIGNOZ_*`, `GCP_*`,
  `OPENAI_ADMIN_KEY`/`ANTHROPIC_ADMIN_KEY`/`OPENROUTER_KEY`, `DISCORD_*`) — set
  one to develop that gated tile against its real backend.

It never crashes on a missing credential: the GitHub tiles need `GH_TOKEN` and
the other private-source tiles each need their own env var, and any tile whose
`collect()` throws (missing token, offline) just shows a gray "unknown" while the
rest of the board keeps working — so you can develop against whatever you happen
to have access to.

Developing one tile in isolation: a tile is a pure `collect(ctx) -> TileView`, so
you can exercise it with a hand-made `Ctx` in a `deno test`, no server or live
source required:

```ts
const fakeCtx = { runs: async () => FIXTURE_RUNS, env: (_: string) => undefined };
const view = await myTile.collect(fakeCtx);
// assert on view.status / view.value …
```

### Tests

```bash
cd packages/dashboard
deno task test
```

`lib.test.ts` covers the pure helpers; `tiles.test.ts` covers each tile's
`collect()` — the CI tiles against canned runs, and the token-gated tiles'
gray-out contract. These ordinary unit tests are hermetic and need only
`--allow-env` for module-load configuration reads. The full `test` task also
verifies that Resvg reproduces the embedded PNGs and runs the favicon
behavior in the local browser test runner. The package tasks grant the additional
permissions those two checks need. `tiles/prod-uptime.test.ts` exercises the
production tile's public-site, health, DNS, and proxy checks with canned HTTP
responses, an injected DNS resolver, an injected proxy client factory, and a
fake SOCKS5 proxy, so its unit tests never reach the network. This is
a workspace package, so its ordinary unit tests also run as part of the repo-wide
`deno task test`.

## Deploying (stage GKE, tailnet-only)

The deploy artifacts follow the golink pattern. `Dockerfile.dashboard` (labs repo
root) builds the image; the manifests, ExternalSecrets, and tofu secret
containers live in the **infra** repo (`k8s/manifests/dev-dashboard/`,
`k8s/overlays/stage/external-secrets/dashboard-secrets.yaml`,
`tofu/gke/secrets.tf`), and it is wired into `make apply-dev-dashboard-stage` and
`apply-all.sh`. Access is tailnet-only at `https://dashboard.<tailnet>.ts.net`
via a userspace Tailscale sidecar (the one adaptation golink gets for free from
its embedded tsnet).

**One-time setup (human steps):**

1. Tailscale admin console: add `tag:dashboard` to `tagOwners`, grant who may
   reach it, and configure a federated identity restricted to `auth_keys` and
   `tag:dashboard`. The infra overlay supplies that identity's public client ID
   with `ephemeral=false&preauthorized=true` and its audience; no Tailscale auth
   key or OAuth secret is stored in Kubernetes or Secret Manager. The tailnet
   also needs MagicDNS and HTTPS certificates enabled — `tailscale serve`
   fetches a cert for `dashboard.<tailnet>.ts.net` and can't without them.
2. `tofu apply` in `infra/tofu/gke` creates the dev-dashboard Secret Manager
   containers and Workload Identity/BigQuery grants. Store the required GitHub
   token (and each provider credential you want to enable):
   ```bash
   printf %s "github_pat_…" | gcloud secrets versions add k8s-stage-dashboard-github-token --data-file=-
   ```
   The GitHub token is fine-grained and read-only. It has Actions read for the
   dashboard repositories. The GitHub users tile also needs org Members read;
   GitHub spend also needs org Administration read.
3. The infra manifests create separate 1 Gi `standard-rwo` PVCs for the Discord
   history file and Tailscale node state. The dashboard remains a one-replica
   `Recreate` Deployment; pod replacement reuses the same non-ephemeral
   Tailscale node ID and `dashboard.<tailnet>.ts.net` name.

**Build, push, deploy**

`.github/workflows/dashboard-image.yml` publishes the image, and it publishes
only from `main`. A push to `main` starts it when the dashboard image, the
dashboard package, the Gantt drill-down, the Deno dependency metadata, or the
workflow itself changes. You can also start it by hand from the repository's
Actions tab, which is how to publish a `main` commit whose files fall outside
that path list. A manual run can name any branch or tag, so the workflow's
first step fails a run that is not on `main`: publishing moves the `latest` tag
the stage deployment follows. That step runs before anything from the named ref
is checked out.

The workflow runs the dashboard tests, then builds the amd64 image and pushes
it under both the immutable `dev-dashboard:<full-sha>` tag and `latest`. Once a
SHA tag exists, a rerun of that commit reuses its digest: it moves `latest` onto
the image already there rather than rebuilding it or repushing the immutable
tag.

The same tests also run in CI, on pull requests and on main alike, because the
dashboard is a workspace package and CI's `Test` job runs each package's test
task. The publish workflow runs them again rather than leaning on that. The two
workflows are independent — neither waits for the other, and this one cannot
read CI's verdict — so its own test job is the only thing standing between a
dashboard that fails its tests and the `latest` tag. Leave it in place even
though it looks redundant.

What that test job does not do is record what it runs. CI records the same
task on the same commit, so a second recording here would file each of those
tests twice against one commit. The job therefore sets no spool directory,
wraps nothing in `run-recorded`, and ships no test-records artifact, and the
relay does not follow this workflow.

No image is built or published for a pull request.

The publish job authenticates with GitHub OIDC and GCP Workload Identity
Federation. It emits the immutable `sha256:` image reference in the workflow
summary; no service-account JSON key is used.

The manual trigger publishes whatever `main` currently points at. To publish
some other commit, build and push it by hand:

```bash
SHA=$(git rev-parse HEAD)
IMG=us-central1-docker.pkg.dev/commontools-core/containers/dev-dashboard
docker build --platform=linux/amd64 \
  --build-arg DASHBOARD_GIT_COMMIT="$SHA" \
  -f Dockerfile.dashboard -t "$IMG:$SHA" .
docker push "$IMG:$SHA"
```

Copy the published digest — from the workflow summary, or from `docker push`'s
output for a hand build — into the infra stage overlay's `images[].digest`,
commit that immutable pin, then run
`make apply-dev-dashboard-stage` from `infra/k8s`. The node then appears in the
Tailscale console as `tag:dashboard`; open
`https://dashboard.<tailnet>.ts.net/`. (The sidecar image is already pinned by
`@sha256` digest in `03-deployment.yaml`, matching golink.)

**Provider-gated tiles** stay gray until their credential or public configuration
is wired: add the Secret Manager *value* (the container already exists from
`tofu apply`), enable the matching ExternalSecret/env when needed, then re-run
`make apply-dev-dashboard-stage`. Stage's Cloud Billing table is already wired;
during Google's initial export backfill it reports `no billing data yet` rather
than a false zero.

Every backend is reached over HTTP, so the image carries no cloud CLI. The
GitHub tiles use `GH_TOKEN`. The cloud-spend tile queries BigQuery as the pod's
own service account through Workload Identity. The infra repo's
`tofu/gke/dashboard.tf` provisions that account, the Workload Identity binding,
and its BigQuery Job User and Data Viewer grants, so no key is stored in the
cluster. The stage deployment sets `GCP_BILLING_TABLE` to the standard export
table, and `dashboard_billing_dataset` scopes its dataset reader grant.

## Design notes

A couple of choices the code alone doesn't explain:

- **Calm by default, three signals.** A tile is only ever good, warn, or bad,
  plus a gray "unknown" when its source is missing or a collector errors. There
  is no finer severity scale: green means fine, red means act now, and anything
  the board can't judge goes gray rather than crying wolf. The layout is built
  for glanceability — readable in a second from across the room — so it stays
  dark and free of attention-grabbing animation, and it reports on the system
  rather than on individuals. A failing collector degrades to gray with a short
  reason instead of blanking or alarming, and the header's "updated Ns ago" is a
  deliberately honest liveness signal. `/healthz` reports whether the board has
  collected anything; point an external uptime check (on a different host) at it,
  since a board that can't reach its own sources can't page you about itself.
- **Why Deno + TypeScript.** The dashboard lives in the labs workspace and shares
  its one toolchain and the team's TypeScript fluency. An earlier rationale — that
  it would import the repo's performance tooling in-process — no longer holds: it
  fetches the same GitHub JSON directly. If it ever needs a single self-contained
  binary with no runtime dependencies, a compiled language would be worth
  reconsidering; today the workspace fit wins.
