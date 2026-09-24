/**
 * The guard that refuses a builder artifact minted while an action's user code
 * runs; the window itself is kept by `frame-context.ts`.
 */

import { inActionExecution } from "./frame-context.ts";
import { getTopFrame } from "./pattern.ts";

export { runInActionExecution } from "./frame-context.ts";

/**
 * Throw when called inside a running action: builder artifacts must be
 * defined at module level. Called by the lift/handler mint sites. Mints under
 * a module-evaluation frame (`Frame.moduleEvaluation`) are the transformer's
 * legal module-scope output and pass.
 */
export function assertNotInActionExecution(kind: string): void {
  if (
    inActionExecution() &&
    getTopFrame()?.moduleEvaluation !== true
  ) {
    throw new Error(
      `Cannot create a ${kind} inside a running action: define the ${kind} ` +
        `at module level. (If this code came from pattern source, this may ` +
        `be a transformer bug — the transformer is supposed to hoist all ` +
        `builder calls to module scope.)`,
    );
  }
}
