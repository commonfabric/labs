/**
 * Cell moves the repository has decided to ship, for
 * `check-cause-assignments.ts`.
 *
 * A compiler change that moves a pattern's anonymous cells to new numbers
 * under an unchanged source fails that gate, and the default answer is to
 * change the compiler so that the numbers hold. Where they cannot, the move
 * is declared here, in the change that makes it, where review sees it.
 *
 * An entry forgives one pattern's moves between exactly two builds of it: the
 * base revision's and the change's, each named by the digest the gate prints
 * for it. So an entry forgives nothing once either compiler moves on, and a
 * second move of the same pattern is gated again. Once the change has merged,
 * its base and its own build are the same and the entry forgives nothing; the
 * gate then names it as one to remove.
 */

/** One pattern's moves, forgiven between two builds of it. */
export interface AcceptedMove {
  /** The pattern's key, as `pattern-files.ts` names it. */
  pattern: string;

  /** The digest of the base revision's build, as the gate prints it. */
  base: string;

  /** The digest of the change's build, as the gate prints it. */
  head: string;

  /**
   * Why the move ships: what the change gains by it, and what becomes of the
   * deployed pieces whose cells it moves. The gate refuses to run on an entry
   * that gives none.
   */
  reason: string;
}

export const ACCEPTED_MOVES: readonly AcceptedMove[] = [];
