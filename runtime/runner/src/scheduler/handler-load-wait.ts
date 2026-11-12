import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MemorySpace,
} from "../storage/interface.ts";
import {
  isLinkResolutionProbe,
  isReadIgnoredForScheduling,
} from "../storage/reactivity-log.ts";
import { entityKey } from "./keys.ts";

/**
 * Withdraws the handler running in `tx` when the replica has no local basis
 * for the document `link` names, not even a confirmed absence, and that
 * document's load is in flight. What the handler read of the document then
 * reflects only that it has not arrived, which is not the document's state,
 * and a handler runs once per event: the scheduler runs a withdrawn one again
 * once the load lands (`dispatchedHandlerNotRun`), and `reason` is what the
 * withdrawal reports. A withdrawal therefore always has a load to wait on,
 * and a document that does not exist withdraws the handler at most until its
 * absence is confirmed. A reactive computation needs none of this, since the
 * load's arrival runs it again.
 */
export function withdrawHandlerWhileLoading(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  reason: string,
): void {
  // The instance a scoped read reaches is the one the transaction demands,
  // as a served run's is its actor's, so the load and the local basis are
  // looked up for that instance.
  const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
  if (!isLoadingWithoutLocalBasis(runtime, link, identity)) return;
  tx.dispatchedHandlerNotRun ??= { reason };
}

/**
 * Withdraws the handler that ran in `tx` when it read, anywhere in its run,
 * a document `withdrawHandlerWhileLoading()` would have withdrawn it for: one
 * whose load is in flight and for which the replica has no local basis. A
 * read the run makes through a link it resolves while it runs reaches a
 * document no dependency of the event names, so nothing parked the event on
 * that load before the run; the read then returns the schema's default, or
 * nothing, in place of what the document holds. The reads that count are the
 * ones the run consumed the document's data with (`consumedReadsOf()`), in a
 * space for which `validated` returns `false`. A read in a space the run's
 * commit carries its reads to is held to the store's head there, and a stale
 * one is refused at that commit, so it needs no withdrawal here; a read in
 * any other space is held to nothing.
 *
 * Does nothing, and reads nothing of the run, while no load is in flight.
 */
export function withdrawHandlerAfterLoadingRead(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  validated: (space: MemorySpace) => boolean,
): void {
  if (tx.dispatchedHandlerNotRun !== undefined) return;
  const { storageManager } = runtime;
  if ((storageManager.pendingLoadAddresses?.() ?? []).length === 0) return;
  const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
  for (const read of consumedReadsOf(tx.tx)) {
    if (validated(read.space)) continue;
    if (!isLoadingWithoutLocalBasis(runtime, read, identity)) continue;
    tx.dispatchedHandlerNotRun = {
      reason: `the run read \`${read.id}\` while its document was still ` +
        "loading",
    };
    return;
  }
}

/**
 * The reads `tx` records natively that consume a document's data. A read of
 * the document's root counts, as a read of its value does. Three kinds of
 * read do not count: a read of its CFC metadata, which a run passing a link
 * to the document along makes; a read the transaction records as a
 * link-resolution probe, which resolving a link through the document makes;
 * and a read it records as ignored for scheduling, which writing into the
 * document makes. A transaction that records no reads yields none.
 */
export function* consumedReadsOf(
  tx: Pick<IExtendedStorageTransaction["tx"], "getReadActivities">,
): Generator<
  Pick<IMemorySpaceAddress, "space" | "id" | "scope" | "path">
> {
  for (const read of tx.getReadActivities?.() ?? []) {
    if (
      isLinkResolutionProbe(read.meta) ||
      isReadIgnoredForScheduling(read.meta)
    ) {
      continue;
    }
    if (read.path.length > 0 && read.path[0] !== "value") continue;
    yield read;
  }
}

/**
 * Whether the document `address` names, as the instance `identity` reaches,
 * has a load in flight and no local basis in the replica, not even a
 * confirmed absence.
 */
function isLoadingWithoutLocalBasis(
  runtime: Runtime,
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope">,
  identity: ScopeKeyIdentity,
): boolean {
  const { storageManager } = runtime;
  const key = entityKey(address, identity);
  if (storageManager.pendingLoadGeneration?.(key) === undefined) return false;
  const { replica } = storageManager.open(address.space);
  return replica.hasLocalDocumentCoverage?.(
    address.id,
    address.scope,
    identity,
  ) !== true;
}
