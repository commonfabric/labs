/**
 * Covers the event streams that keep an open drill-down page current: what a
 * page is sent when it connects, what a serving tick sends it, and which pages
 * are rendered at all.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  LIVE_PAGE_CLIENT,
  type LivePageEvent,
  livePages,
} from "./live-page.ts";
import type { Route } from "./types.ts";
import { SERVING_VERSION } from "./version.ts";

const decoder = new TextDecoder();

/** A live route whose markup is whatever `markup` holds when it renders. */
function counter(path = "/counted") {
  const state = { markup: "one", renders: 0, urls: [] as string[] };
  const route: Route = {
    path,
    live: true,
    handler: (_req, url) => {
      state.renders++;
      state.urls.push(url.href);
      return new Response(`<main>${state.markup}</main>`);
    },
  };
  return { state, route };
}

/** Opens the stream for `page` and reads it one event at a time. */
function watch(pages: ReturnType<typeof livePages>, page: string) {
  const response = pages.open(
    new URL(`http://dashboard/events?page=${encodeURIComponent(page)}`),
  );
  const reader = response.body!.getReader();
  return {
    response,
    async next(): Promise<string> {
      const { value, done } = await reader.read();
      if (done) throw new Error("the event stream ended");
      return decoder.decode(value);
    },
    close: () => reader.cancel(),
  };
}

/** The markup a page event carries, failing on any other event. */
function markupOf(event: string): LivePageEvent {
  expect(event).toMatch(/^event: page\n/);
  return JSON.parse(event.match(/^data: (.*)$/m)![1]);
}

describe("livePages()", () => {
  it("sends a page its markup and the serving version as it connects", async () => {
    const { route } = counter();
    const page = watch(livePages([route], "v1"), "/counted");
    expect(page.response.headers.get("content-type")).toBe("text/event-stream");
    expect(await page.next()).toBe(": connected\n\n");
    expect(markupOf(await page.next())).toEqual({
      version: "v1",
      html: "<main>one</main>",
    });
    await page.close();
  });

  it("sends a tick's rendering only when the markup changed", async () => {
    const { state, route } = counter();
    const pages = livePages([route], "v1");
    const page = watch(pages, "/counted");
    await page.next();
    await page.next();

    await pages.tick();
    expect(await page.next()).toMatch(/^event: ping\ndata: 1\n\n$/);
    expect(state.renders).toBe(2);

    state.markup = "two";
    await pages.tick();
    expect(await page.next()).toMatch(/^event: ping\ndata: 2\n/);
    expect(markupOf(await page.next()).html).toBe("<main>two</main>");
    await page.close();
  });

  it("sends a second page the markup the first already holds, and the first nothing", async () => {
    const { route } = counter();
    const pages = livePages([route], "v1");
    const first = watch(pages, "/counted");
    await first.next();
    await first.next();

    const second = watch(pages, "/counted");
    await second.next();
    expect(markupOf(await second.next()).html).toBe("<main>one</main>");

    await pages.tick();
    // The heartbeat is the next thing the first page hears, not a copy of
    // the markup it has.
    expect(await first.next()).toMatch(/^event: ping\n/);
    await first.close();
    await second.close();
  });

  it("renders the page each stream names, with its query", async () => {
    const { state, route } = counter();
    const page = watch(livePages([route], "v1"), "/counted?repo=loom");
    await page.next();
    await page.next();
    expect(state.urls).toEqual(["http://dashboard/counted?repo=loom"]);
    await page.close();
  });

  it("stops rendering a page once the last browser showing it has gone", async () => {
    const { state, route } = counter();
    const pages = livePages([route], "v1");
    const page = watch(pages, "/counted");
    await page.next();
    await page.next();
    await page.close();
    await pages.tick();
    expect(state.renders).toBe(1);
  });

  it("refuses a stream for a route that is not live, or not a route", async () => {
    const { route } = counter();
    const still: Route = { ...route, path: "/still", live: undefined };
    const pages = livePages([route, still], "v1");
    for (
      const page of [
        "/still",
        "/nowhere",
        "//elsewhere.example/counted",
        "http://[",
        "",
      ]
    ) {
      const response = pages.open(
        new URL(`http://dashboard/events?page=${encodeURIComponent(page)}`),
      );
      expect(response.status).toBe(404);
      await response.body?.cancel();
    }
  });

  it("applies later renderings while one never finishes, and drops one that finishes late", async () => {
    const { state, route } = counter();
    const held: Array<(response: Response) => void> = [];
    let hold = false;
    const slow: Route = {
      ...route,
      handler: (req, url) =>
        hold
          ? new Promise<Response>((resolve) => held.push(resolve))
          : route.handler(req, url),
    };
    const pages = livePages([slow], "v1");
    const page = watch(pages, "/counted");
    await page.next();
    await page.next();

    hold = true;
    await Promise.race([pages.tick(), Promise.resolve()]);
    expect(await page.next()).toMatch(/^event: ping\n/);
    hold = false;
    state.markup = "two";
    await pages.tick();
    expect(await page.next()).toMatch(/^event: ping\n/);
    expect(markupOf(await page.next()).html).toBe("<main>two</main>");

    held[0](new Response("<main>stale</main>"));
    await pages.tick();
    // The heartbeat follows the page it already holds, not the late one.
    expect(await page.next()).toMatch(/^event: ping\n/);
    state.markup = "three";
    await pages.tick();
    await page.next();
    expect(markupOf(await page.next()).html).toBe("<main>three</main>");
    await page.close();
  });

  it("keeps a page's stream open through a rendering that throws", async () => {
    const { state, route } = counter();
    let fail = false;
    const flaky: Route = {
      ...route,
      handler: (req, url) => {
        if (fail) throw new Error("source unreachable");
        return route.handler(req, url);
      },
    };
    const pages = livePages([flaky], "v1");
    const page = watch(pages, "/counted");
    await page.next();
    await page.next();

    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      fail = true;
      await pages.tick();
    } finally {
      console.error = error;
    }
    expect(logged).toEqual([["live page /counted:", "source unreachable"]]);
    await page.next();

    fail = false;
    state.markup = "two";
    await pages.tick();
    await page.next();
    expect(markupOf(await page.next()).html).toBe("<main>two</main>");
    await page.close();
  });
});

describe("LIVE_PAGE_CLIENT", () => {
  it("expects the version the streams report, so it reloads on any other", async () => {
    const { route } = counter();
    const page = watch(livePages([route]), "/counted");
    await page.next();
    const { version } = markupOf(await page.next());
    expect(version).toBe(SERVING_VERSION);
    expect(LIVE_PAGE_CLIENT).toContain(
      `const VERSION = ${JSON.stringify(version)};`,
    );
    // Parses the script without running it, which is where a leftover type
    // annotation in an injected function would show up.
    new Function(LIVE_PAGE_CLIENT.match(/^<script>([\s\S]*)<\/script>$/)![1]);
    await page.close();
  });
});
