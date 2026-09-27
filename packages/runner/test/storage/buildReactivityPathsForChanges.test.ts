import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { encodePointer } from "@commonfabric/memory/v2/path";

import { buildReactivityPathsForChanges } from "../../src/storage/v2-transaction.ts";
import { seededRandom, shuffled } from "../combine-order.ts";

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

  const beforeRoot = deepFreeze({ value: counted(deepFreeze(before)) });
  const afterRoot = { value: counted(after) };
  // Freezing the input above walks it through the proxy too, and is not what
  // is being counted.
  listings = 0;

  const paths = buildReactivityPathsForChanges(
    beforeRoot,
    afterRoot,
    writtenPaths,
  );
  return { paths, listings };
};

/** Keys chosen to collide, including the ones a pointer escapes. */
const KEYS = ["a", "b", "0", "~x", "x/y", ""];

/**
 * A map of up to four records, and an edit of it in which each record, on its
 * own, keeps its keys and values, changes a value, gains a key, loses one, or
 * becomes an array, along with paths written beneath it. Siblings whose key
 * sets did and did not change, beneath one parent, are what sharing an
 * ancestor's comparison has to get right.
 */
const randomChange = (random: () => number) => {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  const before: Record<string, Record<string, FabricValue>> = {};
  for (const name of KEYS.slice(0, 1 + Math.floor(random() * 4))) {
    const record: Record<string, FabricValue> = {};
    for (const key of KEYS.slice(0, 1 + Math.floor(random() * 3))) {
      record[key] = Math.floor(random() * 3);
    }
    before[name] = record;
  }
  const after: Record<string, FabricValue> = {};
  const written: string[][] = [];
  for (const [name, record] of Object.entries(before)) {
    const next: Record<string, FabricValue> = { ...record };
    const keys = Object.keys(record);
    const kind = pick(["keep", "change", "add", "remove", "array"] as const);
    if (kind === "change") next[pick(keys)] = 9;
    if (kind === "add") next["added"] = 1;
    if (kind === "remove") delete next[pick(keys)];
    after[name] = kind === "array" ? [1, 2] : next;
    for (const key of [...keys, "added"]) {
      if (random() < 0.6) written.push(["value", name, key]);
    }
    if (random() < 0.2) written.push(["value", name]);
  }
  return {
    before: deepFreeze({ value: before }),
    after: { value: after },
    written: shuffled(written, random),
  };
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

  it("returns, for many written paths, what each path alone returns, merged", () => {
    // Every ancestor's comparison is shared between the written paths beneath
    // it, so the property that sharing must keep is that the answer for a set
    // of paths is the union of the answers for each one alone, sorted as the
    // function sorts: shorter first, then by pointer.

    const random = seededRandom(8144);
    for (let run = 0; run < 3000; run++) {
      const { before, after, written } = randomChange(random);

      const alone = new Map<string, readonly string[]>();
      for (const path of written) {
        for (
          const reported of buildReactivityPathsForChanges(before, after, [
            path,
          ])
        ) {
          alone.set(encodePointer(reported), reported);
        }
      }
      const merged = [...alone.values()].sort((left, right) =>
        left.length - right.length ||
        (encodePointer(left) < encodePointer(right) ? -1 : 1)
      );

      expect(buildReactivityPathsForChanges(before, after, written))
        .toEqual(merged);
    }
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
