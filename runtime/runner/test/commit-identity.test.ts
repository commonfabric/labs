import { expect } from "@std/expect";
import {
  getCommitLocalSeq,
  getCommitSeq,
  recordCommitLocalSeq,
  recordCommitSeq,
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
