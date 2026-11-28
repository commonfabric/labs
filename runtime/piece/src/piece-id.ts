import { type Cell, cellEntityIdString } from "@commonfabric/runner";

/** Returns the id of `piece`: the tagged hash its entity id carries. */
export function pieceId(piece: Cell<unknown>): string {
  return cellEntityIdString(piece);
}
