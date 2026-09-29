/**
 * Returns the authenticated principal for the current execution. Handlers use
 * their transaction's actor; reactive reads use the demanding identity and
 * acquire its user scope through the runtime's identity resolver.
 */

import type { DID } from "@commonfabric/api";
import { topFrame } from "./frame-context.ts";

/** Returns the current authenticated principal, or no principal for a userless run. */
export function currentPrincipal(): DID | undefined {
  const frame = topFrame();
  if (!frame?.runtime || !frame.tx) {
    throw new Error("`currentPrincipal()` requires an active execution.");
  }
  if (frame.inHandler) {
    return frame.tx.getCfcState().trustSnapshot?.actingPrincipal as
      | DID
      | undefined;
  }
  return frame.runtime.homeSpacePrincipalFor(frame.tx);
}
