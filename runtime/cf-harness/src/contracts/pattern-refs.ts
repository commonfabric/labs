/**
 * The record of a task's pattern references: published patterns the caller
 * attached to a task by id, resolved against the pattern index before the
 * run's first model turn so the run names them without searching for them.
 * `src/pattern-refs.ts` documents the posture and does the grammar check and
 * the resolution; this contract is what run state persists.
 */

import type { TrustedPatternRecord } from "./trusted-pattern.ts";

/** One pattern reference as the caller supplied it, before any resolution. */
export interface HarnessPatternRefSpec {
  /**
   * The index's id for the pattern, which is the content-addressed identity
   * of its source. It names published source or it names nothing, so it is
   * the whole of the reference: there is no name, note, or other caller
   * prose for the model to read alongside it.
   */
  patternId: string;
}

/**
 * One pattern reference, as resolved and recorded in run state. It is what
 * the index answered for the id and nothing the caller said about it, which
 * is why the run may hand it to the model as it stands.
 */
export interface HarnessPatternRef {
  patternId: string;

  /** What the index holds for the pattern, in the shape a hit takes. */
  record: TrustedPatternRecord;
}
