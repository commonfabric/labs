import { Cell, cell, ComparableCell } from "commonfabric";

// FIXTURE: cell-of-no-value
// Verifies: new Cell/cell with type arg but no value injects undefined as first arg plus schema
//   new Cell<string>() → new Cell<string>(undefined, { type: "string" })
//   cell<string>() → cell<string>(undefined, { type: "string" })
//   new ComparableCell<{ name: string }>() → new ComparableCell<...>(undefined, { type: "object", ... })
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
export default function TestCellOfNoValue() {
  // new Cell with type argument but no value - should become new Cell(undefined, schema)
  const _c1 = new Cell<string>();
  const _c2 = new Cell<number>();
  const _c3 = new Cell<boolean>();

  // cell() with type argument but no value - should become cell(undefined, schema)
  const _c4 = cell<string>();

  // new ComparableCell with type argument but no value
  const _c5 = new ComparableCell<{ name: string }>();

  // Mixed - some with value, some without
  const _c6 = new Cell<string>("hello"); // has value
  const _c7 = new Cell<number>(); // no value

  return null;
}
