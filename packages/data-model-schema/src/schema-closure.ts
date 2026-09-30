/**
 * The walk over the `$ref` closure of content-addressed schema documents:
 * from a set of root hashes, through every document a verified document
 * references, to the transitive closure. Every layer that handles the
 * closure walks it the same way — the storage engine at commit, result
 * assembly, the client's traversal and replica, the transaction that stages
 * a closure — and differs only in where its documents come from and in what
 * a miss means. This module owns the walk, the dedupe, and the identity
 * check that a document is the schema its id names; a caller supplies the
 * rest through {@link SchemaClosureWalk}.
 *
 * The design is `docs/specs/content-addressed-schemas.md`. Nothing here
 * reads storage: the loader a caller passes is the only route to a document.
 */

import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "./schema-intern.ts";
import { collectExternalSchemaRefHashes } from "./schema-refs.ts";
import { isSubschema } from "./schema-walk.ts";

/**
 * What a loader returns for one hash: the source the caller resolved it
 * from, in the caller's own terms.
 */
export type SchemaClosureSource =
  /**
   * The value stored under `cid:<hash>` — a document's `.value` — which
   * the walk verifies against the hash before following its references.
   */
  | { readonly kind: "stored"; readonly value: unknown }
  /**
   * A schema the caller already holds verified as the document the hash
   * names — from a registry, or a cache keyed by the document's version.
   * The walk follows its references without re-verifying it.
   */
  | { readonly kind: "verified"; readonly schema: JSONSchema }
  /**
   * A hash the caller has settled for itself: it holds the document and
   * everything behind it, so the walk neither verifies nor follows it, and
   * it is neither verified nor missing in the result. A closure staged in
   * an earlier pass, or one the server is known to hold, is settled.
   */
  | { readonly kind: "settled" };

/** Why a hash contributed no document to the closure. */
export type SchemaClosureMiss =
  /** The loader found no value under the hash. */
  | "absent"
  /**
   * The loader found a value that is not the schema document its id names:
   * not schema-shaped, or hashing to something other than the hash.
   */
  | "mismatch";

/** The walk's route to further hashes, offered to every callback. */
export interface SchemaClosureFollow {
  /**
   * Adds `hash` to the walk. A hash already visited is ignored. A caller
   * reaches for this when loading a document surfaces an obligation the
   * document's own `$ref`s do not carry, such as the reference in a
   * non-schema document's metadata member.
   */
  follow(hash: string): void;
}

/** One walk: its roots, its document source, and what each outcome does. */
export interface SchemaClosureWalk {
  /** The hashes to start from. */
  readonly roots: Iterable<string>;

  /**
   * Resolves one hash to its source, or `undefined` when the caller holds
   * nothing under it. Called at most once per hash.
   */
  load(
    hash: string,
    walk: SchemaClosureFollow,
  ): SchemaClosureSource | undefined;

  /**
   * Called once for each hash whose document verified, with the interned
   * schema, before that schema's own references are followed.
   */
  onVerified?(
    hash: string,
    schema: JSONSchema,
    walk: SchemaClosureFollow,
  ): void;

  /**
   * Called once for each hash that contributed no document, with why. The
   * walk continues past a miss; a caller that cannot continue throws here.
   */
  onMissing?(
    hash: string,
    miss: SchemaClosureMiss,
    walk: SchemaClosureFollow,
  ): void;
}

/** What a walk found. */
export interface SchemaClosureResult {
  /** Every hash whose document verified in this walk. */
  readonly verified: ReadonlySet<string>;

  /** Every hash that contributed no document, with why. */
  readonly missing: ReadonlyMap<string, SchemaClosureMiss>;
}

/**
 * The interned schema document `hash` names, when `value` is that document:
 * schema-shaped, and interning to exactly `hash`. `undefined` otherwise.
 * Interning deep-freezes a mutable `value` in place, as `internSchema()`
 * does. This is the one identity check for a `cid:` schema document, and
 * every walk applies it to a stored value; a caller with a value in hand and
 * no closure to walk applies it directly.
 */
export function verifySchemaDocument(
  hash: string,
  value: unknown,
): JSONSchema | undefined {
  if (!isSubschema(value)) return undefined;
  const sah = internSchema(value, true);
  if (sah.taggedHashString !== hash) return undefined;
  return sah.schemaOrUndefined as JSONSchema;
}

/**
 * Walks the closure `walk` describes: each hash is loaded once, a stored
 * value is verified with {@link verifySchemaDocument}, and the references a
 * verified schema carries are followed, depth-first, until nothing is left.
 * Returns what verified and what did not. A callback that throws ends the
 * walk with that error.
 */
export function walkSchemaDocumentClosure(
  walk: SchemaClosureWalk,
): SchemaClosureResult {
  const pending = [...walk.roots];
  const seen = new Set<string>();
  const verified = new Set<string>();
  const missing = new Map<string, SchemaClosureMiss>();
  const follow: SchemaClosureFollow = {
    follow(hash) {
      if (!seen.has(hash)) pending.push(hash);
    },
  };
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const source = walk.load(hash, follow);
    if (source === undefined) {
      missing.set(hash, "absent");
      walk.onMissing?.(hash, "absent", follow);
      continue;
    }
    if (source.kind === "settled") continue;
    const schema = source.kind === "verified"
      ? source.schema
      : verifySchemaDocument(hash, source.value);
    if (schema === undefined) {
      missing.set(hash, "mismatch");
      walk.onMissing?.(hash, "mismatch", follow);
      continue;
    }
    verified.add(hash);
    walk.onVerified?.(hash, schema, follow);
    for (const dep of collectExternalSchemaRefHashes(schema)) {
      follow.follow(dep);
    }
  }
  return { verified, missing };
}
