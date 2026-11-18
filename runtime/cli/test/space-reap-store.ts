/**
 * The store `cf space reap` tests read: one the engine wrote for a space that
 * one identity owns alone.
 */

import { toFileUrl } from "@std/path";
import type { Operation } from "@commonfabric/memory/v2";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";

/** The space the store is written for. */
export const REAP_SPACE = "did:key:z6MkCliReapShared00006pfs";

/** The space's one owner. */
export const REAP_OWNER = "did:key:z6MkCliReapAlice";

/**
 * Writes at `path` a store the engine wrote for {@link REAP_SPACE}, owned by
 * {@link REAP_OWNER} alone and holding one document, and, with `deleted`, then
 * deleted by its owner.
 */
export async function reapSpaceStore(
  path: string,
  deleted: boolean,
): Promise<void> {
  const engine = await open({ url: toFileUrl(path) });
  let localSeq = 1;
  const apply = (operations: Operation[]) =>
    applyCommit(engine, {
      sessionId: "s:alice",
      space: REAP_SPACE,
      principal: REAP_OWNER,
      commit: {
        localSeq: localSeq++,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    });
  const acl = `of:${REAP_SPACE}`;
  apply([{ op: "set", id: acl, value: { value: { [REAP_OWNER]: "OWNER" } } }]);
  apply([{ op: "set", id: "of:doc", value: { value: { n: 1 } } }]);
  if (deleted) {
    apply([{
      op: "set",
      id: acl,
      value: { value: { deleted: { by: REAP_OWNER } } },
    }]);
  }
  close(engine);
}
