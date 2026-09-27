/**
 * Every way a patch op reports that it cannot apply to the base it is being
 * replayed over. Each report is a `PatchApplyError` whose message names the
 * JSON Pointer at fault, and the client's pending-layer replay filters on that
 * class to decide a layer must be dropped. One test per report, alongside the
 * cases where the same input shape produces a value instead.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/api";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import type { EntityDocument, PatchOp } from "../v2.ts";
import {
  applyPatch,
  applyPatchToDocument,
  PatchApplyError,
} from "../v2/patch.ts";

/**
 * Runs `apply` and returns the message of the `PatchApplyError` it raised.
 * Any other error propagates. An application that produces a value raises an
 * error naming that value, so a patch that stops reporting fails the test
 * rather than passing it.
 */
const messageOf = (apply: () => FabricValue): string => {
  let applied: FabricValue;
  try {
    applied = apply();
  } catch (error) {
    if (error instanceof PatchApplyError) {
      return error.message;
    }
    throw error;
  }
  throw new Error(`the patch applied, producing ${JSON.stringify(applied)}`);
};

/** Applies `ops` to `state`, and returns the message of the resulting report. */
const inapplicable = (state: FabricValue, ops: PatchOp[]): string =>
  messageOf(() => applyPatch(state, ops));

/**
 * The `applyPatchToDocument` counterpart of {@link inapplicable}, for the
 * reports that only the document-level entry point can make.
 */
const inapplicableToDocument = (
  base: EntityDocument | undefined,
  ops: PatchOp[],
): string => messageOf(() => applyPatchToDocument(base, ops));

describe("patch", () => {
  describe("replace", () => {
    it("throws given a missing intermediate key", () => {
      expect(inapplicable({ a: {} }, [
        { op: "replace", path: "/a/b/c", value: 1 },
      ])).toBe("missing path /a/b/c");
    });

    it("throws given an intermediate key holding a number", () => {
      expect(inapplicable({ a: { b: 5 } }, [
        { op: "replace", path: "/a/b/c", value: 1 },
      ])).toBe("path is not traversable at /a/b/c");
    });

    it("throws given a parent that is a `FabricInstance`", () => {
      const state = { a: FabricError.fromNativeError(new Error("boom")) };
      expect(inapplicable(state, [
        { op: "replace", path: "/a/b", value: 1 },
      ])).toBe("path is not traversable at /a/b");
    });

    it("throws given an array index that is not a number", () => {
      expect(inapplicable({ a: ["x"] }, [
        { op: "replace", path: "/a/x", value: 1 },
      ])).toBe("invalid array index: x");
    });

    it("throws given an array index with no element", () => {
      expect(inapplicable({ a: [] }, [
        { op: "replace", path: "/a/0", value: 1 },
      ])).toBe("missing path /a/0");
    });
  });

  describe("add", () => {
    it("returns the added value given the root path", () => {
      expect(applyPatch({ a: 1 }, [{ op: "add", path: "", value: { b: 2 } }]))
        .toEqual({ b: 2 });
    });

    it("returns the objects it created along the path", () => {
      expect(applyPatch({}, [{ op: "add", path: "/a/b/c", value: 1 }]))
        .toEqual({ a: { b: { c: 1 } } });
    });

    it("throws given an array index below a key that is being created", () => {
      expect(inapplicable({}, [
        { op: "add", path: "/a/0/b", value: 1 },
      ])).toBe("missing path /a/0/b");
    });

    it("throws given an intermediate key holding a number", () => {
      expect(inapplicable({ a: 5 }, [
        { op: "add", path: "/a/b/c", value: 1 },
      ])).toBe("path is not traversable at /a/b/c");
    });

    it("throws given an array index past the end of the array", () => {
      expect(inapplicable({ a: [] }, [
        { op: "add", path: "/a/1", value: 1 },
      ])).toBe("array index out of bounds: 1");
    });

    it("throws given an array index above the largest addressable one", () => {
      expect(inapplicable({ a: [] }, [
        { op: "add", path: "/a/4294967295", value: 1 },
      ])).toBe("array index out of bounds: 4294967295");
    });
  });

  describe("remove", () => {
    it("removes the key at the path", () => {
      expect(applyPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }]))
        .toEqual({ b: 2 });
    });

    it("throws given a key the object does not have", () => {
      expect(inapplicable({ a: {} }, [
        { op: "remove", path: "/a/b" },
      ])).toBe("missing object key at /a/b");
    });

    it("throws given the root path", () => {
      expect(inapplicable({ a: 1 }, [
        { op: "remove", path: "" },
      ])).toBe("root remove must be represented as a delete operation");
    });
  });

  describe("move", () => {
    it("throws given the root path as its source", () => {
      expect(inapplicable({ a: 1 }, [
        { op: "move", from: "", path: "/b" },
      ])).toBe("cannot move the root value");
    });

    it("throws given a destination inside its own source", () => {
      expect(inapplicable({ a: { b: 1 } }, [
        { op: "move", from: "/a", path: "/a/b" },
      ])).toBe("cannot move a value into its own descendant");
    });

    it("throws given a source that does not exist", () => {
      expect(inapplicable({ a: {} }, [
        { op: "move", from: "/a/b", path: "/c" },
      ])).toBe("missing path /a/b");
    });
  });

  describe("splice", () => {
    it("throws given a target that is not an array", () => {
      expect(inapplicable({ a: {} }, [
        { op: "splice", path: "/a", index: 0, remove: 0, add: [] },
      ])).toBe("splice target is not an array at /a");
    });

    it("throws given an index past the end of the array", () => {
      expect(inapplicable({ a: [] }, [
        { op: "splice", path: "/a", index: 1, remove: 0, add: [] },
      ])).toBe("invalid splice at /a");
    });
  });

  describe("append", () => {
    it("throws given a target that is not an array", () => {
      expect(inapplicable({ a: {} }, [
        { op: "append", path: "/a", values: [1] },
      ])).toBe("append target is not an array at /a");
    });
  });

  describe("add-unique", () => {
    it("throws given a target that is not an array", () => {
      expect(inapplicable({ a: {} }, [
        { op: "add-unique", path: "/a", values: [1] },
      ])).toBe("add-unique target is not an array at /a");
    });
  });

  describe("increment", () => {
    it("throws given the root path", () => {
      expect(inapplicable({ a: 1 }, [
        { op: "increment", path: "", by: 1 },
      ])).toBe("increment requires a non-root path");
    });

    it("throws given an amount of zero", () => {
      expect(inapplicable({ n: 1 }, [
        { op: "increment", path: "/n", by: 0 },
      ])).toBe("increment requires a finite non-zero amount at /n");
    });

    it("throws given a target that is not a number", () => {
      expect(inapplicable({ n: "x" }, [
        { op: "increment", path: "/n", by: 1 },
      ])).toBe("increment target is not a number at /n");
    });
  });

  describe("applyPatchToDocument()", () => {
    it("throws given a root replacement that is not an object", () => {
      expect(inapplicableToDocument({ a: 1 }, [
        { op: "replace", path: "", value: 5 },
      ])).toBe("patched root is not an entity document");
    });
  });
});
