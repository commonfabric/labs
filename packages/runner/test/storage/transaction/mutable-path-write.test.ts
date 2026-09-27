import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { IMemoryAddress } from "../../../src/storage/interface.ts";
import { applyMutablePathWrite } from "../../../src/storage/transaction/mutable-path-write.ts";

const at = (path: string[]): IMemoryAddress => ({
  id: "of:mutable-path-write",
  path,
});

describe("applyMutablePathWrite()", () => {
  describe("an array `length`", () => {
    it("returns an `InvalidArrayLengthError` for `2 ** 32`, and leaves an owned root's spine as it was", () => {
      // The root is one the caller owns and edits in place, as a
      // transaction's working value is, so a write that descended to `list`
      // would thaw it by replacing it with a mutable copy.

      const list = Object.freeze([1]);
      const root = { n: 1, list };

      const result = applyMutablePathWrite(
        root,
        at(["list", "length"]),
        2 ** 32,
      );

      expect(result.error?.name).toBe("InvalidArrayLengthError");
      expect(root.list).toBe(list);
      expect(root).toEqual({ n: 1, list: [1] });
    });

    it("grows the array for `2 ** 32 - 0.5`, whose floor is a length an array can have", () => {
      // The array is left sparse, so growing it allocates nothing per slot.

      const result = applyMutablePathWrite(
        { list: [1] },
        at(["list", "length"]),
        2 ** 32 - 0.5,
      );

      expect(result.error).toBeUndefined();
      expect(result.ok?.changed).toBe(true);
      expect(
        (result.ok?.root as { list: unknown[] } | undefined)?.list.length,
      ).toBe(2 ** 32 - 1);
    });

    it("stores `2 ** 32` as an ordinary value where the parent is an object", () => {
      const result = applyMutablePathWrite(
        { box: {} },
        at(["box", "length"]),
        2 ** 32,
      );

      expect(result.ok?.root).toEqual({ box: { length: 2 ** 32 } });
    });
  });
});
