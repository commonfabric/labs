/**
 * Names the faces a favicon can wear. A favicon always says something, so it
 * has no unknown face, and it gains one face a tile status has no counterpart
 * for: the crying face a long-running red earns.
 */

import type { Status } from "./types.ts";

export type FaviconStatus = Exclude<Status, "unknown">;
export type FaviconFace = FaviconStatus | "bad-crying";

export const FAVICON_FACES = [
  "good",
  "warn",
  "bad",
  "bad-crying",
] as const satisfies readonly FaviconFace[];
