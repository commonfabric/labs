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

/**
 * Whole-value fingerprints cover every descendant of an observed path.
 * `fingerprintOf` takes the fingerprint of one document version at one path;
 * a caller that fingerprints the same versions over and over hands in one
 * that remembers them.
 */
export function viewInputBasis(
  addresses: IMemorySpaceAddress[],
  documentAt: (address: IMemorySpaceAddress) => EntityDocument | undefined,
  fingerprintOf: (
    document: EntityDocument | undefined,
    path: readonly string[],
  ) => string = viewInputFingerprint,
): ViewValueBasis[] {
  return viewInputBasisOf(
    sortAndCompactPaths(addresses),
    documentAt,
    fingerprintOf,
  );
}

/**
 * The basis of addresses already sorted and compacted, as `viewInputBasis`
 * sorts and compacts them, for a caller that keeps them so across bases.
 */
export function viewInputBasisOf(
  addresses: readonly IMemorySpaceAddress[],
  documentAt: (address: IMemorySpaceAddress) => EntityDocument | undefined,
  fingerprintOf: (
    document: EntityDocument | undefined,
    path: readonly string[],
  ) => string = viewInputFingerprint,
): ViewValueBasis[] {
  return addresses.map((address) => ({
    id: address.id,
    scope: address.scope ?? "space",
    path: [...address.path],
    fingerprint: fingerprintOf(documentAt(address), address.path),
  }));
}

/** Reuses a basis fingerprint only while its observed value is immutable. */
export class ViewInputBasisCache {
  #values = new WeakMap<ViewValueBasis, {
    depth: number;
    value: FabricValue | undefined;
    fingerprint: string;
  }>();

  /** Reobserves path reachability and value on every currency check. */
  matches(
    document: EntityDocument | undefined,
    basis: ViewValueBasis,
  ): boolean {
    const observed = observeViewInput(document, basis.path);
    const previous = this.#values.get(basis);
    if (
      previous !== undefined && previous.depth === observed.depth &&
      Object.is(previous.value, observed.value)
    ) {
      return previous.fingerprint === basis.fingerprint;
    }
    const fingerprint = hashStringOf(observed);
    if (isDeepFrozen(observed.value)) {
      this.#values.set(basis, { ...observed, fingerprint });
    } else {
      this.#values.delete(basis);
    }
    return fingerprint === basis.fingerprint;
  }
}
