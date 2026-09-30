/**
 * Cell-side integration of the `data:` cell URI codec. The dividing line
 * between this module and `data-model`'s `codec-data-uri.ts` is the need
 * for the cell/link machinery: everything that can be expressed against
 * `data-model` alone lives in the codec (in that package); this module
 * holds the two operations that cannot -- {@link dataUriFromValueWithResolvedLinks},
 * which rewrites relative links against a base before encoding, and
 * {@link findAndInlineDataUriLinks}, which dissolves `data:` URI links
 * back into the values they carry.
 *
 * The payload encodes the cell's VALUE, and the codec's decode entry
 * points return that value. The document view that the address grammar
 * requires (`["value", ...]`-rooted and facet paths) is synthesized by the
 * one reader that thinks in documents -- `storage/transaction/
 * attestation.ts`'s `load()` -- which also guarantees that payload content
 * can never alias a document facet (`cfc`, `source`).
 *
 * The dependency on the link machinery is one-way: this module imports
 * from `link-utils.ts`, and `link-utils.ts` imports nothing back. The
 * relationship with `cell.ts` is mutual -- this module needs `isCell` (and
 * the `Cell` type) while `cell.ts` consumes it -- the same two-way shape
 * `cell.ts` and `link-utils.ts` had while these functions lived there,
 * relocated rather than newly introduced.
 */

