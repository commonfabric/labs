/**
 * Keeps the tab's favicon showing the worst status on the page. This runs in
 * the browser, reading the rendered tiles rather than any data behind them, so
 * it stays right as tiles update in place. A page that has been red long
 * enough switches to the crying face, and the age it measures against starts
 * from when the server first went red rather than from when this page loaded.
 */

type ClientFaviconFace = "good" | "warn" | "bad" | "bad-crying";

export function paintStatusFavicon(
  hrefs: Readonly<Record<ClientFaviconFace, string>>,
  cryAfterMs: number,
  serverRedSince: number | null,
  serverRedAgeMs: number | null,
  startedAt: number,
  now = performance.now(),
  root: Pick<Document, "querySelector"> = document,
): void {
  const status: ClientFaviconFace = root.querySelector(".tile.bad")
    ? "bad"
    : root.querySelector(".tile.warn")
    ? "warn"
    : "good";
  let face: ClientFaviconFace = status;
  if (status === "bad") {
    const redAgeAtLoad = typeof serverRedSince === "number" &&
        Number.isFinite(serverRedSince) && serverRedSince > 0 &&
        typeof serverRedAgeMs === "number" &&
        Number.isFinite(serverRedAgeMs) && serverRedAgeMs >= 0
      ? serverRedAgeMs
      : 0;
    const redAge = redAgeAtLoad + Math.max(0, now - startedAt);
    face = redAge >= cryAfterMs ? "bad-crying" : "bad";
  }
  const favicon = root.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/png"]',
  );
  if (favicon && favicon.getAttribute("href") !== hrefs[face]) {
    favicon.setAttribute("href", hrefs[face]);
  }
}
