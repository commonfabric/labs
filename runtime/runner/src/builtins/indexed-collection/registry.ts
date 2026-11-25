/**
 * The registry of a space's indexed collections: one document per space,
 * keyed by database id, holding the link of each collection's handle. A
 * runtime that keeps current the collections of spaces whose declaring piece
 * it never loaded finds them here.
 */

import { createRef } from "../../create-ref.ts";
import type { Cell } from "../../cell.ts";
import type { Runtime } from "../../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../storage/interface.ts";
import { toURI } from "../../uri-utils.ts";

/** Cause of the per-space document listing the space's indexed collections. */
const REGISTRY_CAUSE = "indexed-collection-registry";

/**
 * Returns the id of the registry document. It is the same in every space, so
 * a caller holding no runtime can tell a write to one from its id.
 */
export function indexedCollectionRegistryId(): string {
  return toURI(createRef({}, REGISTRY_CAUSE));
}

/** Returns the registry cell of `space`, bound to `tx` when one is given. */
export function indexedCollectionRegistry(
  runtime: Runtime,
  space: MemorySpace,
  tx?: IExtendedStorageTransaction,
): Cell<Record<string, unknown>> {
  return runtime.getCell<Record<string, unknown>>(
    space,
    REGISTRY_CAUSE,
    undefined,
    tx,
  );
}

/**
 * Lists the collection whose database is `id` and whose handle is `handle`
 * in its space's registry, in `tx`, unless it is listed already.
 */
export function listIndexedCollection(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  handle: Cell<unknown>,
  id: string,
): void {
  const entry = indexedCollectionRegistry(runtime, handle.space, tx).key(id);
  if (entry.getRaw() !== undefined) return;
  entry.setRaw(JSON.stringify(handle.getAsLink()));
}
