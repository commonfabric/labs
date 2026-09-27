import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { IMemoryAddress } from "../../../src/storage/interface.ts";
import { planMutablePathWrite } from "../../../src/storage/transaction/mutable-path-write.ts";

const at = (path: string[]): IMemoryAddress => ({
  id: "of:mutable-path-write",
  path,
});

/** Plans a write and, where it is admitted, carries it out. */
const applyWrite = (
  ...args: Parameters<typeof planMutablePathWrite>
) => {
  const plan = planMutablePathWrite(...args);
  return plan.error ? { error: plan.error } : { ok: plan.ok.apply() };
};

/**
 * Returns a root the caller owns and edits in place, as a transaction's
 * working value is, holding a frozen list that a write would thaw and replace
 * to descend into it.
 */
const ownedRoot = () => {
  const list = Object.freeze([1]);
  return { list, root: { n: 1, list } };
};

/**
 * Builders of roots a caller owns and edits in place, each holding frozen
 * containers that a write would thaw and replace to descend through, alongside
 * the values no key addresses: a primitive, `null`, a stored `undefined`, a
 * `FabricInstance`, and a `FabricPrimitive`.
 */
const corpusRoots: (() => FabricValue)[] = [
  () => ({
    a: deepFreeze({ b: 1, x: [1, 2] }),
    b: deepFreeze([{ a: 1 }, 5]),
    x: undefined,
  }),
  () => [deepFreeze({ a: { x: 1 } }), deepFreeze([1, 2])],
  () => ({
    a: FabricError.fromNativeError(new Error("e")),
    b: new FabricBytes(new Uint8Array([1])),
    x: null,
  }),
  () => {
    const sparse: FabricValue[] = [];
    sparse[1] = deepFreeze({ a: 1 });
    return { a: sparse, b: deepFreeze([[1], { b: 2 }]) };
  },
  () => ({}),
  () => [],
];

/**
 * Every path of one to three keys drawn from `keys`, which hold an index, a
 * name, `-`, `length`, and a name every record inherits.
 */
const corpusPaths = (() => {
  const keys = ["a", "b", "0", "1", "-", "length", "toString", "x"];
  const paths: string[][] = keys.map((key) => [key]);
  for (const first of keys) {
    for (const second of keys) {
      paths.push([first, second]);
      for (const third of ["a", "0", "-", "length"]) {
        paths.push([first, second, third]);
      }
    }
  }
  return paths;
})();

/** The containers reachable from `value`, in the order a walk visits them. */
const containersIn = (value: unknown, found: object[] = []): object[] => {
  if (typeof value === "object" && value !== null) {
    found.push(value);
    for (const key of Object.keys(value)) {
      containersIn((value as Record<string, unknown>)[key], found);
    }
  }
  return found;
};

