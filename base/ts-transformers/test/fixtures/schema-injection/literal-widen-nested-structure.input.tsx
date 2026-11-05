import { cell } from "commonfabric";

// FIXTURE: literal-widen-nested-structure
// Verifies: nested object+array literal produces a fully recursive schema with widened leaf types
//   cell({ users: [{id, name, active}], count }) → cell(..., { type: "object", properties: { users: { type: "array", items: { type: "object", ... } }, count: { type: "number" } } })
export default function TestLiteralWidenNestedStructure() {
  const _nested = cell({
    users: [
      { id: 1, name: "Alice", active: true },
      { id: 2, name: "Bob", active: false }
    ],
    count: 2
  });

  return null;
}
