/**
 * What a test puts in place of the three things `RuntimeProcessor.initialize`
 * reaches outside itself. A processor stood up for real opens a storage
 * manager against a backend, asks that backend for a health check, and leaves
 * a subscription on the home space's site table running. A test that wants
 * the initialization and not the backend supplies its own storage, answers
 * the check itself where its outcome matters, and lets the site table pass.
 */

import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";

import { RuntimeProcessor } from "@/backends/runtime-processor.ts";

/**
 * Opens storage through `open`, answers the health check with `healthCheck`
 * (healthy, unless one is given), and leaves the site table unwatched, for as
 * long as the returned function has not been called. Calling it puts all
 * three back, so it belongs in a `finally`.
 */
export function stubWorkerBoot(
  open: typeof StorageManager.open,
  healthCheck: () => Promise<boolean> = () => Promise.resolve(true),
): () => void {
  const originalOpen = StorageManager.open;
  const originalHealthCheck = Runtime.prototype.healthCheck;
  const originalWatchSiteTable = RuntimeProcessor.prototype.watchSiteTable;
  StorageManager.open = open;
  Runtime.prototype.healthCheck = healthCheck;
  RuntimeProcessor.prototype.watchSiteTable = () => {};
  return () => {
    StorageManager.open = originalOpen;
    Runtime.prototype.healthCheck = originalHealthCheck;
    RuntimeProcessor.prototype.watchSiteTable = originalWatchSiteTable;
  };
}
