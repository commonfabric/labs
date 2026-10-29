import { cell } from "commonfabric";

// FIXTURE: literal-widen-null-undefined
// Verifies: null and undefined literals produce their respective type schemas
//   cell(null) → cell(null, { type: "null" })
//   cell(undefined) → cell(undefined, { type: "undefined" })
export default function TestLiteralWidenNullUndefined() {
  const _c1 = cell(null);
  const _c2 = cell(undefined);

  return null;
}
