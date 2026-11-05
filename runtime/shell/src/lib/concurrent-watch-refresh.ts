/**
 * Dogfood toggle for `experimentalConcurrentWatchRefresh` (the storage flag
 * added in #4937, docs/development/EXPERIMENTAL_OPTIONS.md). When enabled, the
 * worker's remote storage overlaps watch-refresh round trips up to a bounded
 * window instead of the default strict single-flight, so traversal-driven pulls
 * discovered a tick apart no longer serialize into one-RTT-each frames. On a
 * high-RTT link (estuary) that serialization dominates cold-load wall-clock;
 * this flag is how we measure the win in production.
 *
 * Default OFF — a storage-protocol posture change, enabled deliberately per
 * browser profile. The setting is fixed at StorageManager.open time and crosses
 * the worker IPC in InitializationData, so — like the render ceiling and unlike
 * worker-console forwarding — there is no live apply: flipping the flag takes
 * effect on the next runtime (reload or re-login).
 *
 * Catalogued in docs/development/EXPERIMENTAL_OPTIONS.md
 * (experimentalConcurrentWatchRefresh).
 */

const STORAGE_KEY = "concurrentWatchRefresh";

type CommonfabricGlobal = typeof globalThis & {
  commonfabric?:
    & { concurrentWatchRefresh?: (enabled?: boolean) => void }
    & Record<string, unknown>;
};

/** Whether concurrent watch refresh is enabled for this browser profile. */
export function isConcurrentWatchRefreshEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function setConcurrentWatchRefresh(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.error(
      "[concurrent-watch-refresh] Could not persist the setting:",
      error,
    );
    return;
  }
  console.info(
    `[concurrent-watch-refresh] Concurrent watch refresh ${
      enabled ? "enabled" : "disabled"
    }. Takes effect on the next runtime (reload).`,
  );
}

/**
 * Install `commonfabric.concurrentWatchRefresh(enabled?)`. Run once at boot,
 * before any runtime exists. Prints a hint only while the flag is ON so its
 * presence is discoverable from the console; the default-off state stays silent.
 */
export function setupConcurrentWatchRefreshToggle(): void {
  const global = globalThis as CommonfabricGlobal;
  const cf = (global.commonfabric ??= {});
  cf.concurrentWatchRefresh = (enabled = true) =>
    setConcurrentWatchRefresh(enabled);

  if (isConcurrentWatchRefreshEnabled()) {
    console.info(
      "[concurrent-watch-refresh] Concurrent watch refresh is ON — watch " +
        "acquisition overlaps up to a bounded window. Disable with " +
        "commonfabric.concurrentWatchRefresh(false).",
    );
  }
}
