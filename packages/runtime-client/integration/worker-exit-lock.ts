/**
 * The lock a runtime worker started by these tests holds for as long as it
 * exists, which is how the test process learns that its workers are gone.
 *
 * Why this exists: under coverage, each worker writes its own coverage profiles
 * as it shuts down, on its own thread. `Worker.terminate()` only starts that;
 * nothing a page can observe says when it is done. The runtime a worker loads
 * includes TypeScript, whose profile runs to several megabytes, so writing a
 * worker's profiles takes long enough that `deno test` could finish, write its
 * own profiles, and exit first. A process that exits while one of its workers
 * is writing cuts that file off, and `deno coverage` then refuses every profile
 * in the directory, which fails the lane without failing a test.
 *
 * A worker takes a shared lock on one file before anything else it runs, and
 * never releases it. The descriptor closes when Deno tears the worker's runtime
 * down, which it does only after the worker has written its profiles. So once
 * the test process can take the same lock exclusively, no worker is still
 * writing. See `worker-exit-barrier.ts`.
 *
 * This module has no side effects, so that the barrier can read the variable's
 * name from it without taking the lock itself.
 */

/** The variable naming the lock file, set by the barrier for its workers. */
export const WORKER_EXIT_LOCK_VARIABLE = "CF_RUNTIME_WORKER_EXIT_LOCK";

/**
 * Takes a shared lock on the file the barrier named, for the life of this
 * worker. The file is deliberately never closed: its closing is the signal.
 *
 * @throws If no lock file is named, which means the worker was started other
 *   than through the barrier and so would go unwaited for.
 */
export function holdWorkerExitLock(): void {
  const lockPath = Deno.env.get(WORKER_EXIT_LOCK_VARIABLE);
  if (!lockPath) {
    throw new Error(
      `${WORKER_EXIT_LOCK_VARIABLE} is not set: start this worker through WorkerExitBarrier, which names the lock it holds`,
    );
  }
  const file = Deno.openSync(lockPath, { read: true });
  file.lockSync(false);
}
