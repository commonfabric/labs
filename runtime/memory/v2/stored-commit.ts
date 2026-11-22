/**
 * What a space's commit log holds in `original` for an admitted client commit,
 * and how a resubmission is matched against it (03-commit-model.md §3.7.4).
 * The log holds a commit as submitted, except for two members it can leave
 * out, with a digest of the whole submission in their place (02-storage.md
 * §3.3). One is a read set nothing consults after admission, on an engine
 * opened to store digests: the reads decide the commit's own admission, and
 * afterward a resubmission's identity check is the one reader left. The other
 * is the operations of a derived commit, which the `revision` table holds.
 * The digest serves the identity check for both.
 */

import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";

import {
  type ClientCommit,
  type CommitClass,
  encodeMemoryBoundary,
} from "../v2.ts";

/**
 * What stands in a stored commit for the members the log does not keep. It
 * records a count for each member it stands for, and no count for a member the
 * stored commit holds.
 */
export type CommitDigest = {
  /**
   * SHA-256 of the whole submitted commit's boundary encoding, reads,
   * operations and every other member included, as unpadded base64url.
   */
  sha256: string;

  /** The UTF-8 byte length of that encoding. */
  bytes: number;

  /**
   * How many confirmed reads the commit carried, recorded along with `pending`
   * when the stored commit holds no `reads`.
   */
  confirmed?: number;

  /** How many pending reads the commit carried. */
  pending?: number;

  /**
   * How many operations the commit carried, recorded when the stored commit
   * holds no `operations`.
   */
  operations?: number;
};

/** The members every stored form of a client commit holds, or may. */
type StoredCommitMembers = Omit<ClientCommit, "reads" | "operations"> & {
  reads?: ClientCommit["reads"];
  digest?: CommitDigest;
};

/** A stored client commit that holds a digest in place of its operations. */
type WithoutOperations = StoredCommitMembers & {
  operations?: undefined;
  digest: CommitDigest & { operations: number };
};

/**
 * A client commit as the log holds it: as submitted, or without its `reads`,
 * its `operations` or both, with a `digest` in their place.
 */
export type StoredClientCommit =
  | (StoredCommitMembers & { operations: ClientCommit["operations"] })
  | WithoutOperations;

/** Which of the two members a stored form may leave out it holds. */
export type KeptMembers = {
  /** Whether the stored form holds the commit's `reads`. */
  reads: boolean;

  /** Whether the stored form holds the commit's `operations`. */
  operations: boolean;
};

/** The columns of a commit row that decide which forms it may hold. */
export type StoredCommitRow = {
  /** The row's `original`. */
  readonly original: string;

  /** The class the commit was admitted under. */
  readonly class: string;

  /** The seq the commit was admitted at. */
  readonly seq: number;
};

/** The operations a revision records in full, one revision each. */
const REVISION_OPS: ReadonlySet<string> = new Set(["set", "patch", "delete"]);

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
 * Whether `digest` names a whole submission the way {@link digestForm} does:
 * by a SHA-256 and the encoding's byte length. The counts are left to the
 * reader of each member.
 */
const namesSubmission = (
  digest: unknown,
): digest is Record<string, unknown> & { sha256: string; bytes: number } =>
  isObject(digest) &&
  typeof digest.sha256 === "string" && SHA256_TEXT.test(digest.sha256) &&
  isCount(digest.bytes) && digest.bytes > 0;

/**
 * Returns whether `commit`, admitted under `commitClass` at `seq`, is stored
 * without its operations. Only a derived commit is: an authored commit's
 * payload is its client's reconnect identity. Seq 1 keeps its operations,
 * because the genesis receipt is read back whole. Every operation has to be a `set`, `patch` or
 * `delete`, each of which a revision records in full; the text of a `sqlite`
 * operation is stored nowhere else, and the tables for operation fields join
 * to the whole request.
 */
export const digestsOperations = (
  commit: ClientCommit,
  commitClass: CommitClass,
  seq: number,
): boolean =>
  commitClass === "derived" && seq !== 1 && commit.operations.length > 0 &&
  commit.operations.every((operation) => REVISION_OPS.has(operation.op));

/**
 * The stored form of `commit`, whose whole encoding is `whole`, that holds
 * the members `keeps` names: the commit as submitted when it holds both, and
 * otherwise every other member along with a `digest` of the whole submission.
 * A `digest` member the client submitted is replaced there, but the digest
 * covers it.
 */
const digestForm = (
  commit: ClientCommit,
  whole: string,
  keeps: KeptMembers,
): string => {
  if (keeps.reads && keeps.operations) return whole;
  const { reads, operations, ...rest } = commit;
  const bytes = utf8.encode(whole);
  const digest: CommitDigest = {
    sha256: toUnpaddedBase64url(sha256(bytes)),
    bytes: bytes.length,
    ...(keeps.reads ? {} : {
      confirmed: reads.confirmed.length,
      pending: reads.pending.length,
    }),
    ...(keeps.operations ? {} : { operations: operations.length }),
  };
  return encodeMemoryBoundary({
    ...rest,
    ...(keeps.reads ? { reads } : {}),
    ...(keeps.operations ? { operations } : {}),
    digest,
  });
};