describe("mutable-path-write", () => {
  describe("planMutablePathWrite()", () => {
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

            const result = applyWrite(root, at(path), 5);

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

        const result = applyWrite(
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

          const result = applyWrite(root, at(path), undefined, {
            delete: true,
          });

          expect(result.ok?.root).toBe(root);
          expect(result.ok?.changed).toBe(false);
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

        const result = applyWrite(
          root,
          at(["list", "length"]),
          2 ** 32,
        );

        expect(result.error?.name).toBe("InvalidArrayLengthError");
        expect(root.list).toBe(list);
        expect(root).toEqual({ n: 1, list: [1] });
      });

      it("returns an `InvalidArrayLengthError` for `2 ** 32` on an array root", () => {
        const result = applyWrite([1], at(["length"]), 2 ** 32);

        expect(result.error?.name).toBe("InvalidArrayLengthError");
      });

      it("grows the array for `2 ** 32 - 0.5`, whose floor is a length an array can have", () => {
        // The array is left sparse, so growing it allocates nothing per slot.

        const result = applyWrite(
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
        const result = applyWrite(
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
        const result = applyWrite(
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
        const result = applyWrite(
          { box: {} },
          at(["box", "length"]),
          2 ** 32,
        );

        expect(result.ok?.root).toEqual({ box: { length: 2 ** 32 } });
      });
    });

    describe("what a write finds", () => {
      it("reports a slot the value only inherits as absent, with no previous value", () => {
        const plan = planMutablePathWrite(
          { value: { x: 1 } },
          at(["value", "toString"]),
          1,
        ).ok!;

        expect(plan.present).toBe(false);
        expect(plan.previousValue).toBeUndefined();
      });

      it("reports a missing root absent, for a write of the whole root and for one beneath it", () => {
        for (const path of [[], ["value", "b"]]) {
          const plan = planMutablePathWrite(undefined, at(path), 1).ok!;

          expect(plan.present).toBe(false);
          expect(plan.apply().previousActivityPresent).toBe(false);
        }
      });

      it("returns the root as where a write creating it first changes the document", () => {
        const result = planMutablePathWrite(
          undefined,
          at(["value", "b"]),
          1,
        ).ok!.apply();

        expect(result.activityPath).toEqual([]);
        expect(result.previousActivityValue).toBeUndefined();
        expect(result.root).toEqual({ value: { b: 1 } });
      });

      it("returns the deepest container already there as where a write creating missing containers first changes the document", () => {
        // `toString` is a name the record only inherits, so the write
        // creates it, and the change first shows at `value`.

        const result = planMutablePathWrite(
          { value: { x: 1 } },
          at(["value", "toString", "y"]),
          1,
        ).ok!.apply();

        expect(result.activityPath).toEqual(["value"]);
        expect(result.previousActivityPresent).toBe(true);
      });

      it("returns the value where the write first changes the document as it was, though the write changes it in place", () => {
        const root = { value: { a: 1 } };

        const result = planMutablePathWrite(
          root,
          at(["value", "b", "c"]),
          1,
        ).ok!.apply();

        expect(result.previousActivityValue).toEqual({ a: 1 });
        expect(root.value).toEqual({ a: 1, b: { c: 1 } });
      });

      it("stores `-` as a plain key of a root the write creates", () => {
        // Only a container created beneath the root is an array for `-`.

        const result = planMutablePathWrite(undefined, at(["-"]), 5).ok!
          .apply();

        expect(result.root).toEqual({ "-": 5 });
      });
    });

    describe("over a corpus of roots and paths", () => {
      // The corpus is `corpusRoots` crossed with `corpusPaths`, each path
      // written with `5`, `undefined` and `2 ** 32`, and deleted. It is
      // exhaustive over that set and says nothing past it.

      const cases = corpusRoots.flatMap((makeRoot) =>
        corpusPaths.flatMap((path) =>
          [5, undefined, 2 ** 32].map((value) => ({
            makeRoot,
            path,
            value: value as FabricValue,
            isDelete: false,
          })).concat({ makeRoot, path, value: undefined, isDelete: true })
        )
      );

      it("leaves the root as it was, identities included, for every write it refuses", () => {
        let refused = 0;
        for (const { makeRoot, path, value, isDelete } of cases) {
          const root = makeRoot();
          const before = containersIn(root);
          const snapshot = JSON.stringify(root);

          const plan = planMutablePathWrite(
            root,
            at(path),
            value,
            isDelete ? { delete: true } : undefined,
          );

          if (plan.error) {
            refused++;
            expect({ path, keys: JSON.stringify(root) }).toEqual({
              path,
              keys: snapshot,
            });
            expect(containersIn(root)).toEqual(before);
            expect(
              containersIn(root).every((container, index) =>
                container === before[index]
              ),
            ).toBe(true);
          }
        }
        // The floor keeps the case honest: a corpus that no write were
        // refused over would pass having checked nothing.
        expect(refused).toBeGreaterThan(100);
      });

      it("carries out every write it admits, and puts no key but an index on an array", () => {
        let admitted = 0;
        for (const { makeRoot, path, value, isDelete } of cases) {
          const plan = planMutablePathWrite(
            makeRoot(),
            at(path),
            value,
            isDelete ? { delete: true } : undefined,
          );
          if (plan.error) continue;
          admitted++;

          const { root } = plan.ok.apply();

          const namedKeysOnArrays = containersIn(root).filter(Array.isArray)
            .flatMap((array) =>
              Object.keys(array).filter((key) => !/^(0|[1-9]\d*)$/.test(key))
            );
          expect({ path, namedKeysOnArrays }).toEqual({
            path,
            namedKeysOnArrays: [],
          });
        }
        expect(admitted).toBeGreaterThan(100);
      });
    });
  });
});
