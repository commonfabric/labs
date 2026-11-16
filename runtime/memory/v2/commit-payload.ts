/**
 * The forms a commit's payload takes in the commit log's `original` column.
 * A commit is stored whole, as the codec encodes it, except an eligible
 * derived commit, which is stored digested: every member but `operations`,
 * and a `digest` member naming the SHA-256, UTF-8 length and operation count
 * of the whole encoding. A digested commit's operations are kept in the
 * `revision` table alone. `docs/specs/memory-v2/02-storage.md` states the
 * eligibility and the form.
 */

import type { FabricValue } from "@commonfabric/api";
import { toUnpaddedBase64url } from "@commonfabric/bytes/base64url";
import { sha256 } from "@commonfabric/content-hash";
import { isFabricPlainObject } from "@commonfabric/data-model";

import {
  type ClientCommit,
  type CommitClass,
  encodeMemoryBoundary,
} from "../v2.ts";

/** What a digested payload holds in place of its commit's operations. */
export type CommitPayloadDigest = {
  /** Unpadded base64url SHA-256 of the UTF-8 bytes of the whole encoding. */
  sha256: string;

  /** Length in bytes of the UTF-8 form of the whole encoding. */
  bytes: number;

  /** How many operations the commit carried. */
  operations: number;
};

/** The operations a digested commit may carry: all of them reach a revision. */
const DIGESTIBLE_OPS: ReadonlySet<string> = new Set(["set", "patch", "delete"]);

const textEncoder = new TextEncoder();

/** Whether `value` is a non-negative safe integer. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether `commit`, admitted under `commitClass` at `seq`, is stored
 * digested. Only a derived commit is: an authored commit's payload is its
 * client's reconnect identity. Seq 1 is never digested, because the genesis
 * receipt is read back whole. A commit is digested only when every operation
 * is a `set`, `patch` or `delete`, since a `sqlite` operation's text is
 * stored nowhere else and the op-field tables join to the whole request.
 */
export const isDigestEligible = (
  commit: ClientCommit,
  commitClass: CommitClass,
  seq: number,
): boolean =>
  commitClass === "derived" && seq !== 1 && commit.operations.length > 0 &&
  commit.operations.every((operation) => DIGESTIBLE_OPS.has(operation.op));

/**
 * The digested payload of `commit`, given `encoded`, the whole encoding of
 * `commit` that `encodeMemoryBoundary()` returns. The digest is taken over
 * `encoded` as given, so a caller passing any other text stores a digest no
 * resubmission matches.
 */
export const digestedPayloadOf = (
  commit: ClientCommit,
  encoded: string,
): string => {
  const utf8 = textEncoder.encode(encoded);
  const { operations, ...kept } = commit;
  const digest: CommitPayloadDigest = {
    sha256: toUnpaddedBase64url(sha256(utf8)),
    bytes: utf8.length,
    operations: operations.length,
  };
  return encodeMemoryBoundary({ ...kept, digest });
};

/**
 * The digest a decoded stored payload holds, or `undefined` for a payload
 * that is not digested. A payload is digested when it is an object with a
 * `digest` member that is an object and no `operations` member, which no
 * client commit can be, since every client commit carries `operations`.
 * Recognition is by shape and not by a prefix of the encoding, because
 * members such as `branch` and `codeCID` sort ahead of `digest`. Throws for a
 * digest whose members are not a hash string and two counts.
 */
export const payloadDigest = (
  payload: FabricValue,
): CommitPayloadDigest | undefined => {
  if (
    !isFabricPlainObject(payload) || "operations" in payload ||
    !isFabricPlainObject(payload.digest)
  ) {
    return undefined;
  }
  const { sha256: hash, bytes, operations } = payload.digest;
  if (typeof hash !== "string" || !isCount(bytes) || !isCount(operations)) {
    throw new Error(
      "A digested commit payload must name a `sha256` string and " +
        "non-negative integer `bytes` and `operations` counts.",
    );
  }
  return { sha256: hash, bytes, operations };
};

/**
 * Whether the commit log row `row` stores `commit`, given `encoded`, the
 * whole encoding of `commit`. A row matches when it holds that encoding, or
 * when it is a derived row, `commit` is eligible at the row's seq, and the
 * row holds the digested payload of `commit`. Two commits share a digested
 * payload exactly when their whole encodings are equal, short of a SHA-256
 * collision at equal length, so this decides as the comparison of whole
 * encodings does.
 */
export const storedPayloadMatches = (
  row: { readonly original: string; readonly class: string; seq: number },
  commit: ClientCommit,
  encoded: string,
): boolean => {
  if (row.original === encoded) return true;
  if (
    row.class !== "derived" || !isDigestEligible(commit, "derived", row.seq)
  ) {
    return false;
  }
  return row.original === digestedPayloadOf(commit, encoded);
};
