/** Local runner effects shared by browser and serving runtimes. */

import type { PostCommitSideEffect } from "../cfc/types.ts";

/** Local runner state published only after its enclosing wave accepts. */
export const RUNNER_ACCEPTANCE_EFFECT_KIND = "runner-acceptance";

/** Settles local runner callbacks when their deferred effects are discarded. */
export function abandonRunnerAcceptanceEffects(
  effects: readonly PostCommitSideEffect[],
  reason: unknown,
): void {
  for (const effect of effects) {
    if (effect.kind === RUNNER_ACCEPTANCE_EFFECT_KIND) effect.abandon?.(reason);
  }
}
