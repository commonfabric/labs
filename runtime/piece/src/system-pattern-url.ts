import type { MemorySpace, Runtime } from "@commonfabric/runner";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
  patternSourceUrl,
} from "@commonfabric/runner";

// The system space-root pattern refs and the source→URL resolution moved
// into the runner's ensure-space-root.ts with the OW45 arm-B server-ensure
// stage 1 (design PR #6209 §1: the SpaceServer's ensure and the controller
// must share ONE definition — the creation CAUSE and source refs are
// identity-bearing, so a drifted copy would fork the OCC convergence).
// Re-exported here for the existing piece-side importers.
export { DEFAULT_APP_PATTERN_SOURCE, HOME_PATTERN_SOURCE, patternSourceUrl };

/**
 * The official system space-root pattern ref for a space type — the home DID
 * gets home.tsx, every other space gets the default app. This derivation only
 * selects the identity to check; it never proves that a sourceless root tracks
 * that ref. Exact equality with the official content identity supplies
 * that proof at the check site.
 *
 * CLIENT semantics, deliberately kept out of the runner core: the home
 * predicate compares against `runtime.userIdentityDID`, which on a SERVING
 * runtime is the SERVICE DID — the server-side ensure derives home-ness
 * from the ACL instead (self-owned = home; see ensure-space-root.ts).
 */
export function deriveSystemPatternSource(
  space: MemorySpace,
  runtime: Runtime,
): string {
  return space === runtime.userIdentityDID
    ? HOME_PATTERN_SOURCE
    : DEFAULT_APP_PATTERN_SOURCE;
}
