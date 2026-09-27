import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import type { IMemoryAddress } from "../../../src/storage/interface.ts";
import { applyMutablePathWrite } from "../../../src/storage/transaction/mutable-path-write.ts";

const at = (path: string[]): IMemoryAddress => ({
  id: "of:mutable-path-write",
  path,
});

/**
 * Returns a root the caller owns and edits in place, as a transaction's
 * working value is, holding a frozen list that a write would thaw and replace
 * to descend into it.
 */
const ownedRoot = () => {
  const list = Object.freeze([1]);
  return { list, root: { n: 1, list } };
};

describe("mutable-path-write", () => {
  describe("applyMutablePathWrite()", () => {
    describe("refusing a write", () => {
      // What the write would create or thaw on its way down lands in the
      // root it was handed, so a refusal that got that far shows as a key
      // set that grew or a list that is no longer the one put there.

      const refusals: [
        path: string[],
        refusedAt: string[],
        actualType: string,
      ][] = [
        [["a", "-"], ["a", "-"], "array"],
        [["a", "-", "b"], ["a", "-"], "array"],
        [["list", "-"], ["list", "-"], "array"],
        [["list", "name", "first"], ["list", "name"], "array"],
        [["list", "length", "x"], ["list", "length"], "number"],
        [["list", "0", "x"], ["list", "0"], "number"],
        [["n", "x"], ["n"], "number"],
      ];
      for (const [path, refusedAt, actualType] of refusals) {
        it(
          `returns a \`TypeMismatchError\` for a write to \`${
            path.join("/")
          }\`, and leaves the root as it was`,
          () => {
            const { list, root } = ownedRoot();

            const result = applyMutablePathWrite(root, at(path), 5);

            expect(
              result.error?.name === "TypeMismatchError" && {
                path: result.error.address.path,
                actualType: result.error.actualType,
              },
            ).toEqual({ path: refusedAt, actualType });
            expect(Object.keys(root)).toEqual(["n", "list"]);
            expect(root.list).toBe(list);
          },
        );
      }

      it("returns a `TypeMismatchError` for a write through a null-prototype record", () => {
        // A null-prototype record is outside what a stored value may hold, and
        // the clone that would descend through one throws on it.

        const record = Object.assign(Object.create(null), { inner: {} });
        const root = { record } as FabricValue;

        const result = applyMutablePathWrite(
          root,
          at(["record", "inner", "x"]),
          5,
        );

        expect(
          result.error?.name === "TypeMismatchError" &&
            result.error.address.path,
        ).toEqual(["record"]);
        expect(Object.keys(record.inner)).toEqual([]);
      });
    });

    for (const path of [["missing", "x"], ["missing", "-"]]) {
      it(
        `returns no change for a delete of \`${
          path.join("/")
        }\` through a missing slot, and leaves the root as it was`,
        () => {
          // There is nothing to remove, and the walk says so before it reaches
          // a key it would refuse in a write.

          const { list, root } = ownedRoot();

          const result = applyMutablePathWrite(root, at(path), undefined, {
            delete: true,
          });

          expect(result.ok).toEqual({
            root,
            previousValue: undefined,
            changed: false,
          });
          expect(Object.keys(root)).toEqual(["n", "list"]);
          expect(root.list).toBe(list);
        },
      );
    }

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

      it("returns an `InvalidArrayLengthError` for `2 ** 32` on an array root", () => {
        const result = applyMutablePathWrite([1], at(["length"]), 2 ** 32);

        expect(result.error?.name).toBe("InvalidArrayLengthError");
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

      it("empties the array for a delete carrying `1`, a length it could truncate to", () => {
        const result = applyMutablePathWrite(
          { list: [1, 2] },
          at(["list", "length"]),
          1,
          { delete: true },
        );

        // `toEqual()` takes an array of holes for `[]`, so the length is what
        // shows the array was emptied rather than truncated to holes.
        expect(
          (result.ok?.root as { list: unknown[] } | undefined)?.list.length,
        ).toBe(0);
      });

      it("empties the array for a delete carrying `2 ** 32`, a length it could not grow to", () => {
        const result = applyMutablePathWrite(
          { list: [1, 2] },
          at(["list", "length"]),
          2 ** 32,
          { delete: true },
        );

        // `toEqual()` takes an array of holes for `[]`, so the length is what
        // shows the array was emptied rather than truncated to holes.
        expect(
          (result.ok?.root as { list: unknown[] } | undefined)?.list.length,
        ).toBe(0);
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
});
