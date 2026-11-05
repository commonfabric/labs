import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  Cell,
  JSONObject,
  PatternFactory,
  Writable,
} from "@commonfabric/api";

type Row = { score: number };
type RowCallbackInput = {
  element: Row;
  index: number;
  array: Row[];
};

function checkReceivers(
  numbers: Cell<number[]>,
  rows: Writable<Row[]>,
  object: Cell<JSONObject>,
  strings: Cell<string[]>,
  predicate: PatternFactory<RowCallbackInput, boolean>,
  score: PatternFactory<RowCallbackInput, number>,
) {
  const totals: number[] = [
    numbers.sum(),
    numbers.min(),
    numbers.max(),
    rows.count(),
    rows.count((row) => row.score > 0),
    rows.countWithPattern(predicate),
  ];
  const winners: (Row | undefined)[] = [
    rows.minBy((row) => row.score),
    rows.maxBy((row) => row.score),
    rows.minByWithPattern(score),
    rows.maxByWithPattern(score),
  ];
  // @ts-expect-error Aggregate receivers must contain arrays.
  object.count();
  // @ts-expect-error Aggregate receivers must contain arrays.
  object.countWithPattern(predicate);
  // @ts-expect-error Numeric aggregates require numeric arrays.
  object.sum();
  // @ts-expect-error Numeric aggregates require numeric arrays.
  strings.sum();
  // @ts-expect-error Numeric aggregates require numeric arrays.
  strings.min();
  // @ts-expect-error Numeric aggregates require numeric arrays.
  strings.max();
  // @ts-expect-error Score selectors require array receivers.
  object.minBy(() => 1);
  // @ts-expect-error Score selectors require array receivers.
  object.maxBy(() => 1);
  // @ts-expect-error Score patterns require array receivers.
  object.minByWithPattern(score);
  // @ts-expect-error Score patterns require array receivers.
  object.maxByWithPattern(score);
  // @ts-expect-error Captures are bound in the factory, never passed as sibling params.
  rows.countWithPattern(predicate, {});
  return { totals, winners };
}

describe("aggregate types", () => {
  it("checks receiver constraints and result types at compile time", () => {
    expect(typeof checkReceivers).toBe("function");
  });
});
