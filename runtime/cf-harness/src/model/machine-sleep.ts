/**
 * Noticing that the machine slept while a provider exchange was open.
 *
 * A laptop that sleeps while a provider streams a response loses the
 * connection without either end saying so: the provider closes its side while
 * the machine is asleep, and after the wake a read of the old connection waits
 * for a byte or an error that never comes. Deno's `fetch` offers no keepalive
 * that would notice, and nothing tells a Deno process that the machine woke.
 *
 * The clocks show it. The wall clock moves on while the machine sleeps and the
 * monotonic clock that `performance.now()` reads does not, so a wall clock that
 * ran ahead of the monotonic one by more than drift says the machine slept.
 * With no wake notification to listen for, a watch reads the two clocks at a
 * fixed cadence while an exchange is open, and does nothing else.
 */

/** Stops a watch. Calling it again does nothing. */
export type StopWatching = () => void;

/**
 * Watches for the machine sleeping while a wait is open: calls `onSlept` once,
 * with how long the machine slept, and returns what stops the watch.
 */
export type SleepWatch = (onSlept: (sleptMs: number) => void) => StopWatching;

/**
 * How far the wall clock must run ahead of the monotonic clock to count as a
 * sleep, rather than drift or the slew of a clock adjustment.
 */
export const SLEEP_GAP_MS = 10_000;

/**
 * How often an open watch reads the clocks, so the awake time within which a
 * sleep is noticed after the wake.
 */
export const SLEEP_CHECK_EVERY_MS = 10_000;

/** What a watch reads and how it repeats its check, each replaceable in tests. */
export interface MachineSleepWatchOptions {
  /** Wall-clock milliseconds. Defaults to `Date.now()`. */
  wallNowMs?: () => number;

  /** Monotonic milliseconds. Defaults to `performance.now()`. */
  monotonicNowMs?: () => number;

  /**
   * Calls `check` every `everyMs` milliseconds until the returned function is
   * called. Defaults to an interval that never keeps the process alive.
   */
  repeat?: (check: () => void, everyMs: number) => StopWatching;
}

/** An interval that does not hold the process open on its own. */
const unrefInterval = (check: () => void, everyMs: number): StopWatching => {
  const id = setInterval(check, everyMs);
  Deno.unrefTimer(id);
  return () => clearInterval(id);
};

/**
 * Watches for the machine sleeping (`SleepWatch`): between two checks, a wall
 * clock that advanced `SLEEP_GAP_MS` or more beyond the monotonic clock is a
 * sleep of that length. The watch stops itself after reporting one.
 */
export const watchMachineSleep = (
  onSlept: (sleptMs: number) => void,
  options: MachineSleepWatchOptions = {},
): StopWatching => {
  const wallNowMs = options.wallNowMs ?? (() => Date.now());
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
  let wall = wallNowMs();
  let monotonic = monotonicNowMs();
  let stopped = false;
  const stopRepeating = (options.repeat ?? unrefInterval)(() => {
    if (stopped) return;
    const nowWall = wallNowMs();
    const nowMonotonic = monotonicNowMs();
    const sleptMs = (nowWall - wall) - (nowMonotonic - monotonic);
    wall = nowWall;
    monotonic = nowMonotonic;
    if (sleptMs >= SLEEP_GAP_MS) {
      stop();
      onSlept(sleptMs);
    }
  }, SLEEP_CHECK_EVERY_MS);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopRepeating();
  };
  return stop;
};
