/**
 * Value reads that propagate an unavailable ancestor without changing the
 * logical target of the read or the transaction's read-policy checks.
 */
import { isUnavailable } from "@commonfabric/data-model/availability";

import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "./interface.ts";

/** Returns a native unavailable ancestor when it prevents a child value read. */
export function readAvailabilityValue(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  options?: IReadOptions,
): ReturnType<IExtendedStorageTransaction["read"]> {
  const result = tx.read(address, options);
  if (result.error?.name !== "TypeMismatchError") return result;

  const failed = result.error.address;
  const parentPath = failed.path.slice(0, -1);
  if (
    address.path[0] !== "value" || parentPath.length === 0 ||
    parentPath.length >= address.path.length ||
    failed.id !== address.id || failed.type !== address.type ||
    failed.scope !== address.scope ||
    !parentPath.every((part, index) => part === address.path[index])
  ) return result;

  // The parent is a value read, with the same policy and metadata as the
  // requested child. Ordinary primitives retain the original path mismatch.
  const ancestor = tx.read({ ...address, path: parentPath }, {
    ...options,
    nonRecursive: true,
  });
  if (ancestor.ok !== undefined && isUnavailable(ancestor.ok.value)) {
    // Returning the marker observes its value, including a terminal message.
    // Record content consumption even when the child read only asked for shape.
    const content = tx.read({ ...address, path: parentPath }, {
      ...options,
      nonRecursive: false,
    });
    if (content.ok !== undefined && isUnavailable(content.ok.value)) {
      return { ok: { ...content.ok, address } };
    }
    return content;
  }
  return result;
}
