/**
 * How `compactCommitReads()` counts the members of the document a group of
 * reads observed: a frozen container's count holds for good, and a mutable
 * one is counted again on every compaction.
 */

import { expect } from "@std/expect";
import { toDocumentPath } from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";

import type { URI } from "../src/storage/interface.ts";
import { compactCommitReads } from "../src/storage/v2.ts";

const id = "of:storage-v2-read-compaction-cov" as URI;

/** A confirmed read of `path` in the document at seq 1. */
const read = (path: string[], nonRecursive?: true) => ({
  id,
  path: toDocumentPath(path),
  seq: 1,
  ...(nonRecursive ? { nonRecursive } : {}),
});

/** A shallow read of `value`, and a read of each of `a` and `b` under it. */
const reads = () => [
  read(["value"], true),
  read(["value", "a"]),
  read(["value", "b"]),
];

/** The reads `reads()` compacts to when they read `value` in full. */
const inFull = [read(["value"], true), read(["value"])];

/** The reads `reads()` compacts to when they do not. */
const apart = reads();

describe("compactCommitReads()", () => {
  it("merges the reads of every member of a mutable document, and keeps them apart once it gains a member", () => {
    const observed: { value: Record<string, number> } = {
      value: { a: 1, b: 2 },
    };

    expect(compactCommitReads(reads(), () => observed)).toEqual(inFull);

    observed.value.c = 3;
    expect(compactCommitReads(reads(), () => observed)).toEqual(apart);
  });

  it("merges the reads of every member of a frozen document, and keeps them apart over one with a member nobody read", () => {
    const full = Object.freeze({ value: Object.freeze({ a: 1, b: 2 }) });
    const wider = Object.freeze({
      value: Object.freeze({ a: 1, b: 2, c: 3 }),
    });

    expect(compactCommitReads(reads(), () => full)).toEqual(inFull);
    expect(compactCommitReads(reads(), () => full)).toEqual(inFull);
    expect(compactCommitReads(reads(), () => wider)).toEqual(apart);
  });
});
