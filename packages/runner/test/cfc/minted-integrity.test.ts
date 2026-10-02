import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";

import {
  type IntegrityMint,
  isValueStamp,
  mintedEntryReached,
  reconcileMintedEntries,
} from "../../src/cfc/minted-integrity.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";

const STAMP: CfcAtom = { type: "https://example.com/atom/Stamp" };
const OTHER: CfcAtom = { type: "https://example.com/atom/Other" };

const REFERENCE = { "/": { "link@1": { id: "of:element", path: [] } } };

const minted = (
  path: readonly string[],
  ...integrity: CfcAtom[]
): LabelMapEntry => ({ path, label: { integrity }, origin: "minted" });

const mint = (path: readonly string[], ...integrity: CfcAtom[]) =>
  ({ path, integrity }) satisfies IntegrityMint;

/**
 * Reconciles for a transaction that changed every path it wrote, which is the
 * common case; `attemptedPaths` is given only where the two differ.
 */
const reconcile = (input: {
  existing?: LabelMapEntry[];
  mints?: IntegrityMint[];
  changedPaths?: string[][];
  attemptedPaths?: string[][];
  value?: unknown;
}): LabelMapEntry[] =>
  reconcileMintedEntries({
    existing: input.existing ?? [],
    mints: input.mints ?? [],
    changedPaths: input.changedPaths ?? [],
    attemptedPaths: input.attemptedPaths ?? input.changedPaths ?? [],
    value: () => input.value as FabricValue | undefined,
  });

