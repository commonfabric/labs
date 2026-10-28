import { expect } from "@std/expect";
import {
  getCommitLocalSeq,
  getCommitSeq,
  getCoveringCommitLocalSeq,
  recordCommitLocalSeq,
  recordCommitSeq,
  recordSplitCommitSpaces,
} from "../src/storage/commit-identity.ts";
import type { IStorageTransaction } from "../src/storage/interface.ts";

Deno.test("commit local sequence lookup is empty without a source transaction", () => {
  expect(getCommitLocalSeq(undefined, "did:key:space")).toBeUndefined();
});

Deno.test("commit local sequence records values per source and space", () => {
  const tx = {} as IStorageTransaction;

  recordCommitLocalSeq(tx, "did:key:space", 7);

  expect(getCommitLocalSeq(tx, "did:key:space")).toBe(7);
  expect(getCommitLocalSeq(tx, "did:key:other")).toBeUndefined();
});

Deno.test("commit store sequence lookup is empty without a source transaction", () => {
  expect(getCommitSeq(undefined, "did:key:space")).toBeUndefined();
});

Deno.test("commit store sequence records values per source and space", () => {
  const tx = {} as IStorageTransaction;

  recordCommitSeq(tx, "did:key:space", 42);

  expect(getCommitSeq(tx, "did:key:space")).toBe(42);
  expect(getCommitSeq(tx, "did:key:other")).toBeUndefined();
  expect(getCommitLocalSeq(tx, "did:key:space")).toBeUndefined();
});

Deno.test("a commit to one space covers its source; a split commit covers none", () => {
  const single = {} as IStorageTransaction;
  recordSplitCommitSpaces(single, ["did:key:space"]);
  recordCommitLocalSeq(single, "did:key:space", 3);
  expect(getCoveringCommitLocalSeq(single, "did:key:space")).toBe(3);

  const split = {} as IStorageTransaction;
  recordSplitCommitSpaces(split, ["did:key:child", "did:key:space"]);
  recordCommitLocalSeq(split, "did:key:child", 4);
  recordCommitLocalSeq(split, "did:key:space", 5);
  expect(getCoveringCommitLocalSeq(split, "did:key:child")).toBeUndefined();
  expect(getCoveringCommitLocalSeq(split, "did:key:space")).toBeUndefined();
  expect(getCommitLocalSeq(split, "did:key:space")).toBe(5);
});
