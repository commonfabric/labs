/**
 * Aggregation seam for the shell's per-browser-profile host toggles — the
 * localStorage-persisted dogfood flags with `commonfabric.*` console
 * commands. Each toggle owns its storage key and command (worker-console.ts,
 * render-ceiling.ts); this module is the single place boot and runtime
 * creation consume them, so adding a toggle does not touch the untestable
 * entry module or the RootView task body.
 */

import {
  isWorkerConsoleForwardingEnabled,
  setupWorkerConsoleToggle,
} from "./worker-console.ts";
import {
  isCfcRenderCeilingEnabled,
  setupCfcRenderCeilingToggle,
} from "./render-ceiling.ts";
import {
  isConcurrentWatchRefreshEnabled,
  setupConcurrentWatchRefreshToggle,
} from "./concurrent-watch-refresh.ts";

/**
 * Install every `commonfabric.*` host-toggle console command. Run once at
 * boot, before any runtime exists, so the commands are available while
 * logged out.
 */
export function setupHostToggles(): void {
  setupWorkerConsoleToggle();
  setupCfcRenderCeilingToggle();
  setupConcurrentWatchRefreshToggle();
}

/**
 * Read the pattern-coverage host flag. Unlike the other toggles this carries no
 * `commonfabric.*` console command: it is set by the integration harness via
 * localStorage before login (gated by CF_PATTERN_COVERAGE_DIR on the test
 * process), never by a dogfooding user. See docs/development/COVERAGE.md.
 */
export function isPatternCoverageEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("patternCoverage") === "true";
  } catch {
    return false;
  }
}

/**
 * The host-toggle flags read at runtime creation and passed to
 * RuntimeInternals.create. Read fresh per creation: a re-created runtime
 * (identity or host change) picks up the current persisted state.
 */
export function runtimeHostFlags(): {
  forwardWorkerConsole: boolean;
  cfcRenderCeiling: boolean;
  patternCoverage: boolean;
  concurrentWatchRefresh: boolean;
} {
  return {
    forwardWorkerConsole: isWorkerConsoleForwardingEnabled(),
    cfcRenderCeiling: isCfcRenderCeilingEnabled(),
    patternCoverage: isPatternCoverageEnabled(),
    concurrentWatchRefresh: isConcurrentWatchRefreshEnabled(),
  };
}
