import { sameAcl } from "@commonfabric/memory/acl";
import type { ClientCommit } from "@commonfabric/memory/v2";
import type { IStorageTransaction, MemorySpace } from "./interface.ts";

/** An ACL companion bound to its data transaction and target space. */
type AclChange = NonNullable<ClientCommit["aclChange"]>;

const changes = new WeakMap<IStorageTransaction, Map<MemorySpace, AclChange>>();

/** Stages one immutable ACL transition alongside the transaction's metadata. */
export function stageAclChange(
  tx: IStorageTransaction,
  space: MemorySpace,
  change: AclChange,
): void {
  if (sameAcl(change.before, change.after)) return;
  let bySpace = changes.get(tx);
  if (!bySpace) {
    bySpace = new Map();
    changes.set(tx, bySpace);
  }
  if (bySpace.has(space)) {
    throw new Error("Only one ACL change may be staged per transaction");
  }
  bySpace.set(
    space,
    Object.freeze({
      before: Object.freeze({ ...change.before }),
      after: Object.freeze({ ...change.after }),
    }),
  );
}

/** Returns the space's staged ACL companion, if any. */
export function getAclChange(
  tx: IStorageTransaction,
  space: MemorySpace,
): AclChange | undefined {
  return changes.get(tx)?.get(space);
}
