import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commonfabric";

// FIXTURE: cell-like-classes
// Verifies: schema injection works for cell(), new ComparableCell(), new ReadonlyCell(), and new WriteonlyCell()
//   cell(100) → cell(100, { type: "number" })
//   new ComparableCell(200) → new ComparableCell(200, { type: "number" })
//   new ReadonlyCell(300) → new ReadonlyCell(300, { type: "number" })
//   new WriteonlyCell(400) → new WriteonlyCell(400, { type: "number" })
export default function TestCellLikeClasses() {
  // Standalone cell() function
  const _standalone = cell(100);

  // new ComparableCell()
  const _comparable = new ComparableCell(200);

  // new ReadonlyCell()
  const _readonly = new ReadonlyCell(300);

  // new WriteonlyCell()
  const _writeonly = new WriteonlyCell(400);

  return {
    standalone: _standalone,
    comparable: _comparable,
    readonly: _readonly,
    writeonly: _writeonly,
  };
}
