/**
 * A `{ deleteSpace }` test step: the deletion of the space a cell's value
 * lives in, so that a test can check what a pattern does with a space the
 * memory server refuses as deleted (`docs/features/space-access.md`, "A
 * deleted space").
 */

import type { DID } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import type { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

/**
 * Deletes the space the value of `target` lives in on `storage`, the store
 * the test's runtime runs on, as `by` deletes it, and returns once `storage`
 * has heard of the deletion, so that `spaceDeleted()` returns `true` for the
 * space in what the test runs next. The deletion revokes the session
 * `storage` holds on the space, which loading the value opens, so the loss
 * this waits for always arrives.
 *
 * @throws If `storage` is `undefined`: a store a caller supplied to the
 *   runner deletes nothing.
 */
export async function deleteSpaceOf(
  storage: EmulatedStorageManager | undefined,
  target: Cell<unknown>,
  by: DID,
): Promise<void> {
  if (storage === undefined) {
    throw new Error(
      "A `{ deleteSpace }` step needs the store `cf test` creates; a store " +
        "the caller supplies deletes nothing.",
    );
  }
  const value = await (await target.sync()).resolveAsCell().sync();
  const { space } = value.getAsNormalizedFullLink();
  const heard = Promise.withResolvers<void>();
  const cancel = storage.subscribeSpaceAccessLoss((lost) => {
    if (lost === space) heard.resolve();
  });
  try {
    await storage.deleteSpace(space, by);
    await heard.promise;
  } finally {
    cancel();
  }
}
