/**
 * Serves the favicon and decides which face it wears: the worst status across
 * the tiles, since the tab has one icon to say how the dashboard is doing. The
 * href carries the version the artwork was generated at, so a browser holding
 * an older icon fetches the new one instead of keeping what it cached.
 */

import { FAVICON_PNG, FAVICON_VERSION } from "./favicon-png.generated.ts";
import type { FaviconFace, FaviconStatus } from "./favicon-types.ts";
import type { Status } from "./types.ts";

export { FAVICON_VERSION };
export type { FaviconFace, FaviconStatus };

export function faviconStatus(statuses: Iterable<Status>): FaviconStatus {
  let result: FaviconStatus = "good";
  for (const status of statuses) {
    if (status === "bad") return "bad";
    if (status === "warn") result = "warn";
  }
  return result;
}

export function faviconHref(status: FaviconFace): string {
  return `/favicon.png?status=${status}&v=${FAVICON_VERSION}`;
}

export function faviconLink(status: FaviconStatus): string {
  const href = faviconHref(status);
  return `<link rel="icon" type="image/png" sizes="32x32" href="${href}">`;
}

export function faviconPng(requestedStatus: string | null): ArrayBuffer {
  const status: FaviconFace = requestedStatus === "bad-crying"
    ? "bad-crying"
    : requestedStatus === "bad"
    ? "bad"
    : requestedStatus === "warn"
    ? "warn"
    : "good";
  return new Uint8Array(FAVICON_PNG[status]).buffer;
}
