import { defer } from "@commonfabric/utils/defer";

/**
 * How long an event-driven test wait runs before it is called stuck. Two
 * minutes is generous headroom over any healthy wait observed in the suites
 * that use one, so that crossing it points at a wait whose condition never
 * arrived rather than at a slow one.
 */
export const STUCK_NET_MS = 120_000;

/**
 * A stuck-condition net for an event-driven test wait: a promise that rejects
 * once `ms` has passed, and the timer behind it. Race it against the wait, and
 * clear it when the wait returns. `label` names the condition in the failure.
 *
 * This is not a bound on how long the awaited work may legitimately take.
 * Crossing it says the condition never arrived, which is why the default span
 * is measured in minutes against waits that take seconds.
 *
 * A wait needs one only when its process cannot go quiet. A wait that can —
 * one over in-process state, with no live connection and no repeating timer
 * holding the event loop open — already fails at once: Deno's test runner
 * reports `Promise resolution is still pending but the event loop has already
 * resolved`. One that cannot runs to the ambient test or job limit, and says
 * nothing about what it was waiting for.
 * `docs/development/waiting-in-tests.md` covers which waits are which.
 *
 * This module sits under `test/` because the fake clock classifies a timer by
 * the file that armed it: a timer armed from `test/` freezes under
 * auto-advance, which leaves a wait purely event-driven there, while one armed
 * from `src/` advances logical time on its own and would fire at once.
 */
export const stuckNet = (
  label: string,
  ms: number = STUCK_NET_MS,
): { rejects: Promise<never>; clear: () => void } => {
  const failed = defer<never>();
  // Nobody awaits the rejection unless a wait races it, and an unraced
  // rejection is not a failure.
  failed.promise.catch(() => {});
  // Built here rather than in the callback, so its stack is the waiter's
  // rather than the timer's. Which wait is stuck is the whole report.
  const error = new Error(`${label} never arrived after ${ms} ms`);
  const timer = setTimeout(() => failed.reject(error), ms);
  return { rejects: failed.promise, clear: () => clearTimeout(timer) };
};

/**
 * `promise` under a stuck-condition net: whichever settles first wins, and the
 * net is cleared either way. For a wait that is a single promise rather than a
 * loop; a loop arms one {@link stuckNet} and races it on each turn.
 */
export const withStuckNet = async <T>(
  promise: Promise<T>,
  label: string,
  ms: number = STUCK_NET_MS,
): Promise<T> => {
  const net = stuckNet(label, ms);
  try {
    return await Promise.race([promise, net.rejects]);
  } finally {
    net.clear();
  }
};
