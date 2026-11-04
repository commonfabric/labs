// Tests Default<T | undefined, V> with Option B semantics
// Properties with T | undefined should NOT be in required array

import { Default } from "commonfabric";

interface SchemaRoot {
  // Property with undefined union - should be optional
  maybeTitle: Default<string | undefined, "untitled">;

  // Regular Default without undefined - should be required
  requiredTitle: Default<string, "required">;

  // undefined union with complex default
  maybeCount: Default<number | undefined, 42>;
}
