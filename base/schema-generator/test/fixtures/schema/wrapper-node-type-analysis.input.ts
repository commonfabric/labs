// Tests wrapper types that might trigger node-based analysis
// This fixture specifically tests the fix for Default<T[], V> erasing to any
// and incorrectly triggering node-based analysis instead of type-based

import { Default, Cell } from "commonfabric";

interface Item {
  id: number;
  text: Default<string, "">;
}

interface SchemaRoot {
  // This was generating `true` (any schema) before the fix
  // because Default<Item[], []> erased to `any` type flag
  items: Default<Item[], []>;

  // Also test Cell with array
  cellArray: Cell<string[]>;

  // Nested Default in array
  configs: Default<{ timeout: Default<number, 30> }[], []>;
}
