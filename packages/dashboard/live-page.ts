/**
 * Keeps a drill-down page current while it is open, so a page left up on a
 * screen shows what the dashboard knows now rather than what it knew when the
 * page loaded.
 *
 * A route marked `live` serves a page built by `livePage`, which carries
 * `LIVE_PAGE_CLIENT` and keeps everything that changes inside its `<main>`
 * element. The page opens an event stream naming itself,
 * `/events?page=<its path and query>`. On every serving tick the server sends
 * a heartbeat down that stream and renders the page again, and it sends the
 * new markup whenever that differs from what it sent before. The page brings
 * its `<main>` up to date with the one in the new markup (`updateMain`). Every
 * page event also names the version the server is serving, and a page built
 * by a different version reloads instead, so the styles and script outside
 * `<main>` follow a deployment too.
 *
 * The page reopens its stream the way the dashboard does (`stream-client.ts`),
 * and its badge says whether it can hear the server.
 */

import { TICK_MS } from "./config.ts";
import { DETAIL_PAGE_STYLES } from "./detail-page.ts";
import {
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  dashboardThemeToggle,
  statusLayer,
} from "./theme.ts";
import {
  LIVE_PAGE_UPDATE,
  reconcileMain,
  updateMain,
} from "./live-page-client.ts";
import { followUpdates, liveUpdateStream } from "./stream-client.ts";
import type { Route } from "./types.ts";
import { SERVING_VERSION } from "./version.ts";

/**
 * How long a page goes without hearing the server before it replaces its
 * stream: three serving ticks, each of which sends a heartbeat.
 */
const SILENCE_MS = 3 * TICK_MS;

/** The markup the server sends a page, as the event stream carries it. */
export interface LivePageEvent {
  version: string;
  html: string;
}

type Client = ReadableStreamDefaultController<Uint8Array>;

/** A page at least one browser is showing. */
interface Watched {
  url: URL;
  route: Route;
  clients: Set<Client>;

  /** Clients sent nothing since they connected. */
  joined: Set<Client>;

  /** The markup last sent, once there is some. */
  html?: string;

  /** How many renderings have started, and which of them `html` came from. */
  started: number;
  applied: number;
}

export interface LivePages {
  /** The event stream for the page `url` names in its `page` parameter. */
  open(url: URL): Response;

  /** Sends a heartbeat to every open page, then renders each again. */
  tick(): Promise<void>;
}

