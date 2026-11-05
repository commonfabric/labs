import { cell } from "commonfabric";

// FIXTURE: literal-widen-array-elements
// Verifies: array literals produce { type: "array", items: { type: T } } with widened element types
//   cell([1, 2, 3]) → cell([...], { type: "array", items: { type: "number" } })
//   cell(["a", "b"]) → cell([...], { type: "array", items: { type: "string" } })
//   cell([true, false]) → cell([...], { type: "array", items: { type: "boolean" } })
export default function TestLiteralWidenArrayElements() {
  const _arr1 = cell([1, 2, 3]);
  const _arr2 = cell(["a", "b", "c"]);
  const _arr3 = cell([true, false]);

  return null;
}
