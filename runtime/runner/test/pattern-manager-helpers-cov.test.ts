import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SourceDoc } from "../src/compilation-cache/cell-cache.ts";
import {
  fabricImportRefsFromSource,
  throwableStorageError,
  uniqueCacheableImports,
} from "../src/pattern-manager.ts";
import type {
  IPreconditionFailedError,
  IStorageTransactionAborted,
} from "../src/storage/interface.ts";

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);

describe("pattern-manager", () => {
  describe("throwableStorageError()", () => {
    it("returns an error that is already an `Error` unchanged", () => {
      const error = Object.assign(new Error("already committed"), {
        name: "PreconditionFailedError" as const,
        precondition: "receipt-exists" as const,
      }) satisfies IPreconditionFailedError;

      expect(throwableStorageError(error)).toBe(error);
    });

    it("returns a new `Error` naming a plain error object as its cause", () => {
      const error: IStorageTransactionAborted = {
        name: "StorageTransactionAborted",
        message: "the action threw",
        reason: "boom",
      };

      const thrown = throwableStorageError(error);

      expect(thrown).not.toBe(error);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toBe("the action threw");
      expect(thrown.name).toBe("StorageTransactionAborted");
      expect(thrown.cause).toBe(error);
    });
  });

  describe("fabricImportRefsFromSource()", () => {
    // The attested list is consulted in place of a parse, so the document's
    // code plays no part.
    const doc: SourceDoc = {
      kind: "source",
      code: "",
      filename: "/main.tsx",
      imports: [],
    };

    it("returns one edge per pinned fabric specifier and target, in order", () => {
      expect(
        fabricImportRefsFromSource(doc, [
          `cf:pattern:${HASH_A}`,
          `cf:helper@${HASH_B}`,
          `cf:pattern:${HASH_A}`,
          `cf:helper@${HASH_B}`,
        ]),
      ).toEqual([
        { specifier: `cf:pattern:${HASH_A}`, targetIdentity: HASH_A },
        { specifier: `cf:helper@${HASH_B}`, targetIdentity: HASH_B },
      ]);
    });

    it("returns no edge for a specifier that is not a fabric import", () => {
      expect(
        fabricImportRefsFromSource(doc, ["commonfabric", "./util.ts"]),
      ).toEqual([]);
    });

    it("returns no edge for a fabric specifier that does not parse", () => {
      expect(
        fabricImportRefsFromSource(doc, [
          "cf:module/internal",
          "cf:pattern:short",
        ]),
      ).toEqual([]);
    });

    it("returns no edge for an unpinned fabric specifier", () => {
      expect(fabricImportRefsFromSource(doc, ["cf:helper"])).toEqual([]);
      expect(fabricImportRefsFromSource(doc, [`cf:helper@${HASH_A}`]))
        .toEqual([{
          specifier: `cf:helper@${HASH_A}`,
          targetIdentity: HASH_A,
        }]);
    });
  });

  describe("uniqueCacheableImports()", () => {
    it("returns the first of each specifier and target pair, in order", () => {
      expect(
        uniqueCacheableImports([
          { specifier: "./a.ts", targetIdentity: HASH_A },
          { specifier: "./b.ts", targetIdentity: HASH_B },
          { specifier: "./a.ts", targetIdentity: HASH_A },
        ]),
      ).toEqual([
        { specifier: "./a.ts", targetIdentity: HASH_A },
        { specifier: "./b.ts", targetIdentity: HASH_B },
      ]);
    });

    it("keeps one specifier imported from two targets, and one target imported by two specifiers", () => {
      const imports = [
        { specifier: "./a.ts", targetIdentity: HASH_A },
        { specifier: "./a.ts", targetIdentity: HASH_B },
        { specifier: "./b.ts", targetIdentity: HASH_A },
      ];

      expect(uniqueCacheableImports(imports)).toEqual(imports);
    });
  });
});
