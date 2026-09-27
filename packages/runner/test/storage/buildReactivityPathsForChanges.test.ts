import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";

import { buildReactivityPathsForChanges } from "../../src/storage/v2-transaction.ts";

/** An object of `size` keys, each holding a small record. */
const mapOfSize = (size: number, prefix = "key") => {
  const map: Record<string, { name: string }> = {};
  for (let index = 0; index < size; index++) {
    map[`${prefix}-${index}`] = { name: `${prefix}-${index}` };
  }
  return map;
};

/**
 * Builds the reactivity paths for adding `added` keys to a `size`-key object,
 * with both sides of that object behind a proxy, and reports the paths and how
 * many times the object's key set was listed.
 *
 * Listing an object's own keys is what comparing its shallow structure costs,
 * so the count is how often the object was compared. A count that tracks the
 * number of added keys is the comparison running once per key.
 */
const addingKeys = (size: number, added: number) => {
  let listings = 0;
  const counted = <T extends object>(target: T): T =>
    new Proxy(target, {
      ownKeys(target) {
        listings++;
        return Reflect.ownKeys(target);
      },
    });
  const before = mapOfSize(size);
  const after = { ...before, ...mapOfSize(added, "added") };
  const writtenPaths = Object.keys(mapOfSize(added, "added")).map((key) => [
    "value",
    key,
  ]);

  const paths = buildReactivityPathsForChanges(
    deepFreeze({ value: counted(deepFreeze(before)) }),
    { value: counted(after) },
    writtenPaths,
  );
  return { paths, listings };
};

describe("buildReactivityPathsForChanges()", () => {
  it("returns each added path and the parent whose key set grew", () => {
    const paths = buildReactivityPathsForChanges(
      { value: { a: 1 } },
      { value: { a: 1, c: 3, b: 2 } },
      [["value", "c"], ["value", "b"]],
    );

    expect(paths).toEqual([["value"], ["value", "b"], ["value", "c"]]);
  });

  it("returns each removed path and the parent whose key set shrank", () => {
    const paths = buildReactivityPathsForChanges(
      { value: { a: 1, b: 2 } },
      { value: { a: 1 } },
      [["value", "b"]],
    );

    expect(paths).toEqual([["value"], ["value", "b"]]);
  });

  it("returns a changed path without a parent whose key set held", () => {
    const paths = buildReactivityPathsForChanges(
      { value: { a: { name: "old" }, b: 2 } },
      { value: { a: { name: "new" }, b: 2 } },
      [["value", "a", "name"]],
    );

    expect(paths).toEqual([["value", "a", "name"]]);
  });

  it("returns nothing for a written path whose value ended where it began", () => {
    const paths = buildReactivityPathsForChanges(
      { value: { a: 1 } },
      { value: { a: 1 } },
      [["value", "a"]],
    );

    expect(paths).toEqual([]);
  });

  it("returns the root alone for a changed root", () => {
    const paths = buildReactivityPathsForChanges(
      { value: 1 },
      { value: 2 },
      [[]],
    );

    expect(paths).toEqual([[]]);
  });

  it("returns each path once when two written paths share it", () => {
    const paths = buildReactivityPathsForChanges(
      { value: {} },
      { value: { a: { x: 1, y: 2 } } },
      [["value", "a", "x"], ["value", "a", "y"], ["value", "a", "x"]],
    );

    expect(paths).toEqual([
      ["value"],
      ["value", "a"],
      ["value", "a", "x"],
      ["value", "a", "y"],
    ]);
  });

  it("lists a parent's keys as often for many added keys as for few", () => {
    const short = addingKeys(1000, 10);
    const long = addingKeys(1000, 100);

    expect(short.paths.length).toBe(11);
    expect(long.paths.length).toBe(101);
    // Both bounds are needed: the equality alone would hold for two counts
    // that each grew with their own number of keys, and the floor keeps a
    // probe that stopped observing the comparison from agreeing at zero.
    expect(short.listings).toBeGreaterThan(0);
    expect(long.listings).toBe(short.listings);
  });
});
