import type { DID } from "@commonfabric/api";

import { runtimeWritePolicyAuthorization } from "../cfc/types.ts";
import { scopeRank } from "../scope.ts";
import { topFrame } from "./frame-context.ts";

/**
 * Returns the principal the running code runs for.
 *
 * In a handler that is the principal the handler acts for: the authenticated
 * actor of the event it handles, as `Runtime.actingPrincipalFor()` decides
 * it. Nothing in the event's payload can choose the value.
 *
 * In a `lift` or a `computed` it is the viewer: the principal the run's
 * instance is computed for, as `Runtime.homeSpacePrincipalFor()` decides it.
 * Asking makes the computation's value a per-user one, and tells the
 * transaction who the viewer is, so the flow label on what the computation
 * writes can name them (`CfcTxState.viewers`). This needs the
 * `viewerBoundRelease` experimental option.
 *
 * Returns `undefined` for a run no principal stands behind, which a serving
 * runtime can make.
 *
 * The value is _authority_, not _intent_. It names whose behalf the code
 * runs on, and a handler that another pattern invokes, through a `send()` of
 * its own, sees the user that pattern runs as. So it does not show that the
 * person asked for the action; a trusted gesture, or a value labeled
 * `AuthoredByCurrentUser`, is what shows that.
 *
 * A pattern body builds one graph for every viewer, so a value read there
 * would be one person's, and the call is refused there.
 *
 * @throws Error when called in a pattern body, or in a `lift` or a
 *   `computed` while `viewerBoundRelease` is off.
 */
export function currentPrincipal(): DID | undefined {
  const frame = topFrame();
  const { runtime, tx } = frame ?? {};
  if (frame?.inHandler === true && runtime !== undefined && tx !== undefined) {
    return runtime.actingPrincipalFor(tx);
  }
  if (
    frame?.frameKind === "lift" && runtime !== undefined && tx !== undefined &&
    runtime.experimental.viewerBoundRelease === true
  ) {
    // The answer depends on who the value is computed for, so the value is a
    // per-user one whoever that turns out to be, a run with no viewer
    // included.
    if (scopeRank(tx.getNarrowestReadScope()) < scopeRank("user")) {
      tx.resetNarrowestReadScope("user");
    }
    const viewer = runtime.homeSpacePrincipalFor(tx);
    if (viewer !== undefined) {
      tx.recordCfcViewer(viewer, runtimeWritePolicyAuthorization);
    }
    return viewer;
  }
  throw new Error(
    "`currentPrincipal()` is available only in a handler, or in a `lift()` " +
      "or a `computed()` with the `viewerBoundRelease` experimental option " +
      "on, and never in a pattern body.",
  );
}
