#!/usr/bin/env -S deno run --allow-net --allow-run=deno,git --allow-read --allow-write --allow-env

/**
 * Runs the dashboard: the live page everything else in this package feeds.
 * Each tile lives under tiles/ and is registered once in registry.ts, and
 * this file stays generic about all of them. It schedules every tile's
 * collect() on that tile's own interval, renders the results uniformly, serves
 * the page, pushes updates down the event stream, and mounts whatever
 * drill-down routes a tile declares. It knows nothing about individual tiles.
 *
 *   cd <repo root>
 *   deno run --allow-net --allow-run=deno,git --allow-read --allow-write \
 *     --allow-env packages/dashboard/server.ts
 *   open http://localhost:8731
 *
 * The token-gated tiles read optional environment variables, and each one
 * grays out cleanly when its own is unset:
 *   SIGNOZ_URL, SIGNOZ_API_KEY        production error-rate tile
 *   GCP_BILLING_TABLE                 cloud-spend tile, over the BigQuery REST
 *                                     API, authenticating as the workload in
 *                                     GKE or with GCP_SA_KEY locally
 *   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID   online-by-role tile
 *   GH_TOKEN                          GitHub tiles; read access to the
 *                                     organization's members also powers the
 *                                     organization-users tile
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import { CI_WORKFLOW, PORT, REPO, TICK_MS } from "./config.ts";
import { TILES } from "./registry.ts";
import { makeCtx } from "./ctx.ts";
import { escapeHtml, friendlyError, githubOperationsInProgress } from "./lib.ts";
import { faviconPng, faviconStatus } from "./favicon.ts";
import type { FaviconStatus } from "./favicon.ts";
import { renderTile, shell } from "./render.ts";
import type { Ctx, Run, RunSource, Tile, TileView } from "./types.ts";
import { livePages } from "./live-page.ts";
import { SERVING_VERSION } from "./version.ts";
import {
  DASHBOARD_MESSAGE_MAX_LENGTH,
  type DashboardMessage,
  DashboardMessageStore,
} from "./dashboard-message.ts";

const ctx = makeCtx();
const views = new Map<string, TileView>();
const lastRun = new Map<string, number>();
const activityBadges = new Map<string, string>();
const lastActivityRun = new Map<string, number>();
const activeActivityUpdates = new Set<string>();
const runSnapshots = new Map<string, Run[]>();
const runSourceErrors = new Map<string, string>();
const lastSourceTileRun = new Map<string, number>();
interface ActiveTileUpdate {
  count: number;
  startedAt: number;
  stale: boolean;
}
const activeTileUpdates = new Map<string, ActiveTileUpdate>();
const activeRunSourceUpdates = new Set<string>();
let lastChange = 0;
let faviconRedSince: number | null = null;
const dashboardMessageStore = new DashboardMessageStore();
let dashboardMessage: DashboardMessage = {
  text: "",
  updatedAt: null,
  revision: 0,
};

export function nextFaviconRedSince(
  current: number | null,
  status: FaviconStatus,
  now: number,
): number | null {
  return status === "bad" ? current ?? now : null;
}

function updateFaviconRedSince(now: number, recoveryIsSettled = true): void {
  const status = faviconStatus(
    TILES.flatMap((tile) => {
      const view = views.get(tile.label);
      return view ? [activeTileView(tile, view).status] : [];
    }),
  );
  if (status === "bad" || recoveryIsSettled) {
    faviconRedSince = nextFaviconRedSince(faviconRedSince, status, now);
  }
}

interface DashboardUpdate {
  gridHtml: string;
  wideHtml: string;
  ageSeconds: number;
  shellVersion: string;
  faviconStatus: FaviconStatus;
  faviconRedSince: number | null;
  faviconRedAgeMs: number | null;
  message: DashboardMessage;
}

function dashboardUpdate(currentViews: ReadonlyMap<string, TileView> = views): DashboardUpdate {
  const grid: string[] = [];
  const wide: string[] = [];
  const statuses: TileView["status"][] = [];
  for (const t of TILES) {
    const v = activeTileView(t, currentViews.get(t.label) ?? { status: "unknown" });
    statuses.push(v.status);
    (t.wide ? wide : grid).push(renderTile(t.label, v, t.wide));
  }
  const now = Date.now();
  const ageSeconds = lastChange
    ? Math.max(0, Math.floor((now - lastChange) / 1000))
    : 0;
  return {
    gridHtml: grid.join(""),
    wideHtml: wide.join(""),
    ageSeconds,
    shellVersion: SERVING_VERSION,
    faviconStatus: faviconStatus(statuses),
    faviconRedSince,
    faviconRedAgeMs: faviconRedSince === null
      ? null
      : Math.max(0, now - faviconRedSince),
    message: { ...dashboardMessage },
  };
}

async function refreshDashboardMessage(): Promise<boolean> {
  try {
    const refreshed = await dashboardMessageStore.refresh();
    const previous = dashboardMessage;
    dashboardMessage = refreshed.message;
    return refreshed.expired ||
      previous.text !== dashboardMessage.text ||
      previous.updatedAt !== dashboardMessage.updatedAt ||
      previous.revision !== dashboardMessage.revision;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
const encodeUpdate = (update: DashboardUpdate) =>
  enc.encode(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
const send = (event: Uint8Array) => {
  for (const c of clients) {
    try {
      c.enqueue(event);
    } catch {
      clients.delete(c); // drop a dead controller so the set can't grow forever
    }
  }
};
export const broadcast = (update: DashboardUpdate) => send(encodeUpdate(update));
// A tick that collects nothing publishes nothing, so a browser cannot read
// silence as a fault unless the server speaks on its own schedule. The
// heartbeat is that schedule: a browser that stops hearing it replaces its
// stream. The SSE data field carries the tick count because an event with no
// data is not delivered to the page.
let beats = 0;
export const heartbeat = () => send(enc.encode(`event: ping\ndata: ${++beats}\n\n`));

const runSourceKey = (source: RunSource): string => `${source.repo} ${source.workflow}`;
const runSourceTileKey = (source: RunSource, tile: Tile): string => `${runSourceKey(source)} ${tile.label}`;

function beginTileUpdate(tile: Tile, startedAt: number): void {
  const active = activeTileUpdates.get(tile.label);
  if (active) {
    active.count++;
  } else {
    activeTileUpdates.set(tile.label, {
      count: 1,
      startedAt,
      stale: false,
    });
  }
}

function finishTileUpdate(tile: Tile): void {
  const active = activeTileUpdates.get(tile.label);
  if (!active || active.count === 1) activeTileUpdates.delete(tile.label);
  else active.count--;
}

function allUpdatesSettled(): boolean {
  return activeTileUpdates.size === 0 && activeRunSourceUpdates.size === 0;
}

const STALE_UPDATE_MS = 60_000;
const STALE_UPDATE_SUB = "refresh still pending";

function activeTileView(tile: Tile, view: TileView): TileView {
  const badge = activityBadges.get(tile.label);
  if (badge) view = { ...view, aside: badge + (view.aside ?? "") };
  if (!activeTileUpdates.get(tile.label)?.stale) return view;
  return tile.showOnlyCompletedViews
    ? { ...view, sub: STALE_UPDATE_SUB }
    : { ...view, status: "unknown", sub: STALE_UPDATE_SUB };
}

function grayStaleTileUpdates(now: number): void {
  const newlyStale: string[] = [];
  for (const [label, active] of activeTileUpdates) {
    if (active.stale || now - active.startedAt < STALE_UPDATE_MS) continue;
    active.stale = true;
    newlyStale.push(`"${label}" (${Math.max(0, now - active.startedAt)} ms)`);
  }
  if (newlyStale.length) {
    const sources = [...activeRunSourceUpdates];
    const github = githubOperationsInProgress(now).map((operation) =>
      `${operation.id} ${operation.path} (${operation.stage}, ${operation.elapsedMs} ms)`
    );
    console.error(
      `dashboard refresh still pending: tiles ${newlyStale.join(", ")}; ` +
        `active run sources ${sources.length ? sources.join(", ") : "none"}; ` +
        `active GitHub operations ${github.length ? github.join(", ") : "none"}`,
    );
    lastChange = now;
    updateFaviconRedSince(now, false);
    broadcast(dashboardUpdate());
  }
}

interface RunSourceGroup {
  source: RunSource;
  tiles: Tile[];
}

function groupRunSources(tiles: Tile[]): RunSourceGroup[] {
  const groups = new Map<string, RunSourceGroup>();
  for (const tile of tiles) {
    for (const source of tile.runSources ?? []) {
      const key = runSourceKey(source);
      const group = groups.get(key);
      if (group) {
        if (!group.tiles.includes(tile)) group.tiles.push(tile);
      } else {
        groups.set(key, { source, tiles: [tile] });
      }
    }
  }
  return [...groups.values()];
}

function snapshotCtx(base: Ctx, snapshots: ReadonlyMap<string, Run[]>): Ctx {
  const runsFor = (repo: string, workflow: string) =>
    Promise.resolve(snapshots.get(runSourceKey({ repo, workflow })) ?? []);
  return {
    runs: () => runsFor(REPO, CI_WORKFLOW),
    runsFor,
    env: base.env,
  };
}

// When the newest run in a snapshot started, for comparing one fetch of a source
// against the last one that was kept. A snapshot with no readable start times
// counts as having no runs at all.
function newestRunAt(runs: readonly Run[] | undefined): number {
  let newest = -Infinity;
  for (const run of runs ?? []) {
    const at = Date.parse(run.created_at);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

function sourceLabel(source: RunSource): string {
  return source.repo.split("/").at(-1) ?? source.repo;
}

function withSourceHealth(
  tile: Tile,
  view: TileView,
  snapshots: ReadonlyMap<string, Run[]>,
  errors: ReadonlyMap<string, string>,
): TileView {
  const problems: string[] = [];
  for (const source of tile.runSources ?? []) {
    const key = runSourceKey(source);
    const error = errors.get(key);
    if (error) problems.push(`${sourceLabel(source)} ${friendlyError(error)}`);
    else if (!snapshots.has(key)) problems.push(`${sourceLabel(source)} pending`);
  }
  return problems.length ? { ...view, status: "unknown", sub: problems.join(" · ") } : view;
}

async function collectView(
  tile: Tile,
  collectionCtx: Ctx,
  publish?: (view: TileView) => void,
): Promise<TileView> {
  let acceptingIntermediate = true;
  try {
    try {
      return await tile.collect(
        collectionCtx,
        publish && !tile.showOnlyCompletedViews
          ? (intermediate) => {
            if (acceptingIntermediate) publish(intermediate);
          }
          : undefined,
      );
    } finally {
      acceptingIntermediate = false;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`tile "${tile.label}" failed:`, msg);
    const prev = views.get(tile.label);
    return prev
      ? { ...prev, status: "unknown", sub: friendlyError(msg) }
      : { status: "unknown", value: "—", sub: friendlyError(msg) };
  }
}

function publishViews(collected: { tile: Tile; view: TileView }[], recoveryIsSettled: boolean): void {
  const now = Date.now();
  for (const { tile, view } of collected) {
    views.set(tile.label, view);
    lastRun.set(tile.label, now);
  }
  lastChange = now;
  updateFaviconRedSince(now, recoveryIsSettled);
  broadcast(dashboardUpdate());
}

// A tile publishes an intermediate view when one part of its data is ready
// ahead of the rest, and a chart is drawn from the part that takes longest.
// The view replaces the whole tile, so one that carries no chart keeps the
// chart already on the tile instead of leaving it bare until the collection
// finishes. A completed view carries every part and is taken as it stands,
// so a chart its collection no longer draws leaves the tile.
function withChartOnTile(previous: TileView | undefined, view: TileView): TileView {
  if (view.extra !== undefined || previous?.extra === undefined) return view;
  const { extra, duration, alignChartBottom } = previous;
  return { ...view, extra, duration, alignChartBottom };
}

function publishIntermediateView(tile: Tile, view: TileView): void {
  const now = Date.now();
  views.set(tile.label, withChartOnTile(views.get(tile.label), view));
  lastChange = now;
  updateFaviconRedSince(now, false);
  broadcast(dashboardUpdate());
}

// One ticker collects every tile that is due (respecting each tile's interval).
// Later ticks skip work that is still running and collect the other due tiles.
export async function tick(tiles: Tile[] = TILES, sourceCtx: Ctx = ctx) {
  const now = Date.now();
  grayStaleTileUpdates(now);
  const sourceGroups = groupRunSources(tiles);
  const sourceTiles = new Set(sourceGroups.flatMap((group) => group.tiles));
  const activeAtTickStart = new Set(activeTileUpdates.keys());
  const dueTiles = tiles.filter((tile) =>
    !sourceTiles.has(tile) &&
    !activeAtTickStart.has(tile.label) &&
    now - (lastRun.get(tile.label) ?? 0) >= tile.intervalMs
  );
  const dueSources = sourceGroups.flatMap((group) => {
    if (activeRunSourceUpdates.has(runSourceKey(group.source))) return [];
    const due = group.tiles.filter((tile) =>
      !activeAtTickStart.has(tile.label) &&
      now - (lastSourceTileRun.get(runSourceTileKey(group.source, tile)) ?? 0) >= tile.intervalMs
    );
    return due.length ? [{ source: group.source, tiles: due }] : [];
  });
  const dueActivity = tiles.filter((tile) =>
    tile.collectActivity && !activeActivityUpdates.has(tile.label) &&
    now - (lastActivityRun.get(tile.label) ?? 0) >= tile.intervalMs
  );
  if (!dueTiles.length && !dueSources.length && !dueActivity.length) return;

  for (const tile of dueTiles) beginTileUpdate(tile, now);
  for (const tile of dueActivity) activeActivityUpdates.add(tile.label);
  for (const group of dueSources) {
    activeRunSourceUpdates.add(runSourceKey(group.source));
    for (const tile of group.tiles) beginTileUpdate(tile, now);
  }

  const refreshTile = async (tile: Tile) => {
    let released = false;
    try {
      const view = await collectView(
        tile,
        sourceCtx,
        (intermediate) => publishIntermediateView(tile, intermediate),
      );
      finishTileUpdate(tile);
      released = true;
      publishViews([{ tile, view }], allUpdatesSettled());
    } finally {
      if (!released) finishTileUpdate(tile);
    }
  };

  const refreshActivity = async (tile: Tile) => {
    let badge = "";
    try {
      if (await tile.collectActivity!(sourceCtx)) {
        badge =
          '<span class="running" title="Workflow queued or running"><span class="rdot"></span>running</span>';
      }
    } catch (error) {
      badge = `<span class="hfacet" title="Workflow activity: ${
        escapeHtml(friendlyError(String(error)))
      }">activity unknown</span>`;
    } finally {
      activeActivityUpdates.delete(tile.label);
      lastActivityRun.set(tile.label, Date.now());
    }
    activityBadges.set(tile.label, badge);
    lastChange = Date.now();
    broadcast(dashboardUpdate());
  };

  // Source fetches and dependent collections run independently. Each tile
  // retains the completed view with the highest snapshot revision.
  let sourceRevision = 0;
  const publishedTileRevision = new Map<string, number>();
  const refreshSource = async (group: RunSourceGroup) => {
    let released = false;
    try {
      let runs: Run[] | undefined;
      let error: string | undefined;
      try {
        runs = await sourceCtx.runsFor(group.source.repo, group.source.workflow);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.error(`run source ${runSourceKey(group.source)} failed:`, error);
      }

      const key = runSourceKey(group.source);
      // A repository's newest run on main only ever moves forward. A fetch that
      // comes back with an older newest run than the one already held read a
      // stale view of the workflow, and publishing it would age the whole tile
      // family backwards without saying so. Keep what is held and name the
      // source stale; the next fetch that reaches a current view clears it.
      if (runs && newestRunAt(runs) < newestRunAt(runSnapshots.get(key))) {
        error = "newest run older than the one already collected";
        console.error(`run source ${key} stale:`, error);
        runs = undefined;
      }
      if (runs) {
        runSnapshots.set(key, runs);
        runSourceErrors.delete(key);
      } else {
        runSourceErrors.set(key, error ?? "temporarily unavailable");
      }
      const snapshots = new Map(runSnapshots);
      const errors = new Map(runSourceErrors);
      const currentCtx = snapshotCtx(sourceCtx, snapshots);
      const revision = ++sourceRevision;
      const publishIntermediate = (tile: Tile, view: TileView) => {
        if (revision < (publishedTileRevision.get(tile.label) ?? 0)) return;
        publishedTileRevision.set(tile.label, revision);
        publishIntermediateView(
          tile,
          withSourceHealth(tile, view, snapshots, errors),
        );
      };
      const collected = await Promise.all(group.tiles.map(async (tile) => ({
        tile,
        view: withSourceHealth(
          tile,
          await collectView(
            tile,
            currentCtx,
            (intermediate) => publishIntermediate(tile, intermediate),
          ),
          snapshots,
          errors,
        ),
      })));
      const current = collected.filter(({ tile }) => revision >= (publishedTileRevision.get(tile.label) ?? 0));
      for (const { tile } of current) publishedTileRevision.set(tile.label, revision);
      const completedAt = Date.now();
      for (const tile of group.tiles) {
        lastSourceTileRun.set(runSourceTileKey(group.source, tile), completedAt);
      }
      activeRunSourceUpdates.delete(runSourceKey(group.source));
      for (const tile of group.tiles) finishTileUpdate(tile);
      released = true;
      publishViews(current, allUpdatesSettled());
    } finally {
      if (!released) {
        activeRunSourceUpdates.delete(runSourceKey(group.source));
        for (const tile of group.tiles) finishTileUpdate(tile);
      }
    }
  };

  await Promise.all([
    ...dueTiles.map(refreshTile),
    ...dueSources.map(refreshSource),
    ...dueActivity.map(refreshActivity),
  ]);
}

/**
 * Clears everything the board has collected — its views, run times, run
 * snapshots, activity badges, and red streak — so that a test sees none of what
 * an earlier test collected. Connected clients and the dashboard message are
 * left as they are. Throws while a collection is still running, because that
 * collection would publish into the board after the reset.
 */
