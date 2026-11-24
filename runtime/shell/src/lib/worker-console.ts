/**
 * Runtime toggle for forwarding the web-worker runtime's console output to the
 * main thread (the page console). The flag is read here on the main thread and
 * passed to the worker, which patches its console only while enabled: the
 * worker is a browser context with no access to localStorage, so it cannot
 * read the setting itself.
 *
 * The setting is persisted in localStorage, which seeds the worker when a
 * runtime is created (covering startup logging and fresh page loads).
 * `commonfabric.forwardWorkerConsole(enabled?)` also applies it to the running
 * worker immediately, so flipping it needs no reload. A hint is printed at
 * boot.
 */

import type { RuntimeClient } from "@commonfabric/runtime-client";

const STORAGE_KEY = "forwardWorkerConsole";

type CommonfabricGlobal = typeof globalThis & {
  commonfabric?:
    & {
      rt?: RuntimeClient;
      forwardWorkerConsole?: (enabled?: boolean) => void;
    }
    & Record<string, unknown>;
};

/** Whether worker console forwarding is enabled for this session. */
export function isWorkerConsoleForwardingEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function setWorkerConsoleForwarding(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.error("[worker-console] Could not persist the setting:", error);
    return;
  }
  // Apply to the running worker now; the persisted value seeds the next one.
  const rt = (globalThis as CommonfabricGlobal).commonfabric?.rt;
  void rt?.setForwardWorkerConsole(enabled).catch((error: unknown) => {
    console.error(
      "[worker-console] Could not update the running runtime:",
      error,
    );
  });
  console.info(
    `[worker-console] Worker console forwarding ${
      enabled ? "enabled" : "disabled"
    }.`,
  );
}

/**
 * Install `commonfabric.forwardWorkerConsole(enabled?)` and print a one-line
 * hint describing the current state and how to flip it. Run once at boot,
 * before any runtime exists, so the command is available while logged out.
 */
export function setupWorkerConsoleToggle(): void {
  const global = globalThis as CommonfabricGlobal;
  const cf = (global.commonfabric ??= {});
  cf.forwardWorkerConsole = (enabled = true) =>
    setWorkerConsoleForwarding(enabled);

  if (isWorkerConsoleForwardingEnabled()) {
    console.info(
      "[worker-console] Worker runtime console forwarding is ON. Disable with " +
        "commonfabric.forwardWorkerConsole(false).",
    );
  } else {
    console.info(
      "[worker-console] Worker runtime console forwarding is OFF. Enable with " +
        "commonfabric.forwardWorkerConsole().",
    );
  }
}
