/** Reads recorded cell references, including short entity IDs in console fixtures. */

import { entityUriSchemePrefix } from "@commonfabric/runner/entity-kind";
import {
  parseCellReference,
  type ReferenceParts,
} from "@commonfabric/runner/shared";

/**
 * Reads an entity reference with the shared grammar. Recorded short IDs are
 * admitted without the runtime's minted-handle length check. Argument members
 * require piece metadata resolution and are not harness cell references.
 */
export const parseConsoleReference = (
  text: string,
): ReferenceParts | undefined => {
  try {
    text = text.trimStart();
    const parts = parseCellReference(text.startsWith("/") ? text : `/${text}`);
    const prefix = entityUriSchemePrefix(parts.id);
    if (
      prefix === undefined || parts.id.length === prefix.length ||
      parts.member === "argument"
    ) return undefined;
    return { ...parts, scope: parts.scope ?? "space" };
  } catch {
    return undefined;
  }
};
