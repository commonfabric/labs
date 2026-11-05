import { stuckNet } from "@commonfabric/test-support/stuck-net";
import { CoalescedDocListener } from "../../src/speculation/doc-notification-listener.ts";
import type {
  IStorageNotificationCapability,
  MemorySpace,
} from "../../src/storage/interface.ts";

/**
 * Resolves once `predicate` holds, waking on each client-side delivery
 * of the docs `wants` selects — a test-owned tap of the storage
 * manager's notification relay, the same relay the effects channel
 * consumes — with the predicate checked once up front and then once per
 * delivery burst.
 *
 * Soundness rests on one ordering: the predicate must read state that
 * is true no later than the moment a wanted delivery reaches this
 * client. An engine read qualifies — the server commits before it fans
 * out — so a predicate false at the up-front check has its delivery
 * still ahead of the already-subscribed listener, and the wake cannot
 * be missed. State nothing delivers to this client (a watermark, a
 * stats counter) never wakes this wait; that state waits through
 * `waitUntil` (wait-until.ts).
 *
 * The deadline is `stuckNet`, not a bound on how long the awaited work may
 * take: the serving loop holds the event loop open through its lease-renew
 * interval, so a wait with no net would wedge the run instead of failing
 * it (see "Where the polling `waitFor` stays" in
 * `docs/development/waiting-in-tests.md`). Crossing it proves only that no
 * delivery satisfied the predicate within the window — a fixed bound
 * cannot tell a stuck wait from one delayed past it; the width just makes
 * the stuck reading the likely one. Under the package's fake clock the net
 * freezes with every other test-armed timer and the wait is purely
 * event-driven.
 */
export const waitOnDelivery = async (options: {
  /** The client storage manager whose notification relay carries the
   * wanted deliveries. */
  manager: IStorageNotificationCapability;

  /** Which delivered docs wake the predicate re-check. A space reset
   * wakes it regardless. */
  wants: (
    space: MemorySpace,
    id: string,
    scope: string | undefined,
  ) => boolean;

  /** The state being awaited, read fresh on every wake. */
  predicate: () => boolean;

  /** Names the awaited state when the stuck net fires. */
  label: string;
}): Promise<void> => {
  const { manager, wants, predicate, label } = options;
  const settled = Promise.withResolvers<void>();
  const listener = new CoalescedDocListener(manager, {
    wants,
    onNotify: () => {
      try {
        if (predicate()) settled.resolve();
      } catch (error) {
        settled.reject(error);
      }
    },
  });
  // Subscribe BEFORE the first check: a delivery that lands between the
  // two still dispatches a re-check instead of slipping past.
  listener.ensure();
  try {
    if (predicate()) return;
    const net = stuckNet(`a satisfying delivery for ${label}`);
    try {
      await Promise.race([settled.promise, net.rejects]);
    } finally {
      net.clear();
    }
  } finally {
    listener.release();
  }
};
