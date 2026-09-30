/** Reads the demanding viewer as confidential, per-user reactive input. */

import type { DID } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";

import { runtimeWritePolicyAuthorization } from "../cfc/types.ts";
import { scopeRank } from "../scope.ts";
import { topFrame } from "./frame-context.ts";

/** Returns the demanding viewer, with a User confidentiality observation. */
export function viewerPrincipal(): DID | undefined {
  const frame = topFrame();
  if (
    frame?.frameKind !== "lift" || !frame.runtime || !frame.tx || !frame.space
  ) {
    throw new Error("`viewerPrincipal()` requires a reactive computation.");
  }
  const { runtime, tx, space } = frame;
  if (scopeRank(tx.getNarrowestReadScope()) < scopeRank("user")) {
    tx.resetNarrowestReadScope("user");
  }
  const principal = runtime.homeSpacePrincipalFor(tx);
  if (principal === undefined) return undefined;
  const atom = cfcAtom.user(principal);
  // The principal is runtime input, so its source names the builtin rather
  // than a stored document. The normal content-observation channel carries
  // its confidentiality into derived writes and egress checks.
  const source = {
    space,
    id: "of:viewer-principal" as const,
    scope: "user" as const,
    path: [],
  };
  tx.recordCfcExternalContentObservation({
    source,
    flow: { confidentiality: [atom], integrity: [] },
    consumed: { confidentiality: [atom], integrity: [] },
    labeledSpaces: [space],
    sources: [{ atom, read: source, labelPath: [] }],
  }, runtimeWritePolicyAuthorization);
  return principal;
}
