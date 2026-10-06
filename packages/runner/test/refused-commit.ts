/**
 * A test meets the CFC commit boundary in one of two ways. It arranges a
 * refusal, because its subject is what happens after one, or it prepares the
 * transaction and reads the reasons a gate recorded. Each way has a helper
 * here.
 */

import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { CFC_GRANT_ID_PREFIX } from "../src/cfc/grants.ts";
import { plainReason } from "../src/cfc/verdict-reason.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Makes the commit boundary refuse `tx`, and says in `reason` what the case
 * wanted a refusal for.
 *
 * The whole of a reserved `grant:cfc:` document is policy state that only
 * `writeCfcGrant` may write, so an ordinary write to one is recorded at the
 * transaction's write chokepoint and prepare refuses over it. The refusal is
 * a verdict on the transaction's data, so it reaches the caller under the
 * terminal `CfcCommitRefusalError` name. A case that wants the refusal a
 * PARTICULAR gate decided wants {@link prepareAndCommit} instead.
 *
 * `space` is the space to write the reserved document into; the write never
 * lands, so any space the transaction can address will do.
 *
 * The refusal exists from `enforce-explicit` upward, so a transaction below
 * that is raised to it. A caller's own stricter rung is left alone, and a
 * caller that names none takes this rung rather than whatever the fleet
 * default resolves to.
 */
export const refuseAtCommitBoundary = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  reason: string,
): void => {
  const mode = tx.getCfcState().enforcementMode;
  if (mode !== "enforce-explicit" && mode !== "enforce-strict") {
    tx.setCfcEnforcementMode("enforce-explicit");
  }
  tx.writeValueOrThrow({
    space,
    scope: "space",
    id: `${CFC_GRANT_ID_PREFIX}test-refusal` as URI,
    path: [],
  }, { audience: [reason] });
};

/**
 * Prepares `tx` the way the runtime's own commit paths do, commits it, and
 * reports the reasons prepare refused it over alongside the commit result.
 * The reasons come back with their verdict tag stripped, as the boundary
 * renders them into the rejection.
 *
 * The prepare is what puts the reasons in reach: `commit()` prepares a
 * relevant transaction itself, but it settles the transaction in the same
 * step, so a case that wants to read what a gate decided asks before the
 * commit consumes it.
 */
export const prepareAndCommit = async (
  tx: IExtendedStorageTransaction,
): Promise<{
  reasons: readonly string[];
  result: Awaited<ReturnType<IExtendedStorageTransaction["commit"]>["settled"]>;
}> => {
  tx.prepareCfc();
  const prepare = tx.getCfcState().prepare;
  return {
    reasons: prepare.status === "invalidated"
      ? prepare.reasons.map(plainReason)
      : [],
    result: await tx.commit().settled,
  };
};
