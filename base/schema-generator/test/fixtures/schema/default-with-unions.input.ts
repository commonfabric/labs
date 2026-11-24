// Tests Default<T, V> where T is a union (non-undefined)
// These should preserve union types in anyOf

import { Default } from "commonfabric";

interface SchemaRoot {
  // Union with null
  status: Default<"active" | "inactive" | null, "active">;

  // Union of primitives
  value: Default<string | number, 42>;

  // Union of complex types
  data: Default<{ text: string } | { count: number }, { text: "default" }>;
}
