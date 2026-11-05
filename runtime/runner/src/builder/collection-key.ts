/** Preserves selector key kinds across the pattern result serialization boundary. */

import { isCell } from "../cell.ts";

/** Tags an extracted key before its Cell reference is serialized as a link. */
export function tagCollectionKey<T>(value: T): { isCell: boolean; value: T } {
  return { isCell: isCell(value), value };
}
