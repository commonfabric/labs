/**
 * Value reads that propagate an unavailable ancestor without changing the
 * logical target of the read or the transaction's read-policy checks.
 */
import { isUnavailable } from "@commonfabric/data-model/availability";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { normalizeCellScope } from "../scope.ts";
import { transactionLayers } from "./reactivity-log.ts";

import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "./interface.ts";

type UnavailableReadObservation = {
  readonly address: IMemorySpaceAddress;
  readonly scopeKey: string;
};

const unavailableReads = new WeakMap<object, UnavailableReadObservation[]>();

/** The scope instance a diagnostic read belongs to, when its identity is known. */
export function availabilityReadScopeKey(
  tx: object,
  address: IMemorySpaceAddress,
): string | undefined {
  if (address.scopeKey !== undefined) return address.scopeKey;
  const scope = normalizeCellScope(address.scope);
  if (scope === "space") return "space";
  for (const layer of transactionLayers(tx)) {
    const identity = (layer as { scopeKeyIdentity?: ScopeKeyIdentity })
      .scopeKeyIdentity;
    if (identity !== undefined && typeof identity !== "function") {
      return resolveScopeKey(scope, identity);
    }
  }
  return undefined;
}

/** Records an actual coverage miss, which has no successful read invariant. */
export function recordUnavailableRead(
  tx: object,
  address: IMemorySpaceAddress,
): void {
  const scopeKey = availabilityReadScopeKey(tx, address);
  if (scopeKey === undefined) return;
  const layers = [...transactionLayers(tx)];
  const observations = layers.map((layer) => unavailableReads.get(layer))
    .find((value) => value !== undefined) ?? [];
  observations.push({
    address: { ...address, path: [...address.path] },
    scopeKey,
  });
  for (const layer of layers) unavailableReads.set(layer, observations);
}

/** Failed readiness observations retained for comparisons after commit. */
export function unavailableReadObservations(
  tx: object,
): readonly UnavailableReadObservation[] {
  for (const layer of transactionLayers(tx)) {
    const observations = unavailableReads.get(layer);
    if (observations !== undefined) return observations;
  }
  return [];
}

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
