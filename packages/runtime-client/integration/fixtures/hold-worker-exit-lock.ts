// Imported first by `runtime-worker.ts`, so that the lock is held before any of
// the runtime is loaded. It is a module of its own because a module's body runs
// after everything it imports: taking the lock in `runtime-worker.ts` itself
// would take it after the whole runtime had loaded and reported ready.
import { holdWorkerExitLock } from "../worker-exit-lock.ts";

holdWorkerExitLock();
