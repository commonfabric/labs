// Tests Default<T, V> with complex default values
// Arrays, objects, nested structures

import { Default } from "commonfabric";

interface Config {
  timeout: number;
  retries: number;
}

interface SchemaRoot {
  // Object default
  config: Default<Config, { timeout: 30, retries: 3 }>;

  // Array default
  tags: Default<string[], ["default", "tags"]>;

  // Nested array of objects
  items: Default<{ id: number; name: string }[], []>;

  // Record/map type
  metadata: Default<Record<string, number>, Record<string, never>>;
}
