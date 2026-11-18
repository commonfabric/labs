/**
 * What a space's commit log holds in `original` for an admitted client commit,
 * and how a resubmission is matched against it (03-commit-model.md §3.7.4).
 * The log holds a commit as submitted, except that a read set nothing consults
 * after admission is replaced by its digest. The reads decide the commit's own
 * admission; afterward a resubmission's identity check is the one reader
 * left, and the digest serves it.
 */

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";

import { type ClientCommit, encodeMemoryBoundary } from "../v2.ts";

/** What stands in a stored commit for a read set the log does not keep. */
export type ReadsDigest = {
  /** SHA-256 of the read set's boundary encoding, as unpadded base64url. */
  hash: string;

  /** How many confirmed reads the commit carried. */
  confirmed: number;

  /** How many pending reads the commit carried. */
  pending: number;
};

/**
 * A client commit as the log holds it: with its `reads`, or with a
 * `readsDigest` in their place.
 */
export type StoredClientCommit = Omit<ClientCommit, "reads"> & {
  reads?: ClientCommit["reads"];
  readsDigest?: ReadsDigest;
};

const utf8 = new TextEncoder();

/** Returns the digest that stands for `reads` in a stored commit. */
export const readsDigestOf = (reads: ClientCommit["reads"]): ReadsDigest => ({
  hash: toUnpaddedBase64url(sha256(utf8.encode(encodeMemoryBoundary(reads)))),
  confirmed: reads.confirmed.length,
  pending: reads.pending.length,
});

const carriesReads = (commit: ClientCommit): boolean =>
  commit.reads.confirmed.length > 0 || commit.reads.pending.length > 0;

/**
 * Returns the text the log stores for `commit`. Unless `keepReads` is true, a
 * commit that carries reads is stored with a `readsDigest` in their place. A
 * commit that carries none is stored as submitted either way, since a digest
 * would save nothing.
 */
export const encodeStoredCommit = (
  commit: ClientCommit,
  keepReads: boolean,
): string => {
  if (keepReads || !carriesReads(commit)) return encodeMemoryBoundary(commit);
  const { reads, ...rest } = commit;
  return encodeMemoryBoundary({ ...rest, readsDigest: readsDigestOf(reads) });
};

/**
 * Returns whether `stored`, a commit row's `original`, holds `incoming` in
 * either of the forms {@link encodeStoredCommit} writes. Every member but the
 * reads compares byte for byte; reads the log does not keep compare by digest.
 */
export const storesCommit = (
  stored: string,
  incoming: ClientCommit,
): boolean =>
  stored === encodeStoredCommit(incoming, true) ||
  (carriesReads(incoming) && stored === encodeStoredCommit(incoming, false));
