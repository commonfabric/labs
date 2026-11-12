/**
 * Host toggle for the runtime's `syncCidReferences` experimental option
 * (`syncCidReferencesV1`, docs/development/EXPERIMENTAL_OPTIONS.md): whether
 * the shell's runtime takes `cid:` schema documents by reference from a
 * server that offers them. A deployment's server offers it by default, and a
 * client takes it only when it opts in, which this toggle is the shell's way
 * to do: per browser profile, through `localStorage`, so a host embedding the
 * shell can opt in by setting the key before the shell loads, with no build
 * of its own.
 *
 * Default off. The option is fixed when the runtime is created, so flipping
 * it takes effect on the next runtime (reload or re-login).
 */

const STORAGE_KEY = "syncCidReferences";

type CommonfabricGlobal = typeof globalThis & {
  commonfabric?:
    & { syncCidReferences?: (enabled?: boolean) => void }
    & Record<string, unknown>;
};

/** Whether this browser profile opts in to schema documents by reference. */
export function isSyncCidReferencesEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Helper for the console command, which persists the setting. */
function setSyncCidReferences(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.error(
      "[sync-cid-references] Could not persist the setting:",
      error,
    );
    return;
  }
  console.info(
    `[sync-cid-references] Schema documents by reference ${
      enabled ? "enabled" : "disabled"
    }. Takes effect on the next runtime (reload).`,
  );
}

/**
 * Installs `commonfabric.syncCidReferences(enabled?)`. Run once at boot,
 * before any runtime exists. Prints a hint only while the toggle is on, so
 * its presence is discoverable from the console.
 */
export function setupSyncCidReferencesToggle(): void {
  const global = globalThis as CommonfabricGlobal;
  const cf = (global.commonfabric ??= {});
  cf.syncCidReferences = (enabled = true) => setSyncCidReferences(enabled);

  if (isSyncCidReferencesEnabled()) {
    console.info(
      "[sync-cid-references] Schema documents by reference are ON for this " +
        "profile. Disable with commonfabric.syncCidReferences(false).",
    );
  }
}
