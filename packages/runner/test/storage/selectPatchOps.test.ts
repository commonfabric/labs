import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { encodePointer } from "@commonfabric/memory/v2/path";

import {
  type PatchDraftCandidate,
  selectPatchOps,
} from "../../src/storage/v2-transaction.ts";

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
