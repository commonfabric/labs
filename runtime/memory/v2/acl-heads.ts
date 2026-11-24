/**
 * Reading a space's access-control document straight from its store: the
 * heads of the `of:did:…` documents on the default branch, and whether one
 * holds a deletion tombstone (INV-15). The engine, compaction, a reap and the
 * state inspector's summary read the document this way; a reap's verifier
 * reads it again on its own, as a second implementation.
 */

import type { Database } from "@db/sqlite";

import { type DeletionTombstone, isDeletionTombstone } from "../acl.ts";
import { decodeTrustedMemoryBoundary, type EntityDocument } from "../v2.ts";

/** The id of a space's ACL document: the one `of:did:…` id a store holds. */
export const ACL_ID_PATTERN = "of:did:%";

/** The head of an `of:did:…` document, joined to the revision it names. */
export type AclHead = {
  /** The document's id. */
  id: string;

  /** The seq of the revision the head names. */
  seq: number;

  /** That revision's op. */
  op: string;

  /** That revision's stored payload, or `null` when it holds none. */
  data: string | null;
};

/**
 * The heads of the `of:did:…` documents in `db`'s store, on the default branch
 * and in the space scope. The op is the revision's, which every store's
 * `revision` table has: a store from before the current-op migration has a
 * `head` without one.
 */
export const readAclHeads = (db: Database): AclHead[] =>
  db.prepare(
    `SELECT h.id, h.seq, r.op, r.data FROM head h
     JOIN revision r ON r.branch = h.branch AND r.id = h.id
       AND r.scope_key = h.scope_key AND r.seq = h.seq
       AND r.op_index = h.op_index
     WHERE h.branch = '' AND h.scope_key = 'space' AND h.id LIKE ?`,
  ).all<AclHead>(ACL_ID_PATTERN);

/**
 * The deletion tombstone `head` holds, or `undefined` when it holds none: when
 * it is not a `set`, holds no payload, or holds any other value. `decode`
 * reads the payload, the memory boundary's decoder by default.
 *
 * @throws whatever `decode` throws for a payload it cannot read.
 */
export const deletionTombstoneOf = (
  head: AclHead,
  decode: (data: string) => unknown = decodeTrustedMemoryBoundary,
): DeletionTombstone | undefined => {
  if (head.op !== "set" || head.data === null) return undefined;
  const value = (decode(head.data) as EntityDocument | null)?.value;
  return isDeletionTombstone(value) ? value : undefined;
};
