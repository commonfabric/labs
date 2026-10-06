/**
 * The schema-document registry: the strong, realm-lifetime index from a
 * schema document's tagged hash to its interned schema, backing `cid:`
 * `$ref` resolution (`docs/specs/content-addressed-schemas.md`).
 *
 * The registry is module-level rather than per-runtime because resolution
 * happens in pure schema code with no runtime handle, and because content
 * addressing makes realm-wide sharing safe: registration verifies every
 * document's content against its claimed hash, so an entry can only ever be
 * the one value its key names, whoever registered it.
 *
 * Retention is session-scoped through leases: every `StorageManager`
 * acquires one for its lifetime, and when the last lease in the realm
 * releases, the registry clears. Entries are therefore strong while any
 * session lives — a `cid:` ref in a link or selector must resolve for as
 * long as a session can read it, which the schema intern table's `WeakRef`s
 * cannot promise — and bounded by the distinct schema documents the live
 * sessions have seen, strictly less than the duplicated inline copies they
 * replace. Concurrent sessions share retention (the union of overlapping
 * lifetimes). A realm that never holds a lease — the memory server
 * registers through traversal without one — retains for the process
 * lifetime; its entries are a cache over its own store, so a future size
 * cap is safe there (an evicted document is one local read away).
 */

import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import { walkSchemaDocumentClosure } from "@commonfabric/data-model-schema/schema-closure";

/** Thrown when a document's content does not hash to its claimed id. */
export class SchemaDocumentHashMismatchError extends Error {
  constructor(readonly claimed: string, readonly actual: string) {
    super(
      `Schema document content does not match its id: claimed \`${claimed}\`, hashed \`${actual}\``,
    );
    this.name = "SchemaDocumentHashMismatchError";
  }
}

const documentsByHash = new Map<string, JSONSchema>();

// Listeners invoked when the registry clears (last lease out). Modules that
// memoize resolution SUCCESSES by schema identity register here to drop
// those caches in the same moment: a success cached in one lease epoch
// would otherwise keep resolving in the next, after the availability it
// proved is gone. Content addressing means such an entry could never hold a
// WRONG value — this is about not outliving the epoch's availability.
const clearListeners = new Set<() => void>();

/** Registers a callback for the registry-clear transition. */
export function onSchemaRegistryClear(listener: () => void): void {
  clearListeners.add(listener);
}

let activeLeases = 0;

let clears = 0;

/**
 * The registry's current epoch: how many times it has cleared in this realm.
 * A value holding `cid:` references minted from the registry — a compiled
 * pattern's serialized graph, for one — is usable only in the epoch that
 * minted them, so a cache of such values records this number and serves an
 * entry only while it is unchanged.
 */
export function schemaRegistryEpoch(): number {
  return clears;
}

/**
 * Acquires a retention lease on the registry, returning its release. Every
 * `StorageManager` holds one for its lifetime; when the last lease in the
 * realm releases, the registry clears — that transition is what gives
 * clients session-lifetime retention and tests a clean registry between
 * cases. Releasing is idempotent, so a manager closed twice releases once.
 *
 * Registration without a lease is allowed (the memory server registers
 * through traversal without one) and retains until the NEXT
 * last-lease-out transition, or for the process lifetime in a realm that
 * never holds a lease.
 */
export function acquireSchemaRegistryLease(): () => void {
  activeLeases++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLeases--;
    if (activeLeases === 0) {
      clears++;
      documentsByHash.clear();
      completeClosures.clear();
      for (const listener of clearListeners) listener();
    }
  };
}

/**
 * Registers a schema document under its tagged hash, verifying the content
 * against the claim first — a mismatched document throws
 * {@link SchemaDocumentHashMismatchError} and never enters the registry.
 * Returns the interned schema. Re-registering a hash is idempotent by
 * construction: only one content can verify against it.
 *
 * The schema is interned, and interning deep-freezes a mutable input in
 * place — callers must be okay with that.
 */
export function registerSchemaDocument(
  taggedHash: string,
  schema: JSONSchema,
): JSONSchema {
  // Verify before the existing-entry check, so a mismatched registration is
  // surfaced even when a correct document already holds the key. Interning
  // memoizes by identity, so re-registering the same object stays cheap.
  const sah = internSchema(schema, true);
  if (sah.taggedHashString !== taggedHash) {
    throw new SchemaDocumentHashMismatchError(
      taggedHash,
      sah.taggedHashString,
    );
  }
  const existing = documentsByHash.get(taggedHash);
  if (existing !== undefined) return existing;
  const interned = sah.schemaOrUndefined as JSONSchema;
  documentsByHash.set(taggedHash, interned);
  return interned;
}

/**
 * The registered schema document for `taggedHash`, or `undefined` when none
 * has been registered. A miss is recoverable — the document may arrive by
 * sync later — which is why resolution failures over external refs are
 * never memoized (see `cfc/schema-refs.ts`).
 */
export function lookupSchemaDocument(
  taggedHash: string,
): JSONSchema | undefined {
  return documentsByHash.get(taggedHash);
}

// Hashes whose transitive closure is fully registered. Registration is
// monotonic and documents are immutable, so completeness is stable once
// true — memoizing `true` is safe, and an incomplete verdict is recomputed
// on the next ask.
const completeClosures = new Set<string>();

// Monotonic count of external-resolution misses: bumped whenever a `cid:`
// resolution fails because the document is unregistered or its closure is
// incomplete. Derived caches snapshot it around a derivation and memoize
// only when it did not move — the exact "computed over a hole" hazard, at
// the cost of two integer reads instead of a schema walk whose first call
// visits every dormant `$defs` body. Never reset: the comparison is
// equality of snapshots, and a registry clear only makes misses more
// likely, never less.
let externalResolutionMisses = 0;

/** Records a `cid:` resolution miss (see {@link externalResolutionMissCount}). */
export function noteExternalResolutionMiss(): void {
  externalResolutionMisses++;
}

/**
 * The monotonic external-resolution miss count. A computation that
 * snapshots this before running and observes the same value after ran
 * without any `cid:` resolution miss, so its result was not computed over
 * an absent schema document and is safe to memoize.
 */
export function externalResolutionMissCount(): number {
  return externalResolutionMisses;
}

/**
 * Whether `taggedHash`'s document and every document transitively reachable
 * from its external refs are registered. Resolution treats an incomplete
 * closure as a miss
 * (`cfc/schema-refs.ts`), so a derived result — an IFC scan, a standardized
 * form — is only ever computed over a schema whose whole closure is at
 * hand; a result cached before a child document arrived would otherwise
 * stay wrong forever.
 */
export function isSchemaDocumentClosureComplete(taggedHash: string): boolean {
  if (completeClosures.has(taggedHash)) return true;
  const { verified, missing } = walkSchemaDocumentClosure({
    roots: [taggedHash],
    load: (hash) => {
      if (completeClosures.has(hash)) return { kind: "settled" };
      const document = documentsByHash.get(hash);
      return document === undefined
        ? undefined
        : { kind: "verified", schema: document };
    },
  });
  if (missing.size > 0) return false;
  for (const hash of verified) completeClosures.add(hash);
  return true;
}
