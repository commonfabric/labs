import { cell } from "commonfabric";

const existingSchema = { type: "number" } as const;

// FIXTURE: double-inject-already-has-schema
// Verifies: cell() calls that already have a schema argument are NOT double-injected
//   cell(10, existingSchema) → cell(10, existingSchema)  (unchanged)
//   cell("hello", { type: "string" }) → cell("hello", { type: "string" })  (unchanged)
// Context: negative test -- transformer must skip calls that already have two arguments
export default function TestDoubleInjectAlreadyHasSchema() {
  // Should NOT transform - already has 2 arguments
  const _c1 = cell(10, existingSchema);
  const _c2 = cell("hello", { type: "string" });
  const _c3 = cell(true, { type: "boolean" } as const);

  return null;
}
