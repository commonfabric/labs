/**
 * Records server-confirmed identity writes on their source transaction so
 * post-commit observers can distinguish agreement from a durable overwrite.
 * Operation indexes refer to the commit sent over the wire, after local
 * session writes have been removed.
 *
 * Partial-elision handling is defensive for ordinary documents: their identity
 * commits elide every operation. Individual elision is reserved for `cid:` sets
 * identical to stored content (03-commit-model.md §3.6.1).
 */

import {
  type ClientCommit,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import type { IStorageTransaction, MemorySpace } from "./interface.ts";

const elisions = new WeakMap<
  IStorageTransaction,
  Map<MemorySpace, Map<ScopeKey, Map<string, boolean>>>
>();

/**
 * Records which documents had every operation elided by the accepting server.
 * Partial elision or absent verdict details prove no agreement. Non-document
 * operations retain their wire indexes.
 */
export function recordCommitElisions(
  source: IStorageTransaction,
  space: MemorySpace,
  operations: ClientCommit["operations"],
  elidedOpIndexes: readonly number[] | undefined,
  identity: ScopeKeyIdentity,
): void {
  if (!elidedOpIndexes?.length) return;
  const indexes = new Set(elidedOpIndexes);
  const byScope = new Map<ScopeKey, Map<string, boolean>>();
  for (const [index, operation] of operations.entries()) {
    if (!("id" in operation)) continue;
    const scopeKey = resolveScopeKey(operation.scope, identity);
    let documents = byScope.get(scopeKey);
    if (documents === undefined) {
      documents = new Map();
      byScope.set(scopeKey, documents);
    }
    documents.set(
      operation.id,
      (documents.get(operation.id) ?? true) && indexes.has(index),
    );
  }
  let bySpace = elisions.get(source);
  if (bySpace === undefined) {
    bySpace = new Map();
    elisions.set(source, bySpace);
  }
  bySpace.set(space, byScope);
}

/** Returns whether the server elided every write to this document instance. */
export function wasCommitWriteElided(
  source: IStorageTransaction | undefined,
  document: { space: MemorySpace; id: string; scopeKey: ScopeKey },
): boolean {
  if (source === undefined) return false;
  return elisions.get(source)?.get(document.space)?.get(document.scopeKey)?.get(
    document.id,
  ) === true;
}