describe("minted-integrity", () => {
  describe("reconcileMintedEntries()", () => {
    it("returns no entries when nothing is stored and nothing is minted", () => {
      expect(reconcile({ changedPaths: [["note"]], value: { note: "a" } }))
        .toEqual([]);
    });

    describe("a stored entry at a concrete path", () => {
      const existing = [minted(["card", "note"], STAMP)];
      const value = { card: { note: { text: "a" } }, other: 1 };

      it("is kept when the transaction changed another part of the document", () => {
        expect(reconcile({ existing, changedPaths: [["other"]], value }))
          .toEqual(existing);
      });

      it("is dropped when the transaction changed the value at its path", () => {
        expect(reconcile({ existing, changedPaths: [["card", "note"]], value }))
          .toEqual([]);
      });

      it("is dropped when the transaction changed a value above its path", () => {
        expect(reconcile({ existing, changedPaths: [["card"]], value }))
          .toEqual([]);
      });

      it("is dropped when the transaction changed a value below its path", () => {
        expect(
          reconcile({
            existing,
            changedPaths: [["card", "note", "text"]],
            value,
          }),
        ).toEqual([]);
      });

      it("is kept when the transaction rewrote its value unchanged", () => {
        expect(
          reconcile({
            existing,
            changedPaths: [],
            attemptedPaths: [["card", "note"]],
            value,
          }),
        ).toEqual(existing);
      });

      it("is kept when what changed below its path is stamped with the same atoms", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["card", "note", "text"], STAMP)],
            changedPaths: [["card", "note", "text"]],
            value,
          }),
        ).toEqual([
          minted(["card", "note"], STAMP),
          minted(["card", "note", "text"], STAMP),
        ]);
      });

      it("keeps only the atoms that what changed below its path is stamped with", () => {
        expect(
          reconcile({
            existing: [minted(["card", "note"], STAMP, OTHER)],
            mints: [mint(["card", "note", "text"], OTHER)],
            changedPaths: [["card", "note", "text"]],
            value,
          }),
        ).toEqual([
          minted(["card", "note"], OTHER),
          minted(["card", "note", "text"], OTHER),
        ]);
      });

      it("is dropped when one of two changes below its path is unstamped", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["card", "note", "text"], STAMP)],
            changedPaths: [["card", "note", "text"], ["card", "note", "by"]],
            value: { card: { note: { text: "a", by: "b" } } },
          }),
        ).toEqual([minted(["card", "note", "text"], STAMP)]);
      });

      it("is dropped when its position is left holding a reference", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["card"], STAMP)],
            changedPaths: [["card", "note"]],
            value: { card: { note: REFERENCE } },
          }),
        ).toEqual([minted(["card"], STAMP)]);
      });

      it("is dropped when a change elsewhere left its position holding nothing", () => {
        expect(
          reconcile({
            existing: [minted(["list", "2"], STAMP)],
            changedPaths: [["list", "0"], ["list", "1"], ["list", "length"]],
            value: { list: ["b", "c"] },
          }),
        ).toEqual([]);
      });

      it("is kept when the changing transaction mints the same atoms there", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["card", "note"], STAMP)],
            changedPaths: [["card", "note", "text"]],
            value,
          }),
        ).toEqual(existing);
      });
    });

    describe("a mint at a concrete path", () => {
      it("stamps the value when the transaction wrote it", () => {
        expect(
          reconcile({
            mints: [mint(["note"], STAMP)],
            changedPaths: [["note"]],
            value: { note: "a" },
          }),
        ).toEqual([minted(["note"], STAMP)]);
      });

      it("stamps the value when the transaction wrote inside it", () => {
        expect(
          reconcile({
            mints: [mint(["note"], STAMP)],
            changedPaths: [["note", "text"]],
            value: { note: { text: "a" } },
          }),
        ).toEqual([minted(["note"], STAMP)]);
      });

      it("stamps nothing when the transaction wrote elsewhere", () => {
        expect(
          reconcile({
            mints: [mint(["note"], STAMP)],
            changedPaths: [["other"]],
            value: { note: "a", other: 1 },
          }),
        ).toEqual([]);
      });

      it("stamps nothing where the transaction left no value", () => {
        expect(
          reconcile({
            mints: [mint(["note"], STAMP)],
            changedPaths: [["note"]],
            value: {},
          }),
        ).toEqual([]);
      });

      it("stamps nothing at a position holding a reference", () => {
        expect(
          reconcile({
            mints: [mint(["note"], STAMP)],
            changedPaths: [["note"]],
            value: { note: REFERENCE },
          }),
        ).toEqual([]);
      });
    });

    describe("a mint through a `*` path", () => {
      it("is stored at the `*` path when it reaches every element", () => {
        expect(
          reconcile({
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list"]],
            value: { list: ["a", "b"] },
          }),
        ).toEqual([minted(["list", "*"], STAMP)]);
      });

      it("is stored at the written element when the list holds unstamped elements", () => {
        expect(
          reconcile({
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list", "1"], ["list", "length"]],
            value: { list: ["a", "b"] },
          }),
        ).toEqual([minted(["list", "1"], STAMP)]);
      });

      it("is stored at the written element when another element is a reference", () => {
        expect(
          reconcile({
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list"]],
            value: { list: [REFERENCE, "b"] },
          }),
        ).toEqual([minted(["list", "1"], STAMP)]);
      });

      it("stamps each entry of a record", () => {
        expect(
          reconcile({
            mints: [mint(["byName", "*"], STAMP)],
            changedPaths: [["byName"]],
            value: { byName: { a: 1, b: 2 } },
          }),
        ).toEqual([minted(["byName", "*"], STAMP)]);
      });

      it("stamps nothing under an array's `length`", () => {
        expect(
          reconcile({
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list", "length"]],
            value: { list: ["a"] },
          }),
        ).toEqual([]);
      });
    });

    describe("a stored `*` entry", () => {
      const existing = [minted(["list", "*"], STAMP)];

      it("is kept when an element is appended with the same atoms", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list", "2"], ["list", "length"]],
            value: { list: ["a", "b", "c"] },
          }),
        ).toEqual(existing);
      });

      it("is kept when the transaction changed nothing it matches", () => {
        expect(
          reconcile({
            existing,
            changedPaths: [["list", "length"]],
            value: { list: ["a"] },
          }),
        ).toEqual(existing);
      });

      it("becomes per-element entries when an element is appended without the atoms", () => {
        expect(
          reconcile({
            existing,
            changedPaths: [["list", "2"], ["list", "length"]],
            value: { list: ["a", "b", "c"] },
          }),
        ).toEqual([minted(["list", "0"], STAMP), minted(["list", "1"], STAMP)]);
      });

      it("becomes per-element entries when a reference is appended", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["list", "*"], STAMP)],
            changedPaths: [["list", "1"], ["list", "length"]],
            value: { list: ["a", REFERENCE] },
          }),
        ).toEqual([minted(["list", "0"], STAMP)]);
      });

      it("is kept when part of an element changes under a stamp with the same atoms", () => {
        expect(
          reconcile({
            existing: [minted(["rows", "*"], STAMP)],
            mints: [mint(["rows", "*", "text"], STAMP)],
            changedPaths: [["rows", "0", "text"]],
            value: { rows: [{ text: "a" }, { text: "b" }] },
          }),
        ).toEqual([
          minted(["rows", "*"], STAMP),
          minted(["rows", "0", "text"], STAMP),
        ]);
      });

      it("becomes per-element entries when part of an element changes unstamped", () => {
        expect(
          reconcile({
            existing: [minted(["rows", "*"], STAMP)],
            changedPaths: [["rows", "0", "text"]],
            value: { rows: [{ text: "a" }, { text: "b" }] },
          }),
        ).toEqual([minted(["rows", "1"], STAMP)]);
      });

      it("is dropped when the whole list is replaced without the atoms", () => {
        expect(
          reconcile({
            existing,
            changedPaths: [["list"]],
            value: { list: ["x", "y"] },
          }),
        ).toEqual([]);
      });

      it("gains a per-element entry for atoms it does not state", () => {
        expect(
          reconcile({
            existing,
            mints: [mint(["list", "*"], STAMP, OTHER)],
            changedPaths: [["list", "1"], ["list", "length"]],
            value: { list: ["a", "b"] },
          }),
        ).toEqual([
          minted(["list", "*"], STAMP),
          minted(["list", "1"], STAMP, OTHER),
        ]);
      });
    });
  });

  describe("isValueStamp()", () => {
    it("returns `true` for an atom that is not a principal claim", () => {
      expect(isValueStamp(STAMP)).toBe(true);
      expect(isValueStamp("tasted")).toBe(true);
    });

    it("returns `false` for a principal claim", () => {
      expect(
        isValueStamp({ kind: "represents-principal", subject: "did:key:a" }),
      ).toBe(false);
      expect(isValueStamp({ kind: "authored-by", subject: "did:key:a" }))
        .toBe(false);
    });
  });

  describe("mintedEntryReached()", () => {
    it("returns `true` for a change at, above or below a concrete entry", () => {
      expect(mintedEntryReached(["a", "b"], [["a", "b"]])).toBe(true);
      expect(mintedEntryReached(["a", "b"], [["a"]])).toBe(true);
      expect(mintedEntryReached(["a", "b"], [["a", "b", "c"]])).toBe(true);
    });

    it("returns `false` for a change beside a concrete entry", () => {
      expect(mintedEntryReached(["a", "b"], [["a", "c"], ["d"]])).toBe(false);
    });

    it("returns `true` for a change inside a `*` entry's container", () => {
      expect(mintedEntryReached(["list", "*"], [["list", "3"]])).toBe(true);
      expect(mintedEntryReached(["list", "*"], [["list"]])).toBe(true);
    });

    it("returns `false` for a change outside a `*` entry's container", () => {
      expect(mintedEntryReached(["list", "*"], [["other", "3"]])).toBe(false);
    });
  });
});
