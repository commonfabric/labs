import { type Cell, cellEntityIdString } from "@commonfabric/runner";

/**
 * Extracts the ID from a piece.
 * @param piece - The piece to extract ID from
 * @returns The piece ID string, or undefined if no ID is found
 */
export function pieceId(piece: Cell<unknown>): string | undefined {
  return cellEntityIdString(piece);
}