import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import {
  dataUriFromValue,
  isFabricDataUri,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { type Cell, convertCellsToLinks, isCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { isPrimitiveCellLink, type NormalizedLink } from "./link-types.ts";
import {
  type CellLink,
  createSigilLinkFromParsedLink,
  inlineExternalSchemaRefsInValue,
  isCellLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import type { URI } from "./sigil-types.ts";

/**
 * Makes a `data:` URI that names a cell whose content is carried in the id
 * itself. Reading such a cell means decoding its own id; there is no document
 * in a space to fetch.
 *
 * The encoded payload is the cell's value itself; the document view that
 * the address grammar needs is synthesized on read (see the module doc).
 *
 * This is the encode half of the matched set this module exists to hold;
 * {@link valueFromDataUri} is what reads back what this writes. Both
 * sides speak only the standard `data-model` `FabricValue` encoding, which
 * carries that codec's prefix tag.
 *
 * Each primitive cell link within `data` is rewritten to a full sigil link,
 * with relative links resolved against `base`. That rewriting is what makes
 * the result self-contained: the ids it embeds don't depend on where it was
 * minted, so the URI denotes the same value wherever it later gets read.
 *
 * The standard encoding canonicalizes plain-object key order (UTF-8 byte
 * order, per `3-json-encoding.md` section 10), so two runtimes holding the
 * same value mint the same id regardless of key insertion history -- the
 * property that makes this content addressing actually address content.
 *
 * @param data The value to encode. Must be acyclic.
 * @param base Optional base link; relative links within `data` are resolved
 *   against it.
 * @returns A `data:` URI naming a cell whose content is `data`.
 * @throws If `data` contains a reference cycle.
 */
export function dataUriFromValueWithResolvedLinks(
  data: FabricValue,
  base?: Cell | NormalizedLink,
): URI {
  const baseLink = isCell(base) ? base.getAsNormalizedFullLink() : base;

  function traverseAndAddBaseIdToRelativeLinks(
    value: FabricValue,
    seen: Set<object>,
  ): FabricValue {
    if (!isObjectOrArray(value)) return value;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      if (isPrimitiveCellLink(value)) {
        const link = parseLink(value, baseLink);
        return createSigilLinkFromParsedLink(link, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
        });
      } else if (value instanceof FabricPrimitive) {
        // A `FabricPrimitive` is a leaf; the value encoding represents it
        // via its codec.
        return value;
      } else if (value instanceof FabricInstance) {
        // TODO(danfuzz): A `FabricInstance` is not a leaf: its state can
        // carry cell links, which need the same relative-to-absolute
        // rewriting as everything else. That requires codec-mediated
        // traversal into instance state; until that exists, the instance
        // passes through unrewritten (encoded correctly in form, but any
        // relative link within it stays relative).
        return value;
      } else if (Array.isArray(value)) {
        // Copy on write, here and in the object branch below: a container
        // whose members all come back by identity is returned by identity
        // too, so the encoder that reads the result gets the caller's own
        // containers. A value carrying no link anywhere within it comes
        // through this walk without an allocation.
        let next: FabricValue[] | undefined;
        for (let index = 0; index < value.length; index++) {
          if (!(index in value)) continue;
          const current = value[index];
          const rewritten = traverseAndAddBaseIdToRelativeLinks(current, seen);
          if (next) {
            next[index] = rewritten;
          } else if (!Object.is(rewritten, current)) {
            next = value.slice();
            next[index] = rewritten;
          }
        }
        return next ?? value;
      } else { // not an array
        let next: Record<string, FabricValue> | undefined;
        for (const [key, entry] of Object.entries(value)) {
          const rewritten = traverseAndAddBaseIdToRelativeLinks(entry, seen);
          if (next) {
            next[key] = rewritten;
          } else if (!Object.is(rewritten, entry)) {
            next = { ...value };
            next[key] = rewritten;
          }
        }
        return next ?? value;
      }
    } finally {
      seen.delete(value);
    }
  }

  // Links serialized into a `data:` document carry their schemas inline
  // (see inlineExternalSchemaRefsInValue): the document is its id, so a
  // content-addressed reference inside it has no carrying write to install
  // its closure.
  return dataUriFromValue(
    inlineExternalSchemaRefsInValue(
      traverseAndAddBaseIdToRelativeLinks(data, new Set()),
    ),
  );
}

/**
 * Find any data: URI links and inline them.
 *
 * Only this codec's media type is inlined, the one
 * {@link dataUriFromValue} mints. A link naming a `data:` URI of any other
 * media type is returned as it came in, on the same footing as a link
 * naming a document in a space.
 *
 * A `FabricPrimitive` comes back as the same instance: a leaf holds no link to
 * inline. Other instances are refused by default. The runtime can opt into
 * canonical conversion of link-free instance state.
 *
 * @param value - The value to find and inline data: URI links in.
 * @param resolveDataUriLink - Optional live-carrier resolver, called before a
 *   data URI is decoded. Its returned value retains runtime-owned provenance.
 * @param allowLinkFreeFabricInstances Whether to preserve canonically converted
 *   instances whose codec state contains no references.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataUriLinks(
  value: any,
  resolveDataUriLink?: (link: CellLink) => { value: FabricValue } | undefined,
  allowLinkFreeFabricInstances = false,
): any {
  if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id !== undefined && isFabricDataUri(dataLink.id)) {
      const resolved = resolveDataUriLink?.(value);
      if (resolved !== undefined) {
        return findAndInlineDataUriLinks(
          resolved.value,
          resolveDataUriLink,
          allowLinkFreeFabricInstances,
        );
      }
      let dataValue: any = valueFromDataUri(dataLink.id);
      const path = [...dataLink.path];

      // If there is a link on the way to `path`, follow it, appending remaining
      // path to the target link.
      while (dataValue !== undefined) {
        if (isPrimitiveCellLink(dataValue)) {
          // Parse the link found in the data URI
          // Do NOT pass parsedLink as base to avoid inheriting the data: URI id
          const newLink = parseLink(dataValue);
          let schema = newLink.schema;
          if (schema !== undefined && path.length > 0) {
            schema = ContextualFlowControl.getSchemaAtPath(schema, path);
          }
          // Create new link by merging dataLink with remaining path
          const newSigilLink = createSigilLinkFromParsedLink({
            // Start with values from the original data link
            ...dataLink,

            // overwrite with values from the new link
            ...newLink,

            // extend path with remaining segments
            path: [...newLink.path, ...path],

            // use resolved schema if we have one
            ...(schema !== undefined && { schema }),
          }, {
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          });
          return findAndInlineDataUriLinks(
            newSigilLink,
            resolveDataUriLink,
            allowLinkFreeFabricInstances,
          );
        }
        if (path.length > 0) {
          // TODO(danfuzz): a path segment naming something inside a
          // `FabricInstance` indexes it by property name and yields
          // `undefined`, because an instance's contents are reachable only
          // through its codec. A `FabricPrimitive` needs nothing here: it is a
          // leaf, so no path can legitimately point inside one.
          dataValue = dataValue[path.shift()!];
        } else {
          break;
        }
      }

      // The decoded payload gets the same dispatch the walk applies anywhere
      // else. Without it the refusal below has a bypass: an instance handed
      // over directly is refused, while the same one decoded out of a `data:`
      // URI leaves silently, and a guard with a way around it is worse than no
      // guard, since it reads as covering the case.
      //
      // Only the payload itself is checked, because a decoded payload is
      // returned rather than walked -- nothing here descends one, so there is
      // no descent for a nested instance to be caught by.
      if (dataValue instanceof FabricInstance) {
        if (allowLinkFreeFabricInstances) {
          return convertCellsToLinks(dataValue, {
            allowLinkFreeFabricInstances: true,
          });
        }
        refuseFabricInstance(
          dataValue,
          "when inlining a `data:` URI whose content is a `FabricInstance`",
        );
      }

      return dataValue;
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    let next: any[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const current = value[index];
      const inlined = findAndInlineDataUriLinks(
        current,
        resolveDataUriLink,
        allowLinkFreeFabricInstances,
      );
      if (next) {
        next[index] = inlined;
      } else if (!Object.is(inlined, current)) {
        // `Object.is`: an untouched `NaN` leaf comes back as the same value
        // and must not force a clone of the whole array.
        next = value.slice();
        next[index] = inlined;
      }
    }
    return next ?? value;
  } else if (value instanceof FabricPrimitive) {
    // A leaf, and `isObjectOrArray`, so it leaves ahead of the record branch below.
    // It holds no link to inline, so returning it whole is the answer rather
    // than an omission.
    return value;
  } else if (value instanceof FabricInstance) {
    if (allowLinkFreeFabricInstances) {
      return convertCellsToLinks(value, { allowLinkFreeFabricInstances: true });
    }
    refuseFabricInstance(value, "when inlining `data:` URI links");
  } else if (isObjectOrArray(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataUriLinks(
        entry,
        resolveDataUriLink,
        allowLinkFreeFabricInstances,
      );
      if (next) {
        next[key] = inlined;
      } else if (!Object.is(inlined, entry)) {
        // `Object.is`: see the array case above.
        next = { ...value };
        next[key] = inlined;
      }
    }
    return next ?? value;
  } else {
    return value;
  }
}
