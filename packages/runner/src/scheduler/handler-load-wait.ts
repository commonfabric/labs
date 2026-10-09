import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
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
  const { storageManager } = runtime;
  // The instance a scoped read reaches is the one the transaction demands,
  // as a served run's is its actor's, so the load and the local basis are
  // looked up for that instance.
  const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
  const key = entityKey(link, identity);
  if (storageManager.pendingLoadGeneration?.(key) === undefined) return;
  const { replica } = storageManager.open(link.space);
  if (
    replica.hasLocalDocumentCoverage?.(link.id, link.scope, identity) === true
  ) {
    return;
  }
  tx.dispatchedHandlerNotRun ??= { reason };
}
