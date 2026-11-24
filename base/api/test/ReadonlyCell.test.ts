import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  Cell,
  ComparableCell,
  OpaqueCell,
  ReadonlyCell,
  Stream,
  Writable,
  WriteonlyCell,
} from "@commonfabric/api";

// The assertions in this file are made when it is type-checked, not when it
// runs. Each carrier below is a function that is never called: an assignment
// in it that must type-check pins a direction the types admit, and a
// `@ts-expect-error` marks one they must refuse -- if the refusal regresses,
// the directive becomes unused and the type check fails on it.

/** A value with a nested record, so that `.key()` can reach two levels. */
interface Row {
  title: string;
  meta: { count: number };
}

declare const cell: Cell<Row>;
declare const writable: Writable<Row>;
declare const readonlyCell: ReadonlyCell<Row>;
declare const widerReadonlyCell: ReadonlyCell<{ title: string }>;
declare const writeonlyCell: WriteonlyCell<Row>;
declare const comparableCell: ComparableCell<Row>;
declare const opaqueCell: OpaqueCell<Row>;
declare const stream: Stream<Row>;

/** A helper that declares the read-only cell it is passed. */
declare function titleOf(row: ReadonlyCell<Row>): string;

/** Carrier for the cells assignable to a `ReadonlyCell`. */
function admittedTypeChecks() {
  const fromCell: ReadonlyCell<Row> = cell;
  const fromWritable: ReadonlyCell<Row> = writable;
  const fromKey: ReadonlyCell<string> = cell.key("title");
  const fromTwoKeys: ReadonlyCell<number> = cell.key("meta", "count");
  const fromFor: ReadonlyCell<Row> = cell.for("cause");
  const asArgument = titleOf(cell);

  return { fromCell, fromWritable, fromKey, fromTwoKeys, fromFor, asArgument };
}

/** Carrier for the cells not assignable to a `ReadonlyCell`, and the reverse. */
function refusedTypeChecks() {
  // @ts-expect-error a `ReadonlyCell` has no `.set()`
  const toCell: Cell<Row> = readonlyCell;
  // @ts-expect-error a `ReadonlyCell` has no `.set()`
  const toWritable: Writable<Row> = readonlyCell;
  // @ts-expect-error `.key()` of a `ReadonlyCell` returns a `ReadonlyCell`
  const keyToCell: Cell<string> = readonlyCell.key("title");
  // @ts-expect-error a `ReadonlyCell` has no `.set()`
  const toWriteonly: WriteonlyCell<Row> = readonlyCell;

  // @ts-expect-error a `WriteonlyCell` has no `.get()`
  const fromWriteonly: ReadonlyCell<Row> = writeonlyCell;
  // @ts-expect-error a `ComparableCell` has no `.get()`
  const fromComparable: ReadonlyCell<Row> = comparableCell;
  // @ts-expect-error an `OpaqueCell` has no `.get()`
  const fromOpaque: ReadonlyCell<Row> = opaqueCell;
  // @ts-expect-error a `Stream` has no `.get()`
  const fromStream: ReadonlyCell<Row> = stream;

  // @ts-expect-error the value types differ
  const otherValue: ReadonlyCell<{ title: number }> = cell;

  return {
    toCell,
    toWritable,
    keyToCell,
    toWriteonly,
    fromWriteonly,
    fromComparable,
    fromOpaque,
    fromStream,
    otherValue,
  };
}

/** Carrier for the variance of a `ReadonlyCell` in its value type. */
function varianceTypeChecks() {
  const toWider: ReadonlyCell<{ title: string }> = readonlyCell;
  // @ts-expect-error a wider value type is not assignable to a narrower one
  const toNarrower: ReadonlyCell<Row> = widerReadonlyCell;

  return { toWider, toNarrower };
}

describe("ReadonlyCell", () => {
  // The type checker decides each claim; at run time only the carriers are
  // observable.

  it("is assignable from a `Cell`, a `Writable`, and a cell that `.key()` or `.for()` returns from one", () => {
    expect(typeof admittedTypeChecks).toBe("function");
  });

  it("is not assignable from a cell type that cannot be read, nor to a `Cell` or a `WriteonlyCell`", () => {
    expect(typeof refusedTypeChecks).toBe("function");
  });

  it("is covariant in its value type", () => {
    expect(typeof varianceTypeChecks).toBe("function");
  });
});
