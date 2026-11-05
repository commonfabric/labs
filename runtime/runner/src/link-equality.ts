/** Link identity comparisons, including native and portable immutable values. */

import type { Cell } from "./cell.ts";
import { immutableContentId } from "./data-uri.ts";
import { isInlineCellId } from "./immutable-cell.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areNormalizedLinksSame,
  isNormalizedFullLink,
  type NormalizedLink,
} from "./link-types.ts";
import { parseLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Compare two link values for equality, supporting all link formats
 */
export function areLinksSame(
  value1: any,
  value2: any,
  base?: Cell | NormalizedLink,
  resolveBeforeComparing?: boolean,
  txForResolving?: IExtendedStorageTransaction,
  runtime?: Runtime,
  markIfcCrossings?: boolean,
): boolean {
  if (value1 === undefined && value2 === undefined) return false;

  // If both are the same object, they're equal
  if (value1 === value2) return true;

  // If either is null/undefined, they're only equal if both are
  if (!value1 || !value2) return value1 === value2;

  // Try parsing both as links
  let link1 = parseLink(value1, base);
  let link2 = parseLink(value2, base);

  // If one parses and the other doesn't, they're not equal
  if (!link1 || !link2) return false;

  if (resolveBeforeComparing) {
    const tx = txForResolving;
    if (!tx) throw new Error("Provide tx to resolve before comparing");
    if (!runtime) {
      throw new Error("Provide runtime to resolve before comparing");
    }
    // Content-reading callers (a candidate comparison reads through the
    // links it resolves) opt into the ifc crossing seam; identity-only
    // callers leave it off.
    const options = markIfcCrossings ? { markIfcCrossings: true } : {};
    link1 = isNormalizedFullLink(link1)
      ? resolveLink(runtime, tx, link1, "value", options)
      : link1;
    link2 = isNormalizedFullLink(link2)
      ? resolveLink(runtime, tx, link2, "value", options)
      : link2;
  }

  // Compare normalized links
  if (areNormalizedLinksSame(link1, link2)) return true;
  if (
    link1.id !== undefined && link2.id !== undefined &&
    isInlineCellId(link1.id) && isInlineCellId(link2.id) &&
    areNormalizedLinksSame({ ...link1, id: link2.id }, link2)
  ) {
    return immutableContentId(link1.id) === immutableContentId(link2.id);
  }
  return false;
}
