import { cell } from "commonfabric";

// FIXTURE: collections-array-of-objects
// Verifies: schema injection generates array-of-objects schema with typed items and required keys
//   cell([{id: 1, name: "Alice", ...}]) → cell([...], { type: "array", items: { type: "object", properties: {...}, required: [...] } })
export default function TestCollectionsArrayOfObjects() {
  // Array of objects
  const _arrayOfObjects = cell([
    { id: 1, name: "Alice", score: 95.5 },
    { id: 2, name: "Bob", score: 87.3 },
    { id: 3, name: "Charlie", score: 92.1 }
  ]);

  return _arrayOfObjects;
}
