import { isAbsolute, join } from "@std/path";
import type { MemorySpace } from "@commonfabric/runner";

export function absPath(relpath: string, cwd = Deno.cwd()): string {
  // TODO(js): homedir check is not cross platform
  if (isAbsolute(relpath) || relpath[0] === "~") {
    // Do not join a home dir or absolute path
    return relpath;
  }
  return join(cwd, relpath);
}

/**
 * Surface a permanent authorization denial for `space` by throwing the storage
 * layer's real `AuthorizationError`. The storage manager records a permanent
 * denial (an ACL shortfall, an audience or protocol mismatch) per space but
 * keeps `synced()` quiet — a denied cross-space link must stay a silent absent
 * read — so a caller that must reach a specific space reads the per-space status
 * after `synced()` and rethrows the real error here. A no-op when the space is
 * authorized, or when the storage manager does not expose the status.
 */
export function throwOnSpaceAuthorizationError(
  storageManager: {
    authorizationError?: (space: MemorySpace) => Error | undefined;
  },
  space: MemorySpace,
): void {
  const authError = storageManager.authorizationError?.(space);
  if (authError) {
    throw authError;
  }
}
