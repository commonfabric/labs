import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { encodePointer, isPrefixPath } from "@commonfabric/memory/v2/path";

import {
  type PatchDraftCandidate,
  selectPatchOps,
} from "../../src/storage/v2-transaction.ts";
import { seededRandom } from "../combine-order.ts";

/** A covering `replace` candidate at `path`. */
const cover = (path: readonly string[]): PatchDraftCandidate => ({
  patch: { op: "replace", path: encodePointer(path), value: 1 },
  path,
  coversDescendants: true,
});

/** A splice candidate at the array `path`, touching its tail from `start`. */
const tailSplice = (
  path: readonly string[],
  start: number,
): PatchDraftCandidate => ({
  patch: {
    op: "splice",
    path: encodePointer(path),
    index: start,
    remove: 0,
    add: [1],
  },
  path,
  coversDescendants: false,
  tailSpliceStartIndex: start,
});

/** The pointers of the ops `selectPatchOps()` keeps. */
const keptPointers = (
  fullCover: readonly PatchDraftCandidate[],
  nonCover: readonly PatchDraftCandidate[],
  suppress: Parameters<typeof selectPatchOps>[2] = [],
): string[] =>
  selectPatchOps(fullCover, nonCover, suppress).map((patch) =>
    (patch as { path: string }).path
  );

/**
 * Selects among `count` covering candidates for sibling keys, each candidate's
 * path behind a proxy, and reports how many segments were read off those paths.
 *
 * Comparing two paths reads their segments, so a count that tracks the number
 * of candidates is each candidate being compared against the others.
 */
const segmentReadsSelecting = (count: number): number => {
  let reads = 0;
  const counted = (path: readonly string[]): readonly string[] =>
    new Proxy(path, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
  const candidates = Array.from(
    { length: count },
    (_, index) => cover(counted(["value", `key-${index}`])),
  );
  // Building each candidate's pointer above reads its path too, and is not
  // what is being counted.
  reads = 0;

  expect(selectPatchOps(candidates, [], []).length).toBe(count);
  return reads;
};

/**
 * The selection `selectPatchOps()` makes, stated directly: every candidate
 * compared with every other. Quadratic, and so a statement of the rules rather
 * than a way to apply them.
 */
const selectComparingAllPairs = (
  fullCover: readonly PatchDraftCandidate[],
  nonCover: readonly PatchDraftCandidate[],
  suppress: Parameters<typeof selectPatchOps>[2],
): string[] => {
  const subsumedByTailSplice = (path: readonly string[]) =>
    nonCover.some((splice) =>
      splice.tailSpliceStartIndex !== undefined &&
      path.length > splice.path.length && isPrefixPath(splice.path, path) &&
      /^(0|[1-9]\d*)$/.test(path[splice.path.length]) &&
      Number(path[splice.path.length]) >= splice.tailSpliceStartIndex
    );
  const covers = fullCover
    .filter((candidate) => !subsumedByTailSplice(candidate.path))
    .sort((left, right) => left.path.length - right.path.length)
    .reduce<PatchDraftCandidate[]>(
      (kept, candidate) =>
        kept.some((earlier) => isPrefixPath(earlier.path, candidate.path))
          ? kept
          : [...kept, candidate],
      [],
    );
  const others = nonCover.filter((candidate) =>
    !covers.some((cover) => isPrefixPath(cover.path, candidate.path)) &&
    !subsumedByTailSplice(candidate.path)
  );
  const suppressed = (path: readonly string[]) =>
    suppress.some((suppression) => {
      if (!isPrefixPath(suppression.path, path)) return false;
      if (path.length === suppression.path.length || suppression.subtree) {
        return true;
      }
      const child = path[suppression.path.length];
      return suppression.tailStart !== undefined &&
        /^(0|[1-9]\d*)$/.test(child) && Number(child) >= suppression.tailStart;
    });
  return [...covers, ...others]
    .filter((candidate) => !suppressed(candidate.path))
    .map((candidate) => (candidate.patch as { path: string }).path);
};

describe("selectPatchOps()", () => {
  it("returns a covering candidate once and drops the ones beneath it", () => {
    expect(keptPointers([
      cover(["value", "a", "x"]),
      cover(["value", "a"]),
      cover(["value", "a"]),
      cover(["value", "b"]),
    ], [])).toEqual(["/value/a", "/value/b"]);
  });

  it("drops a covering candidate at or past a tail splice's start", () => {
    expect(keptPointers([
      cover(["value", "list", "1"]),
      cover(["value", "list", "2"]),
    ], [tailSplice(["value", "list"], 2)])).toEqual([
      "/value/list/1",
      "/value/list",
    ]);
  });

  it("drops a non-covering candidate beneath a kept covering one", () => {
    expect(keptPointers(
      [cover(["value", "a"])],
      [tailSplice(["value", "a", "list"], 0), tailSplice(["value", "b"], 0)],
    )).toEqual(["/value/a", "/value/b"]);
  });

  it("drops a candidate a suppression at its own path names", () => {
    expect(keptPointers(
      [cover(["value", "count"]), cover(["value", "other"])],
      [],
      [{ path: ["value", "count"] }],
    )).toEqual(["/value/other"]);
  });

  it("drops every candidate beneath a subtree suppression", () => {
    expect(keptPointers(
      [cover(["value", "list", "0", "name"]), cover(["value", "other"])],
      [],
      [{ path: ["value", "list"], subtree: true }],
    )).toEqual(["/value/other"]);
  });

  it("drops only the tail's element candidates beneath a tail suppression", () => {
    expect(keptPointers(
      [
        cover(["value", "list", "0"]),
        cover(["value", "list", "3"]),
        cover(["value", "list", "name"]),
      ],
      [],
      [{ path: ["value", "list"], tailStart: 2 }],
    )).toEqual(["/value/list/0", "/value/list/name"]);
  });

  it("returns what comparing every candidate with every other returns", () => {
    // Paths drawn from a small tree, so that candidates, tail splices and
    // suppressions sit at, above and beneath one another, with the segments
    // a pointer escapes among them.

    const random = seededRandom(8144);
    const segments = ["value", "a", "0", "1", "2", "~x", "x/y", ""];
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)];
    const path = () =>
      Array.from({ length: Math.floor(random() * 4) }, () => pick(segments));
    for (let run = 0; run < 3000; run++) {
      const fullCover = Array.from(
        { length: Math.floor(random() * 8) },
        () => cover(path()),
      );
      const nonCover = Array.from(
        { length: Math.floor(random() * 4) },
        () => tailSplice(path(), Math.floor(random() * 3)),
      );
      const suppress = Array.from({ length: Math.floor(random() * 3) }, () => {
        const kind = random();
        return {
          path: path(),
          ...(kind < 0.33
            ? { subtree: true }
            : kind < 0.66
            ? { tailStart: Math.floor(random() * 3) }
            : {}),
        };
      });

      expect(keptPointers(fullCover, nonCover, suppress)).toEqual(
        selectComparingAllPairs(fullCover, nonCover, suppress),
      );
    }
  });

  it("reads each candidate's path as often among many candidates as among few", () => {
    const short = segmentReadsSelecting(20) / 20;
    const long = segmentReadsSelecting(200) / 200;

    // Per candidate. Comparing each candidate with those kept before it reads
    // a kept path once per later candidate, which multiplies the count per
    // candidate about tenfold between these sizes; the bound leaves room for
    // a factor that grows as slowly as a sort's. The floor keeps a probe that
    // stopped observing the paths from passing at zero.
    expect(short).toBeGreaterThan(0);
    expect(long).toBeLessThan(short * 2);
  });
});
