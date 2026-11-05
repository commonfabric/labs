/**
 * A transaction that intercepts the calls made on another, for a test that
 * observes, alters, or fails them. A `Proxy` over a transaction does not serve:
 * a cell binds only to a transaction the runtime created, and a proxy is not
 * one.
 */

import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

/**
 * Called for each method call on an intercepted transaction, with the method's
 * name and arguments. `proceed` makes the call on the transaction underneath
 * and returns its result; what the interceptor returns is the call's result.
 */
export type TransactionInterceptor = (
  method: string,
  args: unknown[],
  proceed: () => unknown,
) => unknown;

const interceptors = new WeakMap<object, TransactionInterceptor>();

// A `TransactionWrapper` whose every method goes through the interceptor its
// instance was made with. A method the wrapper does not forward, the
// transaction's optional ones among them, goes to the wrapped transaction.
class InterceptedTransaction extends TransactionWrapper {}

const methodNames = new Set(
  [ExtendedStorageTransaction.prototype, TransactionWrapper.prototype]
    .flatMap((prototype) =>
      Object.getOwnPropertyNames(prototype).filter((name) =>
        name !== "constructor" && name !== "accessForTestingOnly" &&
        typeof Object.getOwnPropertyDescriptor(prototype, name)?.value ===
          "function"
      )
    ),
);
for (const name of methodNames) {
  const forwarded = Object.getOwnPropertyDescriptor(
    TransactionWrapper.prototype,
    name,
  )?.value;
  Object.defineProperty(InterceptedTransaction.prototype, name, {
    configurable: true,
    writable: true,
    value(this: InterceptedTransaction, ...args: unknown[]) {
      const proceed = () =>
        typeof forwarded === "function"
          ? forwarded.apply(this, args)
          : Reflect.get(this.wrappedTransaction, name)?.apply(
            this.wrappedTransaction,
            args,
          );
      const interceptor = interceptors.get(this);
      return interceptor === undefined
        ? proceed()
        : interceptor(name, args, proceed);
    },
  });
}

/**
 * Returns a transaction that makes every call on `tx`, through `interceptor`.
 */
export function interceptTransaction(
  tx: IExtendedStorageTransaction,
  interceptor: TransactionInterceptor,
): IExtendedStorageTransaction {
  const intercepted = new InterceptedTransaction(tx);
  interceptors.set(intercepted, interceptor);
  return intercepted;
}
