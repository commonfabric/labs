/**
 * Keeps a drill-down page current while it is open, so a page left up on a
 * screen shows what the dashboard knows now rather than what it knew when the
 * page loaded.
 *
 * A route marked `live` serves a page that carries `LIVE_PAGE_CLIENT` and
 * keeps everything that changes inside its `<main>` element. The page opens
 * an event stream naming itself, `/events?page=<its path and query>`. On
 * every serving tick the server sends a heartbeat down that stream and
 * renders the page again, and it sends the new markup whenever that differs
 * from what it sent before. The page replaces its `<main>` with the one in
 * the new markup. Every page event also names the
 * version the server is serving, and a page built by a different version
 * reloads instead, so the styles and script outside `<main>` follow a
 * deployment too.
 *
 * The page reopens its stream the way the dashboard does (`stream-client.ts`),
 * and its badge says whether it can hear the server.
 */

import { TICK_MS } from "./config.ts";
import { statusLayer } from "./theme.ts";
import { reconcileMain } from "./live-page-client.ts";
import { followUpdates, liveUpdateStream } from "./stream-client.ts";
import type { Route } from "./types.ts";
import { SERVING_VERSION } from "./version.ts";

/**
 * How long a page goes without hearing the server before it replaces its
 * stream. The server is heard on every tick, so this allows two to go missing.
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

  const leave = (key: string, client: Client) => {
    const page = watched.get(key);
    if (!page) return;
    page.clients.delete(client);
    page.joined.delete(client);
    if (page.clients.size === 0) watched.delete(key);
  };

  const deliver = (key: string, clients: Iterable<Client>, event: string) => {
    const bytes = encoder.encode(event);
    for (const client of [...clients]) {
      try {
        client.enqueue(bytes);
      } catch {
        leave(key, client);
      }
    }
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
        key,
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
      let client: Client | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller;
          let page = watched.get(key);
          if (!page) {
            page = {
              url: target,
              route,
              clients: new Set(),
              joined: new Set(),
              started: 0,
              applied: 0,
            };
            watched.set(key, page);
          }
          page.clients.add(controller);
          page.joined.add(controller);
          controller.enqueue(encoder.encode(": connected\n\n"));
          void render(key, page);
        },
        cancel() {
          if (client) leave(key, client);
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
      for (const [key, page] of watched) deliver(key, page.clients, beat);
      await Promise.all([...watched].map(([key, page]) => render(key, page)));
    },
  };
}

/** The styles of the badge a live page carries. */
export const LIVE_PAGE_STYLES = `
  .live-badge{font-size:11px;color:var(--status-good-text);border:1px solid ${
  statusLayer("good", 0.4)
};border-radius:6px;padding:2px 8px}
  .live-badge.offline{color:var(--status-unknown-text);border-color:var(--status-unknown)}`;

/** The badge saying whether a live page can hear the server. */
export const LIVE_PAGE_BADGE =
  `<div class="live-badge" id="live-badge" role="status">● LIVE</div>`;

/** Keeps the page it is placed in current. It belongs after `<main>`. */
export const LIVE_PAGE_CLIENT = `<script>{
  const VERSION = ${JSON.stringify(SERVING_VERSION)};
  const liveUpdateStream = ${liveUpdateStream.toString()};
  const followUpdates = ${followUpdates.toString()};
  const reconcileMain = ${reconcileMain.toString()};
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
        if (next && main) reconcileMain(main, next);
      },
    },
  );
  paint();
  setInterval(paint, 1000);
  document.addEventListener('visibilitychange', paint);
  addEventListener('online', paint);
}</script>`;