export function resetBoardForTest(): void {
  if (!allUpdatesSettled() || activeActivityUpdates.size) {
    throw new Error("the board cannot be reset while a collection is running");
  }
  views.clear();
  lastRun.clear();
  activityBadges.clear();
  lastActivityRun.clear();
  runSnapshots.clear();
  runSourceErrors.clear();
  lastSourceTileRun.clear();
  lastChange = 0;
  faviconRedSince = null;
}

// Collect drill-down routes declared by tiles.
const routes = TILES.flatMap((t) => t.routes ?? []);
const pages = livePages(routes);

// How often the page actually updates, which the client colors the "updated"
// indicator against (fresh up to this, then stale). The server broadcasts when a
// tile is due, but the 15s ticker only notices a tile is due on the tick after its
// interval elapses (and collection latency pushes that to the tick after that), so
// the real cadence for the fastest tile is its interval plus a tick, not the bare
// interval.
const REFRESH_MS = Math.min(...TILES.map((t) => t.intervalMs)) + TICK_MS;

export function page(currentViews: ReadonlyMap<string, TileView> = views): string {
  const update = dashboardUpdate(currentViews);
  return shell(
    update.gridHtml,
    update.wideHtml,
    update.ageSeconds,
    REFRESH_MS,
    SERVING_VERSION,
    update.faviconStatus,
    update.faviconRedSince,
    update.faviconRedAgeMs,
    update.message,
  );
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/favicon.png") {
    return new Response(faviconPng(url.searchParams.get("status")), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (url.pathname === "/message") {
    if (req.method !== "PUT") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "PUT" },
      });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Expected a JSON request body." }, {
        status: 400,
      });
    }
    if (
      !isObjectNotArray(body) ||
      typeof (body as { text?: unknown }).text !== "string"
    ) {
      return Response.json({ error: "Message text must be a string." }, {
        status: 400,
      });
    }
    const text = (body as { text: string }).text;
    if (text.length > DASHBOARD_MESSAGE_MAX_LENGTH) {
      return Response.json({
        error:
          `Messages are limited to ${DASHBOARD_MESSAGE_MAX_LENGTH} characters.`,
      }, { status: 400 });
    }
    try {
      dashboardMessage = await dashboardMessageStore.set(text);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return Response.json({ error: "Could not save the dashboard message." }, {
        status: 500,
      });
    }
    broadcast(dashboardUpdate());
    return Response.json(dashboardMessage);
  }
  if (url.pathname === "/events" && url.searchParams.has("page")) {
    return pages.open(url);
  }
  if (url.pathname === "/events") {
    await refreshDashboardMessage();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        clients.add(c);
        c.enqueue(enc.encode(": connected\n\n"));
        c.enqueue(encodeUpdate(dashboardUpdate()));
      },
      cancel() {
        if (controller) clients.delete(controller);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname === "/healthz") return Response.json({ ok: views.size > 0, at: lastChange });
  for (const r of routes) {
    if (url.pathname === r.path) return await r.handler(req, url);
  }
  await refreshDashboardMessage();
  return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
}

// One turn of the server's clock: tell every connected browser the server is
// still there, then collect whatever tiles are due while every open live page
// is rendered again.
export async function serveTick(
  collect: () => void | Promise<void> = tick,
): Promise<void> {
  heartbeat();
  if (await refreshDashboardMessage()) broadcast(dashboardUpdate());
  await Promise.all([collect(), pages.tick()]);
}

// The side effects: collect once, keep collecting, and serve. Running the file
// starts them; importing it does not.
export function start(
  serve: typeof Deno.serve = Deno.serve,
  collect: () => void | Promise<void> = tick,
) {
  collect();
  // Returned so a caller can run one turn of the clock on demand.
  const onTick = () => serveTick(collect);
  const timer = setInterval(onTick, TICK_MS);
  const server = serve({
    port: PORT,
    onListen: () => console.log(`\n  Dashboard LIVE:  http://localhost:${PORT}\n  ${TILES.length} tiles registered.\n`),
  }, handle);
  return { timer, server, onTick };
}

// Running the file boots; importing it (the tests do) boots nothing.
if (import.meta.main) start();
