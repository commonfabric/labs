import { ensureSpaceRootPattern } from "./ensure-space-root.ts";
import type { Runtime } from "./runtime.ts";
import { SpaceRootMissingError } from "./space-root-slot.ts";
import type { MemorySpace } from "./storage/interface.ts";

/**
 * The creation of a Home's root under way in a runtime, by Home space, shared
 * by every handler that waits on it.
 */
const homeRootCreations = new WeakMap<
  Runtime,
  Map<MemorySpace, Promise<void>>
>();

/**
 * Helper for {@link bringUpHomeRootForRefusedWrite}, which brings the root of
 * `home` into being, sharing a creation already under way in `runtime`.
 * Resolves once `home` links a root, whoever created it.
 */
function createHomeRoot(runtime: Runtime, home: MemorySpace): Promise<void> {
  let creations = homeRootCreations.get(runtime);
  if (!creations) {
    creations = new Map();
    homeRootCreations.set(runtime, creations);
  }
  let creation = creations.get(home);
  if (!creation) {
    const settling = creations;
    creation = ensureSpaceRootPattern(runtime, home, { isHomeSpace: true })
      .then(() => {})
      .finally(() => settling.delete(home));
    creations.set(home, creation);
  }
  return creation;
}

/**
 * Brings the user's Home root into being for a handler whose write beneath the
 * Home's empty `defaultPattern` slot was refused with `error`, on a client
 * runtime, so that the handler can run again and its write land under the
 * root. `undefined` when this runtime brings up no root for `error`: a serving
 * runtime creates none, and a space other than the user's own Home gets its
 * root another way, as `SpaceRootMissingError` says. A handler that only reads
 * beneath the empty slot is refused nothing, and so creates nothing.
 */
export function bringUpHomeRootForRefusedWrite(
  runtime: Runtime,
  error: unknown,
): Promise<void> | undefined {
  if (runtime.servingPosture) return undefined;
  if (!(error instanceof SpaceRootMissingError)) return undefined;
  const home = runtime.userIdentityDID as MemorySpace;
  if (error.rootlessSpace !== home) return undefined;
  return createHomeRoot(runtime, home);
}
