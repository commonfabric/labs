/** Fingerprints observed values without copying upstream data into a view plan. */

import {
  type FabricValue,
  hashStringOf,
  isDeepFrozen,
} from "@commonfabric/data-model";
import type { EntityDocument, ViewValueBasis } from "@commonfabric/memory/v2";

import { sortAndCompactPaths } from "./reactive-dependencies.ts";
import type { IMemorySpaceAddress } from "./storage/interface.ts";
import { toTransactionDocumentValue } from "./storage/v2-document.ts";
import { hasValueAtPath, readValueAtPath } from "./storage/v2-path.ts";

/** Includes reachable path depth, since a missing leaf can gain an ancestor. */
export function viewInputFingerprint(
  document: EntityDocument | undefined,
  path: readonly string[],
): string {
  return hashStringOf(observeViewInput(document, path));
}

function observeViewInput(
  document: EntityDocument | undefined,
  path: readonly string[],
): { depth: number; value: FabricValue | undefined } {
  const root = toTransactionDocumentValue(document);
  let depth = 0;
  while (
    depth < path.length &&
    hasValueAtPath(root, path.slice(0, depth + 1), { allowArrayLength: true })
  ) depth++;
  return {
    depth,
    value: readValueAtPath(root, path, { allowArrayLength: true }),
  };
}

/** Whole-value fingerprints cover every descendant of an observed path. */
export function viewInputBasis(
  addresses: IMemorySpaceAddress[],
  documentAt: (address: IMemorySpaceAddress) => EntityDocument | undefined,
): ViewValueBasis[] {
  return sortAndCompactPaths(addresses).map((address) => ({
    id: address.id,
    scope: address.scope ?? "space",
    path: [...address.path],
    fingerprint: viewInputFingerprint(documentAt(address), address.path),
  }));
}

/** Reuses a basis fingerprint only while its observed value is immutable. */
export class ViewInputBasisCache {
  #values = new WeakMap<ViewValueBasis, {
    depth: number;
    value: FabricValue | undefined;
    fingerprint: string;

    /** The document the value was observed in, when it is deep-frozen. */
    document?: EntityDocument;
  }>();

  /**
   * Reobserves path reachability and value on every currency check, except
   * in the deep-frozen document the basis was last observed in, which can
   * only observe the same again.
   */
  matches(
    document: EntityDocument | undefined,
    basis: ViewValueBasis,
  ): boolean {
    const previous = this.#values.get(basis);
    if (previous?.document !== undefined && previous.document === document) {
      return previous.fingerprint === basis.fingerprint;
    }
    const observed = observeViewInput(document, basis.path);
    const frozen = document !== undefined && isDeepFrozen(document)
      ? document
      : undefined;
    if (
      previous !== undefined && previous.depth === observed.depth &&
      Object.is(previous.value, observed.value)
    ) {
      if (frozen === undefined) delete previous.document;
      else previous.document = frozen;
      return previous.fingerprint === basis.fingerprint;
    }
    const fingerprint = hashStringOf(observed);
    if (isDeepFrozen(observed.value)) {
      this.#values.set(basis, {
        ...observed,
        fingerprint,
        ...(frozen !== undefined && { document: frozen }),
      });
    } else {
      this.#values.delete(basis);
    }
    return fingerprint === basis.fingerprint;
  }
}
