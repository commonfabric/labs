/**
 * Defines the registration event shared by client and hosted piece creation.
 * Its piece link and adder claim cross a serving-wave boundary unchanged.
 */

import type { Cell } from "@commonfabric/runner";

/** The default root's registration event, including the caller's adder claim. */
export interface PieceRegistrationEvent {
  /** Complete target address, including its space and scope. */
  piece: ReturnType<Cell<unknown>["getAsLink"]>;

  /** The caller's DID; a claim rather than a runtime integrity label. */
  addedBy: string;
}

/** Builds the root registration payload under the identity requesting it. */
export function pieceRegistrationEvent(
  piece: Cell<unknown>,
  actingUser: string,
): PieceRegistrationEvent {
  return { piece: piece.getAsLink(), addedBy: actingUser };
}
