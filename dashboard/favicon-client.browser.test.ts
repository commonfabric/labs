import { assertEquals } from "@std/assert";
import { paintStatusFavicon } from "./favicon-client.ts";

const HREFS = {
  good: "/favicon.png?status=good",
  warn: "/favicon.png?status=warn",
  bad: "/favicon.png?status=bad",
  "bad-crying": "/favicon.png?status=bad-crying",
};
const HOUR = 60 * 60 * 1000;

function arrange(...statuses: string[]): void {
  let favicon = document.querySelector<HTMLLinkElement>(
    'link[data-favicon-test="true"]',
  );
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/png";
    favicon.dataset.faviconTest = "true";
    document.head.prepend(favicon);
  }
  favicon.href = HREFS.good;

  let fixture = document.getElementById("favicon-test-tiles");
  if (!fixture) {
    fixture = document.createElement("div");
    fixture.id = "favicon-test-tiles";
    document.body.append(fixture);
  }
  fixture.replaceChildren(...statuses.map((status) => {
    const tile = document.createElement("div");
    tile.className = `tile ${status}`;
    return tile;
  }));
}

function paint(
  serverRedSince: number | null = null,
  serverRedAgeMs: number | null = null,
  startedAt = 0,
  now = 0,
): string | null {
  paintStatusFavicon(
    HREFS,
    HOUR,
    serverRedSince,
    serverRedAgeMs,
    startedAt,
    now,
  );
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    ?.getAttribute("href") ?? null;
}

Deno.test("dashboard status and server red age select the favicon", () => {
  arrange("unknown");
  assertEquals(paint(), HREFS.good);

  arrange("unknown", "warn");
  assertEquals(paint(), HREFS.warn);

  arrange("warn", "bad");
  assertEquals(paint(1, HOUR - 1), HREFS.bad);
  assertEquals(paint(1, HOUR - 1, 0, 1), HREFS["bad-crying"]);

  // The server timestamp can be ahead of or behind the browser clock. Only the
  // measured age drives the threshold.
  arrange("bad");
  assertEquals(paint(30_000_000, 1_000), HREFS.bad);
  assertEquals(paint(1, HOUR), HREFS["bad-crying"]);

  // A page loaded without a server incident ages its visible red state locally.
  arrange("bad");
  assertEquals(paint(null, null, 5_000, 5_000 + HOUR - 1), HREFS.bad);
  assertEquals(
    paint(null, null, 5_000, 5_000 + HOUR),
    HREFS["bad-crying"],
  );

  document.querySelector('link[data-favicon-test="true"]')?.remove();
  document.getElementById("favicon-test-tiles")?.remove();
});
