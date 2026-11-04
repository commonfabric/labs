import type { DID } from "@commonfabric/identity";
import type { Runtime } from "@commonfabric/runner";

/**
 * Whether `runtime` has been refused access to `space`, as its storage
 * manager last heard from the server: a refusal of the space, or of the
 * session's authorization in it.
 */
export function accessRefused(runtime: Runtime, space: DID): boolean {
  return Boolean(
    runtime.storageManager.spaceAccessError?.(space) ??
      runtime.storageManager.authorizationError?.(space),
  );
}
