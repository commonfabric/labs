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
import { readStoredValueText, type ValueCell } from "./value-store.ts";

/** The id of a space's ACL document: the one `of:did:…` id a store holds. */
export const ACL_ID_PATTERN = "of:did:%";

/**
 * The ids {@link ACL_ID_PATTERN} matches, as ranges the primary key serves:
 * `LIKE` ignores the case of ASCII letters, so one range per spelling of
 * `of:did:` in either case, each from that spelling up to, not including, the
 * spelling with its final `:` replaced by `;`, the character after it. Sorted,
 * so that the rows of successive ranges come in id order.
 */
const ACL_ID_RANGES: ReadonlyArray<readonly [string, string]> = (() => {
  const prefix = ACL_ID_PATTERN.slice(0, -1);
  let spellings = [""];
  for (const char of prefix) {
    const cases = new Set([char.toLowerCase(), char.toUpperCase()]);
    spellings = spellings.flatMap((head) =>
      [...cases].map((variant) => head + variant)
    );
  }
  return spellings.sort().map((low) => [low, low.slice(0, -1) + ";"] as const);
})();

/** The head of an `of:did:…` document, joined to the revision it names. */
export type AclHead = {
  /** The document's id. */
  id: string;

  /** The seq of the revision the head names. */
  seq: number;

  /** That revision's op. */
  op: string;

  /** That revision's stored payload as text, or `null` when it holds none. */
  data: string | null;
};

/**
 * The heads of the `of:did:…` documents in `db`'s store, on the default branch
 * and in the space scope, each payload read as text whichever form the store
 * holds it in. The op is the revision's, which every store's `revision` table
 * has: a store from before the current-op migration has a `head` without one.
 */
export const readAclHeads = (db: Database): AclHead[] => {
  const select = db.prepare(
    `SELECT h.id, h.seq, r.op, r.data FROM head h
     JOIN revision r ON r.branch = h.branch AND r.id = h.id
       AND r.scope_key = h.scope_key AND r.seq = h.seq
       AND r.op_index = h.op_index
     WHERE h.branch = '' AND h.scope_key = 'space'
       AND h.id >= ? AND h.id < ?
     ORDER BY h.id`,
  );
  try {
    return ACL_ID_RANGES.flatMap(([low, high]) =>
      select.all<Omit<AclHead, "data"> & { data: ValueCell }>(low, high)
    ).map((head) => ({ ...head, data: readStoredValueText(db, head.data) }));
  } finally {
    select.finalize();
  }
};

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
