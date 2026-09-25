/**
 * The two setters for a transaction's CFC trust state: the acting principal
 * its trust is taken from, and the implementation identity its writes are
 * authored by.
 *
 * Host code that writes as a trusted builtin imports them from here, so an
 * import of this module names the authority it takes. The sandbox lets
 * pattern code import none of the runtime's modules, and the transaction has
 * no method that does the same, so holding a transaction through a cell is
 * not enough to set either one.
 */
export {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../storage/extended-storage-transaction.ts";
