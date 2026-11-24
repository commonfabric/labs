import { cell } from "commonfabric";

// FIXTURE: collections-nested-objects
// Verifies: deeply nested object literals produce recursively nested object schemas
//   cell({ user: { address: { street, city } }, timestamp }) → cell(..., { type: "object", properties: { user: { type: "object", properties: { address: { type: "object", ... } } } } })
export default function TestCollectionsNestedObjects() {
  // Nested objects
  const _nested = cell({
    user: {
      name: "Alice",
      age: 30,
      address: {
        street: "123 Main St",
        city: "NYC"
      }
    },
    timestamp: 1234567890
  });

  return _nested;
}
