/**
 * The test side of `value-debug-internal-worker.ts`: starts a worker, sends it
 * one request, and returns its report.
 *
 * Not a `*.test.ts` file, so the runner does not pick it up as a suite.
 */

import { defer } from "@commonfabric/utils/defer";

import type {
  InternalReport,
  InternalRequest,
} from "./value-debug-internal-worker.ts";

/**
 * Returns what a fresh realm reports after loading `load`, a module URL, or
 * after loading nothing when `load` is `null`.
 */
export async function reportFromFreshRealm(
  load: string | null,
): Promise<InternalReport> {
  const worker = new Worker(
    new URL("./value-debug-internal-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const report = defer<InternalReport>();

  worker.onmessage = (ev) => report.resolve(ev.data as InternalReport);
  worker.onerror = (ev) => report.reject(new Error(ev.message));

  try {
    worker.postMessage({ load } satisfies InternalRequest);
    return await report.promise;
  } finally {
    worker.terminate();
  }
}
