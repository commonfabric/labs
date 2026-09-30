/**
 * A worker that takes its lifetime lock and posts the lock's name, for
 * `worker-lifetime.test.ts` to terminate it by.
 */

import { holdWorkerLifetimeLock } from "../../src/worker-lifetime.ts";

self.postMessage(await holdWorkerLifetimeLock());
