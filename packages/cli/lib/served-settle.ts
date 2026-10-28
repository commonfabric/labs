/**
 * The part of a `cf test` settle that waits for served handlers, on the
 * server-execution arm. There a handler's writes are the serving loop's, and
 * neither `runtime.idle()` nor `storageManager.synced()` waits for them to
 * arrive. On the other arm the runtime has no speculation overlay, and these
 * return at once.
 */

import type { Runtime } from "@commonfabric/runner";

/**
 * Resolves once every event `runtime` has fired has reached its terminal
 * consequence, and that consequence has arrived back at `runtime`. An event
 * a served handler fires on its own account is no event of `runtime`'s, and
 * is not waited for.
 */
export async function servedConsequences(runtime: Runtime): Promise<void> {
  await runtime.speculationOverlay?.waitForIntentQuiescence();
}

/**
 * Runs `settle`, and runs it again for as long as it ends with an event of
 * `runtime`'s still awaiting its served consequence. The work a settle does
 * after its last wait for consequences, such as the reactions to what its
 * last sync delivered, can fire an event, and a settle that returned then
 * would leave the next step to race that event's consequence.
 */
export async function settleServed(
  runtime: Runtime,
  settle: () => Promise<void>,
): Promise<void> {
  do {
    await settle();
  } while ((runtime.speculationOverlay?.pendingIntentCount ?? 0) > 0);
}
