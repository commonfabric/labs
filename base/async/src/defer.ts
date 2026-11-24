/** Interface for a deferred promise with external resolve/reject control. */
export interface Deferred<T = void, E = Error> {
  /** Resolves `promise` with `value`. */
  resolve(value: T): void;

  /** Rejects `promise` with `value`. */
  reject(value?: E): void;

  /** The promise being controlled. */
  promise: Promise<T>;
}

/** Creates a deferred promise, resolvable and rejectable from outside it. */
export function defer<T = void, E = Error>(): Deferred<T, E> {
  let resolve;
  let reject;
  const promise: Promise<T> = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve: resolve!, reject: reject!, promise };
}
