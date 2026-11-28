/**
 * What the store admits of a piece's creator record, the `creator` member a
 * runtime writes on a piece's result document beside `value` and `cfc`.
 *
 * The record names the principal the piece was created for, and commit
 * preparation reads it as an authority: a piece's reclassification releases
 * that principal's own `User` clauses, and a field a source update adds binds
 * them as its owner. Commit preparation admits the record only from the
 * runtime's own setup, but a client that skips its runtime's write path can
 * hand the store any record, and a record naming another principal releases
 * that principal's data wherever an honest runtime later runs the piece. So
 * the store holds a session's commit to the one record it can judge: the
 * principal the session authenticated.
 *
 * A commit a session makes may leave a document's record as it found it, or
 * record one where none was stored when it names the session's principal. It
 * may not change or remove a stored record, except by deleting the document.
 * Every session's commit is judged alike, a session of the deployment's own
 * service or delegating identity included. The commits the server makes
 * itself are not judged (`derived`, `system`, and delegated ones): a serving
 * runtime's writes reach the store as its wave's `derived` commit, and its
 * commit preparation admitted a record that may name a run's actor or the
 * creator of the piece whose run placed a child.
 *
 * This is a stopgap: it keeps a client from forging another principal's
 * record, and does not make the record trustworthy on its own. Ways around it
 * remain (`patterns/dev/test/share-space-declassify/PROPOSAL.md`, Risks), and
 * a record bound into the piece's identity would close them as a class.
 */

// SPEC-PENDING https://github.com/commonfabric/specs/pull/87 The ruling has
// the runtime refuse a record its own setup did not make, and names the
// parent's creator for a child; the store rule here also refuses a session's
// record naming anyone but its principal. It refuses more than the ruling does
// and stores nothing new. A runtime on a client, behind the default-off
// `pieceCreatorRecord`, then records none where the ruling records another
// principal (`#setupInternal` in the runner). The ruling that states both is
// drafted to stack on that pull request.

import { type FabricValue, valueEqual } from "@commonfabric/data-model";

/** The member of a stored document that holds a piece's creator record. */
export const CREATOR_RECORD_MEMBER = "creator";

/**
 * Why a session's commit may not leave a document with the creator record
 * `proposed` where it stores `stored`, or `undefined` when it may. Each is the
 * document's `creator` member, `undefined` where the document holds none.
 * `principals` are the principals the session authenticated as: the key that
 * signed it, and the root issuer of the proof chain it presented, if any. A
 * session naming none records no creator.
 */
export const creatorRecordRefusal = (
  stored: unknown,
  proposed: unknown,
  principals: readonly string[],
): string | undefined => {
  if (stored === undefined) {
    if (proposed === undefined) return undefined;
    return typeof proposed === "string" && principals.includes(proposed)
      ? undefined
      : "a session records only its own principal as a piece's creator";
  }
  return proposed !== undefined &&
      valueEqual(proposed as FabricValue, stored as FabricValue)
    ? undefined
    : "a piece records its creator once";
};
