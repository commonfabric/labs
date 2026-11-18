/**
 * The part of a `cf test` settle that waits for served handlers, on the
 * server-execution arm. There a handler's writes are the serving loop's, and
 * neither `runtime.idle()` nor `storageManager.synced()` waits for them to
 * arrive. On the other arm the runtime has no speculation overlay and no
 * serving loop, and these return at once.
 */

import type { Runtime } from "@commonfabric/runner";

/**
 * Resolves once every event `runtime` has fired has reached its terminal
 * consequence, and that consequence has arrived back at `runtime`. An event
 * a served handler fires on its own account is no event of `runtime`'s, and
 * is left to {@link settleServed}.
 */
export async function servedConsequences(runtime: Runtime): Promise<void> {
  await runtime.speculationOverlay?.waitForIntentQuiescence();
}

/**
 * Waits until the serving loop has nothing left to do, and resolves with a
 * value that stays the same across two calls only if no loop did anything
 * between them; `ExecutorHost.whenQuiescent()` is the source of both.
 */
export type ServedQuiescence = () => Promise<number>;

/**
 * Runs `settle`, and runs it again for as long as it ends with an event of
 * `runtime`'s still awaiting its served consequence. The work a settle does
 * after its last wait for consequences, such as the reactions to what its
 * last sync delivered, can fire an event, and a settle that returned then
 * would leave the next step to race that event's consequence.
 *
 * With `servedQuiescence`, which a run on the server-execution arm gives it,
 * it also waits for what those consequences set off, the events a served
 * handler fires on its own account among them. Once the serving loop is at
 * rest, a round trip on each of `runtime`'s connections delivers what the loop
 * wrote, and `settle` runs the reactions to it. Those reactions can give the
 * loop more to do, so this returns only when the loop has stayed at rest
 * across a whole pass.
 */
export async function settleServed(
  runtime: Runtime,
  settle: () => Promise<void>,
  servedQuiescence?: ServedQuiescence,
): Promise<void> {
  let rest: number | undefined;
  while (true) {
    await settle();
    if ((runtime.speculationOverlay?.pendingIntentCount ?? 0) > 0) continue;
    if (servedQuiescence === undefined) return;
    const reached = await servedQuiescence();
    if (reached === rest) return;
    rest = reached;
    await runtime.storageManager.pullOpenSpacesToHead();
  }
}