/** Serves the event streams for the live pages among `routes`. */
export function livePages(
  routes: readonly Route[],
  version: string = SERVING_VERSION,
): LivePages {
  const live = routes.filter((route) => route.live);
  const watched = new Map<string, Watched>();
  const encoder = new TextEncoder();
  let beats = 0;

  // A stream leaves its page as it is cancelled, which is before anything
  // could be sent down it closed.
  const deliver = (clients: Iterable<Client>, event: string) => {
    const bytes = encoder.encode(event);
    for (const client of clients) client.enqueue(bytes);
  };

  // Renderings may overlap, so one that never finishes holds up none after
  // it, and one that finishes after a later one is dropped.
  const render = async (key: string, page: Watched): Promise<void> => {
    const rendering = ++page.started;
    try {
      const response = await page.route.handler(
        new Request(page.url),
        page.url,
      );
      const html = await response.text();
      if (rendering < page.applied) return;
      page.applied = rendering;
      // Every client already holding this markup is left alone, and a client
      // that joined while it was being rendered is sent it.
      const recipients = html === page.html ? page.joined : page.clients;
      page.html = html;
      const event: LivePageEvent = { version, html };
      deliver(
        recipients,
        `event: page\ndata: ${JSON.stringify(event)}\n\n`,
      );
      page.joined.clear();
    } catch (error) {
      console.error(
        `live page ${key}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return {
    open(url: URL): Response {
      const target = URL.parse(url.searchParams.get("page") ?? "", url.origin);
      const route = target?.origin === url.origin
        ? live.find((route) => route.path === target.pathname)
        : undefined;
      if (!target || !route) {
        return new Response("no live page there", { status: 404 });
      }
      const key = target.pathname + target.search;
      const page = watched.get(key) ?? {
        url: target,
        route,
        clients: new Set(),
        joined: new Set(),
        started: 0,
        applied: 0,
      };
      watched.set(key, page);
      let client: Client;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller;
          page.clients.add(controller);
          page.joined.add(controller);
          controller.enqueue(encoder.encode(": connected\n\n"));
          void render(key, page);
        },
        cancel() {
          page.clients.delete(client);
          page.joined.delete(client);
          if (page.clients.size === 0) watched.delete(key);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },

    async tick(): Promise<void> {
      const beat = `event: ping\ndata: ${++beats}\n\n`;
      for (const page of watched.values()) deliver(page.clients, beat);
      await Promise.all([...watched].map(([key, page]) => render(key, page)));
    },
  };
}

/** The styles of the badge a live page carries. */
const LIVE_PAGE_STYLES = `
  .live-badge{font-size:11px;color:var(--status-good-text);border:1px solid ${
  statusLayer("good", 0.4)
};border-radius:6px;padding:2px 8px}
  .live-badge.offline{color:var(--status-unknown-text);border-color:var(--status-unknown)}`;

/** The badge saying whether a live page can hear the server. */
const LIVE_PAGE_BADGE =
  `<div class="live-badge" id="live-badge" role="status">● LIVE</div>`;

/** Keeps the page it is placed in current. It belongs after `<main>`. */
export const LIVE_PAGE_CLIENT = `<script>{
  const VERSION = ${JSON.stringify(SERVING_VERSION)};
  const LIVE_PAGE_UPDATE = ${JSON.stringify(LIVE_PAGE_UPDATE)};
  const liveUpdateStream = ${liveUpdateStream.toString()};
  const followUpdates = ${followUpdates.toString()};
  const reconcileMain = ${reconcileMain.toString()};
  const updateMain = ${updateMain.toString()};
  const paint = () => {
    const hearing = updates.check(Date.now());
    const badge = document.getElementById('live-badge');
    if (!badge) return;
    badge.textContent = hearing ? '● LIVE' : '● OFFLINE';
    badge.classList.toggle('offline', !hearing);
  };
  const updates = followUpdates(
    () => new EventSource('/events?page=' +
      encodeURIComponent(location.pathname + location.search)),
    ${SILENCE_MS},
    paint,
    {
      page: (data) => {
        const page = JSON.parse(data);
        if (page.version !== VERSION) { location.reload(); return; }
        const next = new DOMParser().parseFromString(page.html, 'text/html')
          .querySelector('main');
        const main = document.querySelector('main');
        if (next && main) updateMain(main, next);
      },
    },
  );
  paint();
  setInterval(paint, 1000);
  document.addEventListener('visibilitychange', paint);
  addEventListener('online', paint);
}</script>`;

/** What one rendering of a live page shows, which `livePage` frames. */
export interface LivePageContent {
  /** The page's name, in its tab and, unless `heading` names it, at its top. */
  title: string;
  /** The name at the top of the page, when it is not the page's own. */
  heading?: string;
  /** The styles the page needs beyond those every drill-down page has. */
  styles: string;
  /** The markup beside the name: what the page shows, and its age. */
  head: string;
  /** The markup of the rest of the page. */
  body: string;
  /** The page's own script, as source, run before it follows updates. */
  script?: string;
}

/**
 * The whole of a live page: the drill-down page's frame and theme, the name
 * and the badge at the top, and `content`, with everything that changes from
 * one rendering to the next inside `<main>`.
 */
export function livePage(content: LivePageContent): string {
  const script = content.script === undefined
    ? ""
    : `<script>{${content.script}}</script>\n`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${content.title}</title>
${DASHBOARD_THEME_HEAD}
<style>
${DETAIL_PAGE_STYLES}
${LIVE_PAGE_STYLES}
${content.styles}
</style></head><body><main>
  <div class="top"><a class="back" href="/">← dashboard</a><b>${content.heading ?? content.title}</b>${LIVE_PAGE_BADGE}<span>${content.head}</span></div>
  ${content.body}
</main>
${dashboardThemeToggle()}
${DASHBOARD_THEME_CLIENT}
${script}${LIVE_PAGE_CLIENT}
</body></html>`;
}

/** `livePage(content)` as the response a live route answers with. */
export function livePageResponse(
  content: LivePageContent,
  status = 200,
): Response {
  return new Response(livePage(content), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
