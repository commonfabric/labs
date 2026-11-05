/**
 * Standing a place somewhere, for the cases that need one already there.
 *
 * A `cd` onto a piece comes back for a read rather than landing
 * (`PendingMove`, `lib/shuttle/place.ts`), so a case that wants a place
 * standing at a piece has to land it. What these stand in for the resolution
 * is the piece the operand itself named — which is what the fabric hands back
 * for a handle, and leaves a slug spelled as it was written.
 *
 * That is the point of them: a case built this way says what it says about the
 * reading and nothing about a resolution. What a resolution does to a place —
 * the handle it adopts, the name it leaves beside it, and the refusal a path
 * that is not there gets — is pinned where it happens, in `confirm()`'s block
 * in `shuttle-place.test.ts` and in `cd`'s in `shuttle-verbs.serial.test.ts`.
 */

import type { CurrentPlace, Move } from "../lib/shuttle/place.ts";

/**
 * Lands `move` on `place` where it came back for a read, standing the piece
 * the operand named in for the handle a resolution would hand back, and passes
 * every other move through.
 */
export function landed(place: CurrentPlace, move: Move): Move {
  return move.kind === "pending"
    ? place.confirm(move, {
      piece: move.place.position.piece,
      path: move.place.position.path,
    })
    : move;
}

/** {@link landed} over a `cd`, which is how a case moves a place. */
export function moved(place: CurrentPlace, operand: string): Move {
  return landed(place, place.cd(operand));
}
