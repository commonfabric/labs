/**
 * The contract the makers in `for-testing-only.ts` keep, which tests elsewhere
 * rest on without checking: a new object per call, equal objects from one
 * maker, unequal objects from two makers of one class. Nothing here names a
 * class it does not have to. Each case ranges over the tables themselves.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
} from "@/for-testing-only.ts";
import { fabricAwareEqual } from "@/index.ts";

/** Every table of makers, labeled for the test names. */
const MAKER_TABLES: ReadonlyArray<
  [string, Readonly<Record<string, readonly (() => unknown)[]>>]
> = [
  [
    "FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY",
    FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  ],
  [
    "FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY",
    FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  ],
];

/**
 * The classes whose codecs are stubs. Comparing two of one hashes them, which
 * a stub codec refuses, so their makers are held to the contract's first
 * clause alone.
 */
const STUB_CODEC_CLASSES: ReadonlySet<string> = new Set([
  "FabricMap",
  "FabricSet",
]);

describe("for-testing-only", () => {
  for (const [tableName, table] of MAKER_TABLES) {
    describe(tableName, () => {
      it("is frozen, as is each class's tuple of makers", () => {
        expect(Object.isFrozen(table)).toBe(true);
        for (const makers of Object.values(table)) {
          expect(Object.isFrozen(makers)).toBe(true);
        }
      });

      for (const [name, makers] of Object.entries(table)) {
        describe(name, () => {
          it("holds makers that each return an instance of the class the entry is named for", () => {
            for (const make of makers) {
              expect((make() as object).constructor.name).toBe(name);
            }
          });

          it("holds makers that each return a new object on every call", () => {
            for (const make of makers) {
              expect(make()).not.toBe(make());
            }
          });

          if (STUB_CODEC_CLASSES.has(name)) {
            it("holds makers whose results cannot be compared, the class's codec being a stub", () => {
              // What excuses the class from the two cases its siblings get.
              // Once the comparison stops throwing, this fails, and the class
              // comes out of `STUB_CODEC_CLASSES`.

              for (const make of makers) {
                expect(() => fabricAwareEqual(make(), make())).toThrow();
              }
            });
          } else {
            it("holds makers whose own results are equal to each other", () => {
              for (const make of makers) {
                expect(fabricAwareEqual(make(), make())).toBe(true);
              }
            });

            it("holds no two makers whose results are equal", () => {
              for (const [index, make] of makers.entries()) {
                for (const other of makers.slice(index + 1)) {
                  expect(fabricAwareEqual(make(), other())).toBe(false);
                }
              }
            });
          }
        });
      }
    });
  }

  describe("FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY", () => {
    it("is frozen, as is each class's tuple of examples", () => {
      expect(Object.isFrozen(FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY))
        .toBe(true);
      for (
        const examples of Object.values(
          FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
        )
      ) {
        expect(Object.isFrozen(examples)).toBe(true);
      }
    });

    it("holds, for each maker of each class, one example equal to what that maker returns", () => {
      const examples: Readonly<Record<string, readonly unknown[]>> =
        FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY;
      for (
        const [name, makers] of Object.entries(
          FABRIC_PRIMITIVE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
        )
      ) {
        expect(examples[name]?.length).toBe(makers.length);
        for (const [index, make] of makers.entries()) {
          expect(fabricAwareEqual(examples[name]?.[index], make())).toBe(true);
        }
      }
    });
  });
});
