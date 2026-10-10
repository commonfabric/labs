/**
 * The two special-object kinds get different treatment, and neither is the
 * object branch. A `FabricPrimitive` is a leaf and stands whole, where a walk
 * that rebuilt it from its entries would give a bare `{}`. A `FabricInstance`
 * is a container reached by its codec contents, which this walk cannot
 * descend, so it stands whole only when there is nothing inside it to convert,
 * and the walk refuses it rather than converting one wrongly otherwise.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { deepFreeze } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import {
  type Cell,
  type CellLinkInput,
  convertCellsToLinks,
} from "../src/cell.ts";

/** Whether `T` is assignable to `U`, as a type this file can assert on. */
type Assignable<T, U> = T extends U ? true : false;

// A `Cell` may sit at any depth in what a pattern produced, and replacing a
// nested one is the whole of what the conversion is for. These are compile-time
// assertions: were a nested cell to stop being assignable, each would become
// `false` and this file would not type-check. `deno task check` covers the
// runner's test tree, so CI sees them.
const _cellAtTop: Assignable<Cell<number>, CellLinkInput> = true;
const _cellInRecord: Assignable<{ x: Cell<number> }, CellLinkInput> = true;
const _cellInArray: Assignable<Cell<number>[], CellLinkInput> = true;
const _cellDeep: Assignable<{ a: { b: Cell<number>[] } }, CellLinkInput> = true;

describe("convert-cells-to-links-special-objects", () => {
  it("returns a `FabricBytes` whole rather than as an empty record", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const result = convertCellsToLinks({ x: bytes }) as { x: unknown };

    // `toBeInstanceOf` is the assertion that can fail here: a flattened `{}`
    // is `toEqual`-equal to a `FabricBytes` with no enumerable members, so
    // that matcher alone would pass against the very bug this pins.
    expect(result.x).toBeInstanceOf(FabricBytes);
    expect((result.x as FabricBytes).slice()).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("returns a JS `Uint8Array` as a whole `FabricBytes`", () => {
    // The other form that reaches the leaf branch: minted by the shallow
    // conversion on the way in rather than handed over already built.
    const result = convertCellsToLinks({
      x: new Uint8Array([4, 5]),
    }) as { x: unknown };

    expect(result.x).toBeInstanceOf(FabricBytes);
    expect((result.x as FabricBytes).slice()).toEqual(new Uint8Array([4, 5]));
  });

  it("returns a JS `Date` as a whole `FabricEpochNsec`", () => {
    const result = convertCellsToLinks({ x: new Date(1000) }) as { x: unknown };

    expect(result.x).toBeInstanceOf(FabricEpochNsec);
    expect((result.x as FabricEpochNsec).value).toBe(1_000_000_000n);
  });

  it("returns a deep-frozen `FabricInstance` holding only data whole", () => {
    const instance = deepFreeze(FabricError.fromNativeError(new Error("boom")));

    expect(convertCellsToLinks(instance)).toBe(instance);
    expect((convertCellsToLinks({ x: instance }) as { x: unknown }).x).toBe(
      instance,
    );
  });

  it("throws for a `FabricInstance` that is not deep-frozen", () => {
    // What it holds may still change, or may not be fabric data yet, so there
    // is no telling that nothing inside it needs converting.
    const instance = FabricError.fromNativeError(new Error("boom"));

    expect(() => convertCellsToLinks({ x: instance })).toThrow(
      "Cannot yet handle `FabricError` (a `FabricInstance`) when converting " +
        "cells to links.",
    );
  });

  it("throws for a `FabricInstance` holding a link", () => {
    const instance = deepFreeze(
      new FabricError({
        type: "Error",
        message: "boom",
        stack: undefined,
        cause: linkRefFrom({ id: "of:fid1:linked", path: [] }),
      }),
    );

    expect(() => convertCellsToLinks({ x: instance })).toThrow(
      "Cannot yet handle `FabricError` (a `FabricInstance`) when converting " +
        "cells to links.",
    );
  });

  it("returns a JS `Error` as the `FabricError` the conversion mints", () => {
    // The other way in: the shallow conversion turns a JS `Error` into a
    // `FabricError` on the way past, and an error holding nothing but its
    // strings mints deep-frozen.
    const result = convertCellsToLinks({ x: new TypeError("nope") }) as {
      x: unknown;
    };

    expect(result.x).toBeInstanceOf(FabricError);
    expect((result.x as FabricError).message).toBe("nope");
  });

  it("throws for a JS `Error` whose `cause` the mint leaves unconverted", () => {
    // A shallow mint converts one layer, so the `cause` is still the record it
    // was given, and the walk cannot reach it to convert it.
    expect(() =>
      convertCellsToLinks({ x: new Error("nope", { cause: { k: 1 } }) })
    ).toThrow(
      "Cannot yet handle `FabricError` (a `FabricInstance`) when converting " +
        "cells to links.",
    );
  });

  it("returns a `FabricPrimitive` reachable twice at both positions", () => {
    // The leaf branch exits without descending, and every such exit must still
    // clear the ancestor it recorded. One that did not would leave the value an
    // ancestor for the rest of the walk, and the second position holding it
    // would come back a back-link to the first.
    const shared = new FabricBytes(new Uint8Array([7]));
    const result = convertCellsToLinks({ a: shared, b: shared }) as {
      a: unknown;
      b: unknown;
    };

    expect(result.a).toBeInstanceOf(FabricBytes);
    expect(result.b).toBeInstanceOf(FabricBytes);
  });
});
