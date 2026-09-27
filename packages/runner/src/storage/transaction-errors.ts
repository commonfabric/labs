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

/** The transaction was aborted, carrying the reason given to `abort()`. */
export const TransactionAborted = (
  reason?: unknown,
): IStorageTransactionAborted => ({
  name: "StorageTransactionAborted",
  message: "Transaction was aborted",
  abortedBeforeStorage: true,
  reason,
});

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
 * A write set the array `length` at `address` to `length`, which no array can
 * have. A length is an integer below `2 ** 32`.
 */
export const InvalidArrayLengthError = (
  address: IMemoryAddress,
  length: number,
): IInvalidArrayLengthError => ({
  name: "InvalidArrayLengthError",
  message: `Cannot write \`${length}\` at path [${
    address.path.join(", ")
  }]: an array's length is below \`2 ** 32\``,
  address,
  from(_space: MemorySpace) {
    return this;
  },
});
