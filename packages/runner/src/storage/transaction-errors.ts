import { debugStr, toCompactDebugString } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type {
  IInvalidArrayLengthError,
  IMemoryAddress,
  IReadOnlyAddressError,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  IStorageTransactionWriteIsolationError,
  MemorySpace,
} from "./interface.ts";

/**
 * Error objects a storage transaction returns through its `Result` values.
 * These are plain objects rather than `Error` instances: a transaction
 * produces them on ordinary control-flow paths, and building a stack trace
 * for each one dominates the cost. Use `toThrowable` in `interface.ts` at a
 * throw site that needs a real `Error`.
 */

/** The transaction has already committed or aborted. */
export const TransactionCompleteError = (): IStorageTransactionComplete => ({
  name: "StorageTransactionCompleteError",
  message: "Transaction is complete",
});

/**
 * The message of a {@link TransactionAborted}, which names no cause: the cause
 * rides its `reason`.
 */
const TRANSACTION_ABORTED_MESSAGE = "Transaction was aborted";

/** The transaction was aborted, carrying the reason given to `abort()`. */
export const TransactionAborted = (
  reason?: unknown,
): IStorageTransactionAborted => ({
  name: "StorageTransactionAborted",
  message: TRANSACTION_ABORTED_MESSAGE,
  abortedBeforeStorage: true,
  reason,
});

/**
 * Returns the text that says why a transaction failed, given the error its
 * status or commit reported. A message other than a {@link TransactionAborted}'s
 * carries the cause itself, and is returned as it is, whether or not the error
 * also has a `reason`. For that message, or none, the `reason`, when there is
 * one, is read the same way, so the cause a handler threw is what is returned.
 * An error with neither message nor reason is rendered whole.
 */
export const transactionFailureMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  const message = isObjectOrArray(error) &&
      typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
  if (message !== "" && message !== TRANSACTION_ABORTED_MESSAGE) {
    return message;
  }
  const reason = isObjectOrArray(error)
    ? (error as { reason?: unknown }).reason
    : undefined;
  if (reason !== undefined && reason !== null) {
    return transactionFailureMessage(reason);
  }
  return message !== "" ? message : toCompactDebugString(error);
};

/**
 * A writer was requested for one space while the transaction already holds a
 * writer for another. A transaction writes to a single space.
 */
export const WriteIsolationError = (
  { open, requested }: { open: MemorySpace; requested: MemorySpace },
): IStorageTransactionWriteIsolationError => ({
  name: "StorageTransactionWriteIsolationError",
  message:
    `Can not open transaction writer for ${requested} because transaction has writer open for ${open}`,
  open,
  requested,
});

/**
 * A write was addressed to a `data:` identifier. Such an address carries its
 * own value instead of naming a document, so there is nothing to write to.
 */
export const ReadOnlyAddressError = (
  address: IMemoryAddress,
): IReadOnlyAddressError => ({
  name: "ReadOnlyAddressError",
  message: `Cannot write to read-only address: ${address.id}`,
  address,
  from(_space: MemorySpace) {
    return this;
  },
});

/**
 * Returns the error for a write to the `length` at `address` that would grow
 * that array to `requested`, which is `2 ** 32` or more, longer than any array
 * can be.
 */
export const InvalidArrayLengthError = (
  address: IMemoryAddress,
  requested: number,
): IInvalidArrayLengthError => ({
  name: "InvalidArrayLengthError",
  message: debugStr`Cannot grow the array at $quote,long${
    address.path.slice(0, -1)
  } in $quote,long${address.id} to length $quote${requested}: an array's length must be below \`2 ** 32\``,
  address,
  from(_space: MemorySpace) {
    return this;
  },
});
