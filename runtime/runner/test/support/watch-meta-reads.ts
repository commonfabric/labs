import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";

/**
 * Calls `onRead` before each read of the meta field `field` of any document,
 * through any transaction, until the returned function is called. A cell reads
 * its meta through its transaction, so this sees every `getMetaRaw()` of
 * `field`; an `onRead` that throws fails the read.
 */
export function watchMetaReads(
  field: string,
  onRead: () => void,
): () => void {
  const prototype = ExtendedStorageTransaction.prototype;
  const readOrThrow = prototype.readOrThrow;
  prototype.readOrThrow = function (address, options) {
    if (address.path.length === 1 && address.path[0] === field) onRead();
    return readOrThrow.call(this, address, options);
  };
  return () => {
    prototype.readOrThrow = readOrThrow;
  };
}
