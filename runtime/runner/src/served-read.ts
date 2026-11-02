/**
 * A one-shot read under server execution. Reading a derived value from a client
 * that runs nothing takes what a client rendering it takes: the server has to
 * be asked for the value, since a value nobody demands stays stale in the store,
 * and it has to say when it has answered.
 */

import { COMPONENT_READ_CONTRACT_VERSION } from "./component-read-contract.ts";
import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import { ContextualFlowControl } from "./cfc.ts";

/**
 * Registers a `read` view over `cell`, which makes its value and whatever a read
 * of it reaches demand on the serving loop, and waits for the loop to settle
 * with that demand included. Documents the settlement committed have arrived in
 * this runtime's replica when this returns, so a read of `cell` that follows
 * sees what the server derived for it.
 *
 * @returns `false`, without the wait, against a server with no view protocol,
 * one a reconnect finds no longer offers it, or one that refuses a `read` view
 * because it predates them.
 * @throws Error when another view owner replaces this one on the replica.
 */
export async function pullFromServer(
  runtime: Runtime,
  cell: Cell<unknown>,
): Promise<boolean> {
  const { space, id, scope, schema } = cell.getAsNormalizedFullLink();
  const replica = runtime.storageManager.open(space).replica;
  if (
    await replica.supportsViewReplication?.() !== true ||
    replica.acquireViewInterests === undefined ||
    replica.subscribeViewPlans === undefined
  ) return false;
  const viewId = `read:${crypto.randomUUID()}`;
  const answered = Promise.withResolvers<boolean>();
  // The owner can be replaced before anything awaits the answer.
  answered.promise.catch(() => {});
  const lease = replica.acquireViewInterests(() => {
    answered.reject(new Error("Another view owner replaced this read"));
  });
  const revision = lease.nextRevision();
  const cancelPlans = replica.subscribeViewPlans((plans) => {
    if (replica.viewReplicationSupported?.() === false) {
      answered.resolve(false);
    } else if (
      plans.some((plan) =>
        plan.id === viewId && plan.revision === revision &&
        plan.settled === true
      )
    ) answered.resolve(true);
  });
  try {
    const registered = await lease.set([{
      id: viewId,
      revision,
      query: {
        roots: [{
          id,
          scope,
          selector: {
            path: cell.path.map((segment) => segment.toString()),
            // A stream's document holds no value a read uses, as for a sync.
            schema: ContextualFlowControl.declaresStream(schema)
              ? false
              : schema ?? false,
          },
        }],
      },
      mode: "read",
      componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
    }]);
    return registered && await answered.promise;
  } catch (error) {
    if (error instanceof Error && error.name === "ProtocolError") return false;
    throw error;
  } finally {
    cancelPlans();
    lease.release();
  }
}
