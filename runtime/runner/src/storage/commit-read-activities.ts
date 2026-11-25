/**
 * The reads a transaction's commit carries into the store's conflict check.
 * The replica builds a commit's read set from them (`SpaceReplica`'s
 * `#buildReads()` in `./v2.ts`), and the transaction's patch encoder asks
 * which of them pin an array before it sends a change to that array as
 * splices (`./v2-transaction.ts`).
 */

import { normalizeCellScope } from "../scope.ts";
import { hasInlineCellScheme } from "../immutable-cell.ts";
import * as Differential from "./differential.ts";
import type {
  IReadActivity,
  IStorageTransaction,
  MemorySpace,
} from "./interface.ts";
import {
  isInternalVerifierRead,
  isMergeableOpRead,
  isReadExcludedFromConflict,
  isReadIgnoredForCommit,
  isReadMarkedAsAttemptedWrite,
} from "./reactivity-log.ts";
import {
  getDirectTransactionMergeableOpAddresses,
  getTransactionWriteAttempts,
} from "./transaction-inspection.ts";

const DOCUMENT_MIME = "application/json" as const;

const isStrictPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length < path.length &&
  prefix.every((segment, index) => path[index] === segment);

const isSamePath = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((segment, index) => b[index] === segment);

// True when `path` is the immediate `length` child of `arrayPath` — i.e. a read
// of that array's own element count. A mergeable append / add-unique /
// remove-by-value changes this count, so such a read is a genuine dependency of
// the writer, not one of the op's own incidental sub-reads.
const isArrayLengthChildPath = (
  arrayPath: readonly string[],
  path: readonly string[],
): boolean =>
  path.length === arrayPath.length + 1 &&
  path[arrayPath.length] === "length" &&
  arrayPath.every((segment, index) => path[index] === segment);

/**
 * Returns the reads of `source` that its commit to `space` carries as
 * commit-time concurrency preconditions, out of `reads`, its raw read
 * activities. Reconciliation, commit construction and the patch encoder must
 * use the same set: loading a read that the commit later drops can spend a
 * retry on an observation the server would never validate, and an encoder
 * that leans on a read the commit drops relies on a check the store never
 * makes.
 */
export function commitReadActivities(
  space: MemorySpace,
  source: IStorageTransaction,
  reads: Iterable<IReadActivity>,
): IReadActivity[] {
  // A mergeable op resolves against durable state, so it does not depend on
  // the document's prior value. Reads incidental to the op are excluded,
  // while a handler's own explicit read remains a real dependency.
  const mergeableOpPathsByEntity = new Map<
    string,
    (readonly string[])[]
  >();
  for (const op of getDirectTransactionMergeableOpAddresses(source) ?? []) {
    if (op.space !== space) continue;
    const key = `${op.id}\0${normalizeCellScope(op.scope)}`;
    const paths = mergeableOpPathsByEntity.get(key);
    if (paths) {
      paths.push(op.path);
    } else {
      mergeableOpPathsByEntity.set(key, [op.path]);
    }
  }
  // A document whose CFC envelope this transaction writes beside a
  // mergeable op. The envelope is a whole-member replace whose entries name
  // positions in the array the transaction read, and which carries forward
  // the entries it read there; the op, by contrast, is placed by the store
  // against the live array. Both the envelope and the array it was placed
  // against are therefore dependencies of such a commit: a concurrent
  // change to either moves an element away from the entry that describes
  // it, or drops another writer's entries. Those documents keep every read
  // the narrowing below would otherwise drop, so the commit conflicts and
  // the writer re-derives its envelope against the list the store holds.
  const envelopeWritersWithMergeableOps = new Set<string>();
  if (mergeableOpPathsByEntity.size > 0) {
    for (const write of getTransactionWriteAttempts(source) ?? []) {
      if (
        write.space !== space ||
        !Differential.isCfcEnvelopePath(write.path)
      ) {
        continue;
      }
      const key = `${write.id}\0${normalizeCellScope(write.scope)}`;
      if (mergeableOpPathsByEntity.has(key)) {
        envelopeWritersWithMergeableOps.add(key);
      }
    }
  }

  const commitReads: IReadActivity[] = [];
  for (const read of reads) {
    if (
      read.space !== space ||
      (read.type ?? DOCUMENT_MIME) !== DOCUMENT_MIME ||
      hasInlineCellScheme(read.id) ||
      // Content-addressed documents cannot change, so their reads carry no
      // commit-time concurrency precondition.
      read.id.startsWith("cid:") ||
      // Blind UI-input write-target reads are replaced by one structural
      // parent read after buildReads' main loop.
      isReadIgnoredForCommit(read.meta) ||
      // Reference-resolution shape reads stay reactive but do not constrain
      // the commit; recursive reads remain value dependencies.
      (isReadExcludedFromConflict(read.meta) &&
        read.nonRecursive === true)
    ) {
      continue;
    }

    const scope = normalizeCellScope(read.scope);
    const key = `${read.id}\0${scope}`;
    if (envelopeWritersWithMergeableOps.has(key)) {
      commitReads.push(read);
      continue;
    }
    // Runtime verifier reads of the CFC label are point-in-time policy
    // observations, not consumed values.
    if (
      isInternalVerifierRead(read.meta) &&
      Differential.isCfcEnvelopePath(read.path)
    ) {
      continue;
    }
    const opPaths = mergeableOpPathsByEntity.get(key);
    // A read of an op array's length is a genuine dependency: the handler
    // used the element count that a concurrent mergeable op changes.
    const readsMergeableOpArrayLength = opPaths !== undefined &&
      opPaths.some((opPath) => isArrayLengthChildPath(opPath, read.path));
    if (
      opPaths !== undefined &&
      !readsMergeableOpArrayLength &&
      (isMergeableOpRead(read.meta) ||
        isReadMarkedAsAttemptedWrite(read.meta) ||
        // A mergeable write reads the CFC envelope as part of the write;
        // the read leaves the conflict set unless the transaction also
        // writes the envelope (handled above).
        Differential.isCfcEnvelopePath(read.path) ||
        opPaths.some((opPath) =>
          isStrictPrefixPath(opPath, read.path) ||
          (read.nonRecursive === true && isSamePath(opPath, read.path))
        ))
    ) {
      continue;
    }
    commitReads.push(read);
  }
  return commitReads;
}
