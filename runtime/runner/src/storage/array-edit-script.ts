/**
 * Shortest edit scripts between two sequences, found with a bound on how many
 * edits the search may consider, for the commit diff of an array
 * (`buildArrayPatchCandidates()` in `./v2-transaction.ts`).
 */

/**
 * One run of an edit script: `remove` elements of the old sequence, from
 * `start` on, give way to `add` elements of the new one, from `addStart` on.
 * Positions are in each sequence's own coordinates, so a run is located
 * without applying the runs before it.
 */
export type ArrayEditHunk = {
  /** The first index in the old sequence the run replaces. */
  start: number;

  /** How many elements of the old sequence the run removes. */
  remove: number;

  /** The first index in the new sequence of the elements the run adds. */
  addStart: number;

  /** How many elements of the new sequence the run adds. */
  add: number;
};

/**
 * Returns the runs of a shortest edit script from a sequence of
 * `beforeLength` elements to one of `afterLength`, in increasing order, where
 * `same(i, j)` says whether the old sequence's element `i` equals the new
 * one's element `j`. A shortest script removes and adds as few elements as
 * any script can, so it keeps a longest common subsequence in place.
 *
 * Returns `undefined` when every such script makes more than `maxEdits`
 * removals and additions together. The search then costs time proportional to
 * `(beforeLength + afterLength) * maxEdits` and space proportional to
 * `maxEdits` squared, so a bound keeps it linear in the sequences' lengths.
 * This is the forward greedy search of Myers, "An O(ND) Difference Algorithm
 * and Its Variations" (1986), with the per-step frontiers kept for the walk
 * back.
 */
export function shortestEditHunks(
  beforeLength: number,
  afterLength: number,
  same: (beforeIndex: number, afterIndex: number) => boolean,
  maxEdits: number,
): ArrayEditHunk[] | undefined {
  const limit = Math.min(maxEdits, beforeLength + afterLength);
  // `frontiers[d]` holds, for each diagonal `k` from `-d` to `d` in steps of
  // two, the furthest old-sequence position a script of `d` edits reaches on
  // that diagonal, at index `(k + d) / 2`. The new-sequence position is that
  // position less `k`.
  const frontiers: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    const previous = frontiers[d - 1];
    const frontier = new Int32Array(d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (previous === undefined) {
        x = 0;
      } else if (extendsFromAbove(previous, d, k)) {
        // One more addition, from the diagonal above.
        x = reach(previous, d - 1, k + 1);
      } else {
        // One more removal, from the diagonal below.
        x = reach(previous, d - 1, k - 1) + 1;
      }
      let y = x - k;
      while (x < beforeLength && y < afterLength && same(x, y)) {
        x += 1;
        y += 1;
      }
      frontier[(k + d) / 2] = x;
      if (x >= beforeLength && y >= afterLength) {
        frontiers.push(frontier);
        return hunksFromFrontiers(frontiers, beforeLength, afterLength);
      }
    }
    frontiers.push(frontier);
  }
  return undefined;
}

/**
 * Helper for {@link shortestEditHunks}, which reads the furthest position a
 * script of `d` edits reaches on diagonal `k`.
 */
function reach(frontier: Int32Array, d: number, k: number): number {
  return frontier[(k + d) / 2]!;
}

/**
 * Helper for {@link shortestEditHunks}, which decides whether the furthest
 * script of `d` edits on diagonal `k` extends the one of `d - 1` edits on the
 * diagonal above it by an addition, rather than the one below it by a
 * removal. `previous` is the frontier of `d - 1` edits.
 */
function extendsFromAbove(previous: Int32Array, d: number, k: number): boolean {
  return k === -d ||
    (k !== d && reach(previous, d - 1, k - 1) < reach(previous, d - 1, k + 1));
}

/**
 * Helper for {@link shortestEditHunks}, which walks the frontiers of a
 * finished search back from the end of both sequences and gathers the edits
 * it passes into runs.
 */
