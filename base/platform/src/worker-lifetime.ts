/**
 * Lets the code that starts a web worker wait until that worker has been torn
 * down, which `Worker` offers no event for.
 *
 * `terminate()` returns while the worker is still shutting down. Under Deno's
 * coverage collection that shutdown is when the worker writes its coverage
 * profiles, and a process that exits before they are written loses them or
 * leaves one truncated; one truncated profile makes `deno coverage` refuse
 * every profile in the directory it is in. Deno releases the Web Locks a web
 * worker holds only once the worker's runtime has been torn down, which is
 * after that write, so a lock the worker takes for itself and never releases
 * marks the end of its teardown. A Node `worker_threads` worker is not covered:
 * Deno releases its locks when it is terminated.
 */

/**
 * Takes a Web Lock that the calling worker holds for the rest of its life, and
 * returns the lock's name once it is held. The worker hands the name to the
 * code that started it, which passes it to {@link terminateWorker}.
 *
 * Returns `undefined` when the lock cannot be taken, as in a context without
 * Web Locks. The lock only lets the worker's creator wait for its teardown, so
 * a worker without one still runs, and is not waited for.
 *
 * The worker's message listener is installed before this is awaited: a message
 * that reaches a worker before it has a listener is dropped.
 */
export function holdWorkerLifetimeLock(): Promise<string | undefined> {
  const name = crypto.randomUUID();
  return new Promise<string>((held, refused) => {
    navigator.locks.request(name, () => {
      held(name);
      return new Promise<never>(() => {});
    }).catch(refused);
  }).catch(() => undefined);
}

/**
 * Terminates `worker`, and settles once its runtime has been torn down.
 *
 * `lifetimeLock` is the name {@link holdWorkerLifetimeLock} returned inside
 * the worker. When it is `undefined`, as it is for a worker that took no lock
 * or failed before handing one over, this settles once `terminate()` has
 * returned.
 */
export async function terminateWorker(
  worker: Worker,
  lifetimeLock: string | undefined,
): Promise<void> {
  worker.terminate();
  if (lifetimeLock !== undefined) {
    await navigator.locks.request(lifetimeLock, () => {});
  }
}
