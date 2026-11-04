// The serving loop's per-space derived-commit accounting
// (`derivedCommitsBySpace` — serving-loop.md §7's counter block). The
// process-wide `derivedCommits` total cannot attribute a delta to the
// space under test on a shared host (another space's serving activity —
// e.g. a drain-settle quiescence advance from a PREVIOUS test's space —
// is indistinguishable from the watched space's waves), which is what
// the sx2-events coalescing observation and the OW52-style loss
// accounting both need. The helper keeps the total and the per-space
// row in lockstep and bounds the map like settle.series: at most
// DERIVED_COMMITS_BY_SPACE_MAX spaces tracked, oldest row evicted into
// the dropped fold.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bumpDerivedCommits,
  DERIVED_COMMITS_BY_SPACE_MAX,
  emptyServingLoopStats,
} from "../src/executor/stats.ts";

describe("bumpDerivedCommits (per-space derived-commit accounting)", () => {
  it("keeps the total and the per-space row in lockstep", () => {
    const stats = emptyServingLoopStats();
    bumpDerivedCommits(stats, "did:key:zSpaceA");
    bumpDerivedCommits(stats, "did:key:zSpaceA");
    bumpDerivedCommits(stats, "did:key:zSpaceB");
    expect(stats.derivedCommits).toBe(3);
    expect(stats.derivedCommitsBySpace["did:key:zSpaceA"]).toBe(2);
    expect(stats.derivedCommitsBySpace["did:key:zSpaceB"]).toBe(1);
    expect(stats.derivedCommitsBySpaceDropped).toBe(0);
  });

  it("bounds the map: a new space beyond the cap evicts the OLDEST row into the dropped fold, and the total never loses a count", () => {
    const stats = emptyServingLoopStats();
    for (let i = 0; i < DERIVED_COMMITS_BY_SPACE_MAX; i++) {
      bumpDerivedCommits(stats, `did:key:z${i}`);
      bumpDerivedCommits(stats, `did:key:z${i}`);
    }
    expect(Object.keys(stats.derivedCommitsBySpace).length).toBe(
      DERIVED_COMMITS_BY_SPACE_MAX,
    );
    // One over the cap: the oldest (z0, count 2) folds into dropped.
    bumpDerivedCommits(stats, "did:key:zOverflow");
    expect(Object.keys(stats.derivedCommitsBySpace).length).toBe(
      DERIVED_COMMITS_BY_SPACE_MAX,
    );
    expect(stats.derivedCommitsBySpace["did:key:z0"]).toBeUndefined();
    expect(stats.derivedCommitsBySpace["did:key:zOverflow"]).toBe(1);
    expect(stats.derivedCommitsBySpaceDropped).toBe(2);
    // The process-wide total is conserved: tracked rows + dropped fold.
    const tracked = Object.values(stats.derivedCommitsBySpace)
      .reduce((a, b) => a + b, 0);
    expect(tracked + stats.derivedCommitsBySpaceDropped).toBe(
      stats.derivedCommits,
    );
  });

  it("an evicted space that speaks again re-enters as a fresh row (its history stays in the fold)", () => {
    const stats = emptyServingLoopStats();
    for (let i = 0; i < DERIVED_COMMITS_BY_SPACE_MAX + 1; i++) {
      bumpDerivedCommits(stats, `did:key:z${i}`);
    }
    // z0 was evicted by the overflow above; it speaks again.
    bumpDerivedCommits(stats, "did:key:z0");
    expect(stats.derivedCommitsBySpace["did:key:z0"]).toBe(1);
    const tracked = Object.values(stats.derivedCommitsBySpace)
      .reduce((a, b) => a + b, 0);
    expect(tracked + stats.derivedCommitsBySpaceDropped).toBe(
      stats.derivedCommits,
    );
  });
});
