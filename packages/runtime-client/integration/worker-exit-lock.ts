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
 * A worker takes a shared lock on the file its barrier names before it loads
 * the runtime, and never releases it. The descriptor closes when Deno tears the
 * worker's runtime down, which it does only after the worker has written its
 * profiles. So once the barrier can take the same lock exclusively, none of its
 * workers is still writing. See `worker-exit-barrier.ts`.
 *
 * The lock is `flock`, which belongs to an open file rather than to a process,
 * so the barrier's exclusive attempt conflicts with its own workers' shared
 * locks although all of them are in one process.
 */

/** The worker URL's search parameter naming the lock file. */
export const WORKER_EXIT_LOCK_PARAMETER = "exit-lock";

/**
 * Held for the life of the worker, and never closed: its closing, when the
 * worker's runtime is torn down, is the signal. Kept in a module binding so
 * that nothing could ever collect it and close it early.
 */
let held: Deno.FsFile | undefined;

/**
 * Takes a shared lock on the file named by `moduleUrl`'s search parameter, for
 * the life of this worker.
 *
 * @throws If the URL names no lock file, which means the worker was started
 *   other than through the barrier and so would go unwaited for.
 */
export function holdWorkerExitLock(moduleUrl: string): void {
  const lockPath = new URL(moduleUrl).searchParams.get(
    WORKER_EXIT_LOCK_PARAMETER,
  );
  if (!lockPath) {
    throw new Error(
      `${moduleUrl} names no ${WORKER_EXIT_LOCK_PARAMETER}: start this worker through WorkerExitBarrier, which names the lock it holds`,
    );
  }
  held = Deno.openSync(lockPath, { read: true });
  held.lockSync(false);
}
