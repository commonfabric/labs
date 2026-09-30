/** Resolves and orders collection keys using runtime Cell identity. */

import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";

import { type Cell, isCell } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import { UnresolvedInputError } from "../schema-view.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { resolveCellReference } from "./resolve-cell-reference.ts";
import { cellIdentityKey } from "./scope-policy.ts";

/** A typed routing key, suitable for inclusion in an owning index's cause. */
export type CollectionKeyIdentity =
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "cell"; value: string };

/** Public key and its routing identity, resolved in the caller's transaction. */
export interface ResolvedCollectionKey {
  key: string | number | boolean | Cell<unknown>;
  identity: CollectionKeyIdentity;
}

/** Resolves Cell identity and rejects values outside the collection-key domain. */
export function resolveCollectionKey(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  value: unknown,
): ResolvedCollectionKey | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") {
    return { key: value, identity: { kind: "boolean", value } };
  }
  if (typeof value === "string") {
    return { key: value, identity: { kind: "string", value } };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const key = value === 0 ? 0 : value;
    return { key, identity: { kind: "number", value: key } };
  }
  if (isCell(value)) {
    const reference = value.withTx(tx);
    const link = resolveLink(runtime, tx, reference.getAsNormalizedFullLink());
    if (link.pendingHopDoc) {
      tx.readValueOrThrow(link);
      const refusal = new UnresolvedInputError(link);
      tx.noteSchemaRefusal(refusal);
      throw refusal;
    }
    const key = resolveCellReference(runtime, tx, reference);
    return {
      key,
      identity: { kind: "cell", value: cellIdentityKey(key).dedupKey },
    };
  }
  throw new Error(
    "Collection keys must be strings, finite numbers, booleans, or Cells.",
  );
}

const keyDomainOrder = { boolean: 0, number: 1, string: 2, cell: 3 } as const;

/** Orders occupied keys independently of insertion order and source position. */
export function compareCollectionKeys(
  left: CollectionKeyIdentity,
  right: CollectionKeyIdentity,
): number {
  if (left.kind !== right.kind) {
    return keyDomainOrder[left.kind] - keyDomainOrder[right.kind];
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    return Number(left.value) - Number(right.value);
  }
  if (left.kind === "number" && right.kind === "number") {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  return utf8Compare(String(left.value), String(right.value));
}

/** Names a bucket within its owning index without exposing raw keys as paths. */
export function collectionKeyBucket(identity: CollectionKeyIdentity): string {
  return hashStringOf(identity);
}
