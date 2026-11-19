/**
 * What a space's commit log holds in `original` for an admitted client commit,
 * and how a resubmission is matched against it (03-commit-model.md §3.7.4).
 * The log holds a commit as submitted, except that an engine opened to store
 * digests replaces a read set nothing consults after admission with a digest
 * of the whole submission (02-storage.md §3.3). The reads decide the commit's
 * own admission; afterward a resubmission's identity check is the one reader
 * left, and the digest serves it.
 */

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";

import { type ClientCommit, encodeMemoryBoundary } from "../v2.ts";

/** What stands in a stored commit for a read set the log does not keep. */
export type CommitDigest = {
  /**
   * SHA-256 of the whole submitted commit's boundary encoding, reads and
   * every other member included, as unpadded base64url.
   */
  sha256: string;

  /** The UTF-8 byte length of that encoding. */
  bytes: number;

  /** How many confirmed reads the commit carried. */
  confirmed: number;

  /** How many pending reads the commit carried. */
  pending: number;
};

/**
 * A client commit as the log holds it: with its `reads`, or with a `digest` in
 * their place.
 */
export type StoredClientCommit = Omit<ClientCommit, "reads"> & {
  reads?: ClientCommit["reads"];
  digest?: CommitDigest;
};

const utf8 = new TextEncoder();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `commit` carries a read set of the shape admission requires. */
const hasReadSet = (commit: ClientCommit): boolean =>
  isObject(commit.reads) && Array.isArray(commit.reads.confirmed) &&
  Array.isArray(commit.reads.pending);

const carriesReads = (commit: ClientCommit): boolean =>
  commit.reads.confirmed.length > 0 || commit.reads.pending.length > 0;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Unpadded base64url of 32 bytes. */
const SHA256_TEXT = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether `digest` has the shape {@link digestForm} writes: a SHA-256, the
 * encoding's byte length, and the commit's read counts. The engine writes a
 * digest only for a commit that carried reads, so counts that are both zero
 * mark a digest it did not write.
 */
const isCommitDigest = (digest: unknown): digest is CommitDigest =>
  isObject(digest) &&
  typeof digest.sha256 === "string" && SHA256_TEXT.test(digest.sha256) &&
  isCount(digest.bytes) && digest.bytes > 0 &&
  isCount(digest.confirmed) && isCount(digest.pending) &&
  digest.confirmed + digest.pending > 0;

/**
 * The digest form of `commit`, whose whole encoding is `whole`: every member
 * but `reads`, and a `digest` of the whole submission. A `digest` member the
 * client submitted is replaced here, but the digest covers it.
 */
const digestForm = (commit: ClientCommit, whole: string): string => {
  const { reads, ...rest } = commit;
  const bytes = utf8.encode(whole);
  const digest: CommitDigest = {
    sha256: toUnpaddedBase64url(sha256(bytes)),
    bytes: bytes.length,
    confirmed: reads.confirmed.length,
    pending: reads.pending.length,
  };
  return encodeMemoryBoundary({ ...rest, digest });
};

/**
 * Returns the text the log stores for `commit`, an admitted commit. Unless
 * `keepReads` is true, a commit that carries reads is stored in digest form. A
 * commit that carries none is stored as submitted either way, since a digest
 * would save nothing.
 */
export const encodeStoredCommit = (
  commit: ClientCommit,
  keepReads: boolean,
): string => {
  const whole = encodeMemoryBoundary(commit);
  return keepReads || !carriesReads(commit) ? whole : digestForm(commit, whole);
};

/**
 * Returns whether `stored`, a commit row's `original`, holds `incoming` in
 * either of the forms {@link encodeStoredCommit} writes. Both forms determine
 * the whole submission: the first is its encoding, and the second carries
 * that encoding's SHA-256. A resubmission without a well-formed read set
 * matches neither, since no admitted commit lacked one.
 */
export const storesCommit = (
  stored: string,
  incoming: ClientCommit,
): boolean => {
  if (!hasReadSet(incoming)) return false;
  const whole = encodeMemoryBoundary(incoming);
  return stored === whole ||
    (carriesReads(incoming) && stored === digestForm(incoming, whole));
};

/** How many reads a stored commit records, and whether it keeps them. */
export type StoredReadCounts = {
  confirmed: number;
  pending: number;

  /** False for a commit whose reads the log holds only as a digest. */
  kept: boolean;
};

/**
 * Returns the read counts `stored`, a decoded commit row's `original`, records:
 * from its read set when it keeps one, from its digest when it holds that in
 * place of its reads, and `undefined` for any other payload, such as a
 * compaction marker or a digest of a shape the engine does not write.
 */
export const storedReadCounts = (
  stored: unknown,
): StoredReadCounts | undefined => {
  if (!isObject(stored)) return undefined;
  const { reads, digest } = stored;
  if (isObject(reads)) {
    return {
      confirmed: Array.isArray(reads.confirmed) ? reads.confirmed.length : 0,
      pending: Array.isArray(reads.pending) ? reads.pending.length : 0,
      kept: true,
    };
  }
  if (reads === undefined && isCommitDigest(digest)) {
    return {
      confirmed: digest.confirmed,
      pending: digest.pending,
      kept: false,
    };
  }
  return undefined;
};
