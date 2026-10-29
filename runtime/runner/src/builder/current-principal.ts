import type { DID } from "@commonfabric/api";

import { topFrame } from "./frame-context.ts";

/**
 * Returns the principal the running handler acts for: the authenticated actor
 * of the event it handles, as `Runtime.actingPrincipalFor()` decides it.
 * Returns `undefined` for an event no principal sent, which a serving runtime
 * can run. Nothing in the event's payload can choose the value.
 *
 * The value is _authority_, not _intent_. It names whose behalf the handler
 * runs on, and a handler that another pattern invokes, through a `send()` of
 * its own, sees the user that pattern runs as. So it does not show that the
 * person asked for the action; a trusted gesture, or a value labeled
 * `AuthoredByCurrentUser`, is what shows that.
 *
 * Available only in a handler for now. A pattern body builds one graph for
 * every viewer, so a value read there would be one person's. A computed or a
 * lift could read the viewer, but only once every runtime scopes such a value
 * to the user it was computed for, and once the viewer's DID has a label
 * saying who may see it.
 *
 * @throws Error when called anywhere but in a handler.
 */
export function currentPrincipal(): DID | undefined {
  const frame = topFrame();
  if (
    frame?.inHandler !== true || frame.runtime === undefined ||
    frame.tx === undefined
  ) {
    throw new Error(
      "`currentPrincipal()` is available only in a handler for now, not in " +
        "a pattern body, a `computed()`, or a `lift()`.",
    );
  }
  return frame.runtime.actingPrincipalFor(frame.tx);
}
