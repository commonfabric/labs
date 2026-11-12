/** Link identity comparisons, including native and portable immutable values. */

import type { Cell } from "./cell.ts";
import { immutableContentId } from "./data-uri.ts";
import { isInlineCellId } from "./immutable-cell.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areNormalizedLinksSame,
  isNormalizedFullLink,
  type NormalizedLink,
  normalizedLinkKey,
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
    link1 = resolveForComparison(
      link1,
      txForResolving,
      runtime,
      markIfcCrossings,
    );
    link2 = resolveForComparison(
      link2,
      txForResolving,
      runtime,
      markIfcCrossings,
    );
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

/**
 * Returns a string that two values share exactly when `areLinksSame()` returns
 * `true` for them given the same `base` and resolution arguments, so that a
 * `Set` or a `Map` keyed by it matches a list's values in one pass where
 * `areLinksSame()` compares them in pairs.
 *
 * Returns `undefined` for a value that is not a link. `areLinksSame()` matches
 * such a value to nothing but itself, which no string can stand for.
 *
 * With `resolveBeforeComparing`, the key is that of the link `value` resolves
 * to in `txForResolving`, so it holds for that transaction's view, and making
 * it records the dereferences that resolving `value`'s side of an
 * `areLinksSame()` call records.
 *
 * @throws When asked to resolve without a transaction or a runtime.
 */
export function linkEqualityKey(
  value: unknown,
  base?: Cell | NormalizedLink,
  resolveBeforeComparing?: boolean,
  txForResolving?: IExtendedStorageTransaction,
  runtime?: Runtime,
): string | undefined {
  if (!value) return undefined;
  const parsed = parseLink(value, base);
  if (!parsed) return undefined;
  const link = resolveBeforeComparing
    ? resolveForComparison(parsed, txForResolving, runtime, false)
    : parsed;
  // An inline document is named by its content, as `areLinksSame()` matches
  // two of them.
  return normalizedLinkKey(
    link,
    link.id !== undefined && isInlineCellId(link.id)
      ? ["content", immutableContentId(link.id)]
      : link.id,
  );
}

/**
 * Helper for `areLinksSame()` and `linkEqualityKey()`, which turns `link` into
 * the link the two compare: for a full link, the one it resolves to in `tx`,
 * and a relative link as it stands, since it names no document to read.
 */
function resolveForComparison(
  link: NormalizedLink,
  tx: IExtendedStorageTransaction | undefined,
  runtime: Runtime | undefined,
  markIfcCrossings: boolean | undefined,
): NormalizedLink {
  if (!tx) throw new Error("Provide tx to resolve before comparing");
  if (!runtime) throw new Error("Provide runtime to resolve before comparing");
  // Content-reading callers (a candidate comparison reads through the
  // links it resolves) opt into the ifc crossing seam; identity-only
  // callers leave it off.
  const options = markIfcCrossings ? { markIfcCrossings: true } : {};
  return isNormalizedFullLink(link)
    ? resolveLink(runtime, tx, link, "value", options)
    : link;
}