/**
 * Returns the text the log stores for `commit`, an admitted commit, holding
 * the members `keeps` names. A commit that carries no reads is stored with its
 * empty read set whatever `keeps.reads` is, since a digest of it would save
 * nothing. `whole` is the encoding of `commit` that `encodeMemoryBoundary()`
 * returns, which a caller already holding it passes to spare a second
 * encoding. The digest is taken over `whole` as given, so a caller passing any
 * other text stores a digest no resubmission matches.
 */
export const encodeStoredCommit = (
  commit: ClientCommit,
  keeps: KeptMembers,
  whole: string = encodeMemoryBoundary(commit),
): string =>
  digestForm(commit, whole, {
    reads: keeps.reads || !carriesReads(commit),
    operations: keeps.operations,
  });

/**
 * Returns whether `row` holds `incoming` in any of the forms
 * {@link encodeStoredCommit} writes. Every form determines the whole
 * submission: one is its encoding, and the others carry that encoding's
 * SHA-256, so two commits share a form only when their encodings are equal or
 * collide under SHA-256 at equal length. A form without operations matches on
 * a derived row alone, and only where {@link digestsOperations} holds for
 * `incoming` at the row's seq. A resubmission without a well-formed read set
 * matches no form, since no admitted commit lacked one.
 */
export const storesCommit = (
  row: StoredCommitRow,
  incoming: ClientCommit,
): boolean => {
  if (!hasReadSet(incoming)) return false;
  const whole = encodeMemoryBoundary(incoming);
  if (row.original === whole) return true;
  const mayOmitReads = carriesReads(incoming);
  const mayOmitOperations = row.class === "derived" &&
    digestsOperations(incoming, "derived", row.seq);
  const holds = (keeps: KeptMembers): boolean =>
    row.original === digestForm(incoming, whole, keeps);
  return (mayOmitReads && holds({ reads: false, operations: true })) ||
    (mayOmitOperations && holds({ reads: true, operations: false })) ||
    (mayOmitReads && mayOmitOperations &&
      holds({ reads: false, operations: false }));
};

/** How many reads a stored commit records, and whether it keeps them. */
export type StoredReadCounts = {
  /** How many confirmed reads the commit carried. */
  confirmed: number;

  /** How many pending reads the commit carried. */
  pending: number;

  /** False for a commit whose reads the log holds only as a digest. */
  kept: boolean;
};

/**
 * Returns the read counts `stored`, a decoded commit row's `original`, records:
 * from its read set when it keeps one, from its digest when it holds that in
 * place of its reads, and `undefined` for any other payload, such as a
 * compaction marker or a digest of a shape the engine does not write. The
 * engine writes a digest of reads only for a commit that carried some, so
 * counts that are both zero mark a digest it did not write.
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
  if (
    reads === undefined && namesSubmission(digest) &&
    isCount(digest.confirmed) && isCount(digest.pending) &&
    digest.confirmed + digest.pending > 0
  ) {
    return {
      confirmed: digest.confirmed,
      pending: digest.pending,
      kept: false,
    };
  }
  return undefined;
};

/**
 * Helper for `omitsOperations()` and `storedOperationCount()`, which returns
 * the operation count the digest of `stored` records in place of its
 * operations, or `undefined` when `stored` holds no such digest. The engine
 * writes that form only for a commit that carried operations, so a count of
 * zero marks a digest it did not write.
 */
const digestedOperationCount = (
  stored: Record<string, unknown>,
): number | undefined => {
  const { operations, digest } = stored;
  return operations === undefined && namesSubmission(digest) &&
      isCount(digest.operations) && digest.operations > 0
    ? digest.operations
    : undefined;
};

/**
 * Returns whether `stored`, a decoded commit row's `original`, holds a digest
 * in place of its operations. False for a commit that holds its operations
 * and for any other payload, such as a compaction marker.
 */
export const omitsOperations = (
  stored: StoredClientCommit,
): stored is WithoutOperations => digestedOperationCount(stored) !== undefined;

/** How many operations a stored commit records, and whether it keeps them. */
export type StoredOperationCount = {
  /** How many operations the commit carried. */
  operations: number;

  /** False for a commit whose operations the log holds only as a digest. */
  kept: boolean;
};

/**
 * Returns the operation count `stored`, a decoded commit row's `original`,
 * records: from its operations when it keeps them, from its digest when it
 * holds that in their place, and `undefined` for any other payload, such as a
 * compaction marker or a digest of a shape the engine does not write.
 */
export const storedOperationCount = (
  stored: unknown,
): StoredOperationCount | undefined => {
  if (!isObject(stored)) return undefined;
  if (Array.isArray(stored.operations)) {
    return { operations: stored.operations.length, kept: true };
  }
  const operations = digestedOperationCount(stored);
  return operations === undefined ? undefined : { operations, kept: false };
};
