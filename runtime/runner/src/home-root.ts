import { ensureSpaceRootPattern } from "./ensure-space-root.ts";
import type { Runtime } from "./runtime.ts";
import { SpaceRootMissingError } from "./space-root-slot.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  MemorySpace,
} from "./storage/interface.ts";

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
 * Helper for {@link bringUpHomeRootForRefusedWrite}, which resolves once the
 * space cell of `home` links a root, whoever links it, and rejects when that
 * cell does not load. It waits on the storage manager's notifications, so a
 * root linked later is noticed when its commit arrives.
 */
function homeRootLinked(runtime: Runtime, home: MemorySpace): Promise<void> {
  const slot = runtime.getSpaceCell(home).key("defaultPattern");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let waiting = true;
  const subscription: IStorageNotification = {
    next() {
      if (waiting && slot.getRaw() !== undefined) {
        waiting = false;
        resolve();
      }
      return waiting ? undefined : { done: true };
    },
  };
  const stop = (settle: () => void): void => {
    if (!waiting) return;
    waiting = false;
    runtime.storageManager.unsubscribe?.(subscription);
    settle();
  };
  runtime.storageManager.subscribe(subscription);
  slot.sync().then(
    () => {
      if (slot.getRaw() !== undefined) stop(resolve);
    },
    (failure: unknown) => stop(() => reject(failure)),
  );
  return promise;
}

/**
 * Brings the user's Home root into being for a handler whose write beneath the
 * Home's empty `defaultPattern` slot was refused with `error`, so that the
 * handler can run again and its write land under the root. The user is the one
 * the handler run on `tx` acts for. A client runtime creates the root. A
 * serving runtime creates none, since the loop serving the Home's own space
 * creates it once that space is active, and waits until it is linked.
 * `undefined` when this runtime brings up no root for `error`: a space other
 * than the user's own Home gets its root another way, as
 * `SpaceRootMissingError` says, and a served run that acts for no one has no
 * Home. A handler that only reads beneath the empty slot is refused nothing,
 * and so brings up nothing.
 */
export function bringUpHomeRootForRefusedWrite(
  runtime: Runtime,
  error: unknown,
  tx?: IExtendedStorageTransaction,
): Promise<void> | undefined {
  if (!(error instanceof SpaceRootMissingError)) return undefined;
  const home = runtime.actingPrincipalFor(tx) as MemorySpace | undefined;
  if (home === undefined || error.rootlessSpace !== home) return undefined;
  return runtime.servingPosture
    ? homeRootLinked(runtime, home)
    : createHomeRoot(runtime, home);
}
