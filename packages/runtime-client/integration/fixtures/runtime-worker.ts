/**
 * The runtime worker these integration tests start: the real worker entry,
 * preceded by the lock that lets the test process wait for the worker to be
 * gone. See `../worker-exit-lock.ts`.
 *
 * The runtime is imported dynamically, after the lock is held. A static import
 * would load and evaluate it before this module's body ran.
 */
import { holdWorkerExitLock } from "../worker-exit-lock.ts";

holdWorkerExitLock(import.meta.url);
await import("../../src/backends/web-worker/index.ts");
