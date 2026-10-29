import { ContextualFlowControl } from "../cfc.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isPrimitiveCellLink, parseLink } from "../link-utils.ts";

/**
 * Build the link for one raw list slot without reading the slot's value.
 *
 * A linked slot already carries its target path and optional schema, so parse
 * it directly against the list base. The list link's container schema only
 * needs narrowing when the slot is inline at this array index.
 */
export function listElementLink(
  listBase: NormalizedFullLink,
  slot: unknown,
  index: number,
): NormalizedFullLink {
  if (isPrimitiveCellLink(slot)) return parseLink(slot, listBase);
  return listSlotPlace(listBase, index);
}

/**
 * The link to the place at `index` in the list at `listBase`, whatever the
 * slot there holds, its schema narrowed to that index.
 */
export function listSlotPlace(
  listBase: NormalizedFullLink,
  index: number,
): NormalizedFullLink {
  const indexPart = String(index);
  return {
    ...listBase,
    path: [...listBase.path, indexPart],
    schema: listBase.schema === undefined
      ? undefined
      : ContextualFlowControl.schemaAtPath(listBase.schema, [indexPart]),
  };
}
