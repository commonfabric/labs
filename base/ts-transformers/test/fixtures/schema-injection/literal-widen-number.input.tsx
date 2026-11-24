import { cell } from "commonfabric";

// FIXTURE: literal-widen-number
// Verifies: numeric literals (int, negative, float, scientific, zero) are all widened to { type: "number" }
//   cell(10) → cell(10, { type: "number" })
//   cell(-5) → cell(-5, { type: "number" })
//   cell(3.14) → cell(3.14, { type: "number" })
//   cell(1e10) → cell(1e10, { type: "number" })
//   cell(0) → cell(0, { type: "number" })
export default function TestLiteralWidenNumber() {
  const _n1 = cell(10);
  const _n2 = cell(-5);
  const _n3 = cell(3.14);
  const _n4 = cell(1e10);
  const _n5 = cell(0);

  return null;
}