function hunksFromFrontiers(
  frontiers: readonly Int32Array[],
  beforeLength: number,
  afterLength: number,
): ArrayEditHunk[] {
  const hunks: ArrayEditHunk[] = [];
  // The run being gathered, which grows toward the start of both sequences
  // until a matched element ends it.
  let open: ArrayEditHunk | undefined;
  const close = () => {
    if (open !== undefined) {
      hunks.push(open);
      open = undefined;
    }
  };

  let x = beforeLength;
  let y = afterLength;
  for (let d = frontiers.length - 1; d > 0; d -= 1) {
    const previous = frontiers[d - 1]!;
    const k = x - y;
    const fromAbove = extendsFromAbove(previous, d, k);
    const previousK = fromAbove ? k + 1 : k - 1;
    const previousX = reach(previous, d - 1, previousK);
    const previousY = previousX - previousK;
    // The matched elements this step ended on, after its one edit.
    const editX = fromAbove ? previousX : previousX + 1;
    if (x > editX) {
      close();
      y -= x - editX;
      x = editX;
    }
    // The edit itself: an addition of the new sequence's element
    // `previousY`, or a removal of the old sequence's element `previousX`.
    open ??= { start: x, remove: 0, addStart: y, add: 0 };
    if (fromAbove) {
      open.add += 1;
    } else {
      open.remove += 1;
    }
    open.start = previousX;
    open.addStart = previousY;
    x = previousX;
    y = previousY;
  }
  close();
  return hunks.reverse();
}

/**
 * Returns, for each element of a sequence of `beforeLength` elements, the
 * index in a sequence of `afterLength` elements of the element a shortest edit
 * script keeps it as, or `-1` where the script removes it. `same(i, j)` says
 * whether the old sequence's element `i` equals the new one's element `j`.
 *
 * The two sequences' common prefix and common suffix are kept first, compared
 * by `same`, and the search for a script runs between them, within
 * `maxEdits` removals and additions as {@link shortestEditHunks} bounds it.
 * Where no script between them is that short, every old element between them
 * is reported removed, so only the prefix and the suffix are kept.
 */
export function keptElementIndices(
  beforeLength: number,
  afterLength: number,
  same: (beforeIndex: number, afterIndex: number) => boolean,
  maxEdits: number,
): Int32Array {
  const kept = new Int32Array(beforeLength).fill(-1);
  const shorter = Math.min(beforeLength, afterLength);
  let prefix = 0;
  while (prefix < shorter && same(prefix, prefix)) {
    kept[prefix] = prefix;
    prefix += 1;
  }
  let suffix = 0;
  while (
    prefix + suffix < shorter &&
    same(beforeLength - 1 - suffix, afterLength - 1 - suffix)
  ) {
    kept[beforeLength - 1 - suffix] = afterLength - 1 - suffix;
    suffix += 1;
  }
  const beforeBetween = beforeLength - prefix - suffix;
  const afterBetween = afterLength - prefix - suffix;
  if (beforeBetween === 0 || afterBetween === 0) return kept;
  const hunks = shortestEditHunks(
    beforeBetween,
    afterBetween,
    (beforeIndex, afterIndex) =>
      same(beforeIndex + prefix, afterIndex + prefix),
    maxEdits,
  );
  if (hunks === undefined) return kept;
  // The elements outside the runs are kept, in order, in both sequences. The
  // last run ends at the end of both, since their last elements differ once
  // the common suffix is set aside.
  let beforeIndex = 0;
  let afterIndex = 0;
  for (const hunk of hunks) {
    while (beforeIndex < hunk.start) {
      kept[beforeIndex + prefix] = afterIndex + prefix;
      beforeIndex += 1;
      afterIndex += 1;
    }
    beforeIndex += hunk.remove;
    afterIndex += hunk.add;
  }
  return kept;
}
