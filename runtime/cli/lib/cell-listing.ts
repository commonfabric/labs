/**
 * The keys directly under a cell path, and the shaping that produces them.
 *
 * The connection is a parameter, so a caller already holding a runtime reads
 * through it and only a caller that passes none opens a fresh one.
 *
 * A failure raises. An empty listing means the path names a leaf, which is a
 * different answer from "the read did not happen", and only the caller knows
 * which of the two it can act on. A caller that wants silence catches.
 */

import { parseCellPath } from "@commonfabric/runner";

import {
  getCellValue,
  type PieceConfig,
  type PieceResolutionDeps,
} from "./piece.ts";

/** Which of a piece's two cells a listing reads. */
export interface CellListingOptions {
  /** Read the arguments cell rather than the result, as `--input` does. */
  input?: boolean;
}

/**
 * Keys directly under `path` on a piece's cell. An array yields its indices, an
 * object its property names, and a leaf yields nothing — which is the correct
 * signal that the path is already complete.
 *
 * A path embedded in the reference comes first, the way `mergePiecePath` puts
 * it, so a `config` naming `/of:fid1:…/items` lists `items`' keys rather than
 * the root's.
 *
 * @throws Whatever the read throws — an unreachable server, an identity that
 * will not load, a path the piece refuses.
 */
export async function listCellKeys(
  config: PieceConfig,
  path: string,
  options: CellListingOptions = {},
  deps: PieceResolutionDeps = {},
): Promise<string[]> {
  const segments = [
    ...(config.piecePath ?? []),
    ...(path ? parseCellPath(path) : []),
  ];
  return keysOf(await getCellValue(config, segments, options, deps));
}

/**
 * The listable keys of one cell value: an array yields its indices, an object
 * its property names, and a leaf yields nothing — which is the correct signal
 * that the path already names a value rather than a container.
 */
export function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, index) => String(index));
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}
