/**
 * A served run's access-list change as data: the list of changes its `change`
 * function applies, in place of the function, so that the change can cross to
 * wherever the memory server that admits it runs: the server's thread, over
 * the serving port, or the process that owns the space, over the route. The
 * wave attaches the list to every change it builds; a change without one
 * cannot cross.
 */

import type { ServedAclChange } from "@commonfabric/memory/v2/server";
import { applyAccessListChanges, validateStoredAcl } from "../acl-manager.ts";
import type { SpaceAccessChange } from "../builder/types.ts";
import type { MemorySpace } from "../storage/interface.ts";
import type { ListedServedAclChange } from "./wave.ts";

/** A served access-list change with the list in place of the function. */
export type ServedAclChangeData = Omit<ServedAclChange, "change"> & {
  readonly changes: readonly SpaceAccessChange[];
};

/** The data `change` crosses as. */
export const servedAclChangeData = (
  change: ServedAclChange,
): ServedAclChangeData => {
  const { change: _apply, ...data } = change as ListedServedAclChange;
  if (data.changes === undefined) {
    throw new Error(
      `the access-list change to ${change.space} carries no change list, ` +
        "so it cannot cross to the memory server that admits it",
    );
  }
  return data;
};

/** The served access-list change `data` stands for, its function rebuilt. */
export const servedAclChangeOf = (
  data: ServedAclChangeData,
): ServedAclChange => ({
  ...data,
  change: (stored) =>
    applyAccessListChanges(
      data.space as MemorySpace,
      validateStoredAcl(stored),
      data.changes,
    ),
});
