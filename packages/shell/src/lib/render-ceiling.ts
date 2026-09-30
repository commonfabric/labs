/**
 * Per-profile toggle for the CFC render confidentiality ceiling (Epic H3a,
 * docs/history/plans/cfc-future-work-implementation.md §7). When enabled, the shell
 * creates its runtime with the §8.10.6 default display ceiling populated:
 * display sinks admit only the acting user's own identity atom plus
 * allow-listed influence-class caveat kinds, everything else fails closed,
 * and author-supplied render-boundary declassification is denied.
 *
 * Default ON; `commonfabric.cfcRenderCeiling(false)` opts a browser profile
 * out. The ceiling crosses the worker IPC in InitializationData, which is
 * fixed for a runtime's lifetime: unlike worker-console forwarding there is
 * no live apply — flipping the flag takes effect on the next runtime
 * (reload or re-login).
 *
 * Catalogued in docs/development/EXPERIMENTAL_OPTIONS.md (cfcRenderCeiling).
 */

const STORAGE_KEY = "cfcRenderCeiling";

type CommonfabricGlobal = typeof globalThis & {
  commonfabric?:
    & { cfcRenderCeiling?: (enabled?: boolean) => void }
    & Record<string, unknown>;
};

/** Whether the render ceiling is enabled for this browser profile. */
export function isCfcRenderCeilingEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setCfcRenderCeiling(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } else {
      globalThis.localStorage.setItem(STORAGE_KEY, "false");
    }
  } catch (error) {
    console.error("[render-ceiling] Could not persist the setting:", error);
    return;
  }
  console.info(
    `[render-ceiling] CFC render ceiling ${
      enabled ? "enabled" : "disabled"
    }. Takes effect on the next runtime (reload).`,
  );
}

/**
 * Install `commonfabric.cfcRenderCeiling(enabled?)`. Run once at boot, before
 * any runtime exists. Prints a hint only while the ceiling is OFF: the
 * opted-out profile renders labeled content unbounded, so the reduced
 * posture must be discoverable from the console; the default-on state stays
 * silent.
 */
export function setupCfcRenderCeilingToggle(): void {
  const global = globalThis as CommonfabricGlobal;
  const cf = (global.commonfabric ??= {});
  cf.cfcRenderCeiling = (enabled = true) => setCfcRenderCeiling(enabled);

  if (!isCfcRenderCeilingEnabled()) {
    console.info(
      "[render-ceiling] CFC render ceiling is OFF for this profile — " +
        "labeled content renders without display gating. Re-enable with " +
        "commonfabric.cfcRenderCeiling().",
    );
  }
}
