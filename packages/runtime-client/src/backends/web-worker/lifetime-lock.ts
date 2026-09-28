/**
 * Takes a Web Lock under a fresh random name and holds it for as long as the
 * calling runtime lives, resolving with the name once the lock is held; see
 * `WorkerReadyNotification.lifetimeLock`.
 *
 * Resolves with `undefined` when the lock cannot be taken, as in a context
 * without Web Locks. The lock only lets a transport wait for the worker's
 * teardown, so a worker without one still starts, and is not waited for.
 */
export function holdLifetimeLock(): Promise<string | undefined> {
  const name = crypto.randomUUID();
  return new Promise<string>((held, refused) => {
    navigator.locks.request(name, () => {
      held(name);
      return new Promise<never>(() => {});
    }).catch(refused);
  }).catch(() => undefined);
}
