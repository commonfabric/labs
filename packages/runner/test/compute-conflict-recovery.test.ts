// Scheduler-side characterization of the conflict/subscription coupling: which
// readers leaf-only reader-dirty propagation re-triggers, and which it does not.
//
// A reactive compute whose commit fails with a granular ConflictError is
// recovered by re-queuing after the conflict's catch-up gate (see
// scheduler/action-run.ts). Reader-dirty propagation is a redundant fast path:
// it re-runs the compute sooner when the catch-up write lands as a fresh
// notification, but only for readers the write actually dirties, and that set is
// leaf-only:
//
//     readerDirty(write, read)  iff  the write's leaf paths overlap the read
//
// So the fast path does NOT cover every conflict. Two code paths set the bounds:
//
//   - commit-conflict (memory engine `validateConfirmedReads` -> `findConflictSeq`,
//     which decides `patchOverlapsRead`)
//     PARENT-INJECTS before #4220: an `add` of `votes/alice` touches
//     `[votes/alice, votes]`, and the injected parent `votes` prefix-matches a
//     read of the disjoint sibling `votes/bob`  ==> CONFLICT.
//   - reader-dirty (scheduler `arraysOverlap`, fed by leaf-only
//     `schedulerTouchedLeafPathsForPatch`) is LEAF-ONLY: `votes/alice` does not
//     overlap `votes/bob`  ==> NOT a reader, NOT dirtied.
//
// So a compute that reads one key, racing a peer that adds a disjoint sibling
// key, can get a granular ConflictError that reader-dirty never re-triggers.
// #4220 aligns the commit-conflict matcher onto the same leaf-only paths the
// scheduler uses, so that spurious conflict disappears at the source; the
// scheduler's catch-up re-queue is the backstop that recovers any genuine
// conflict the fast path misses. Neither layer relies on the other for
// correctness.
//
// Coverage split (both layers exercised independently; neither is reachable from
// a single-replica runtime test, where the client-side whole-document
// attestation guard short-circuits with `StorageTransactionInconsistent` before
// the engine's path-granular matcher runs):
//   - commit-conflict layer: packages/memory/test/v2-engine.test.ts ->
//     "memory v2 engine: leaf-only commit conflict — disjoint-key writers merge".
//     That test PASSES with #4220's leaf-only matcher and FAILS (ConflictError,
//     validateConfirmedReads) on the parent-injecting matcher — i.e. it flips
//     exactly at #4220, which is the commit-conflict half of the coupling.
//   - reader-dirty layer: the assertions below, on the real scheduler predicate.

import { assert } from "@std/assert";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../src/reactive-dependencies.ts";

Deno.test(
  "reader-dirty re-triggers container readers but not disjoint-sibling readers",
  () => {
    // A sibling-leaf reader is exactly the reader leaf-only propagation does NOT
    // re-trigger — so a granular conflict against it cannot be recovered by the
    // reader-dirty fast path. #4220 stops the engine from raising that conflict
    // in the first place; the scheduler's catch-up re-queue recovers any that
    // remain.
    assert(
      arraysOverlap(["votes", "alice"], ["votes", "bob"]) === false,
      "a write to votes.alice must NOT dirty a reader of the disjoint sibling votes.bob",
    );

    // A whole-container reader IS dirtied by the add — this is the
    // true-dependency case the reader-dirty fast path covers.
    assert(
      arraysOverlap(["votes", "alice"], ["votes"]) === true,
      "a write to votes.alice MUST dirty a reader of the container votes",
    );

    // A non-recursive (keyset / shape) reader of the container is also dirtied by
    // a direct-child add via the length+1 rule, so keyset readers recover too.
    assert(
      nonRecursiveReadMayOverlapWrite(["votes"], ["votes", "alice"]) === true,
      "a non-recursive reader of votes MUST be dirtied by adding the child votes.alice",
    );
  },
);
