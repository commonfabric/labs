import type { JSONSchema } from "@commonfabric/api";

import { hashStringOf } from "@commonfabric/data-model";

/**
 * Computes a deterministic hash of a JSONSchema. Structurally-equal schemas
 * always produce the same hash. Returns a string for use as a map key or cache
 * key. This accepts `undefined` as a convenience for contexts where that value
 * is useful to mean "no relevant schema," or "missing schema," and so on.
 *
 * This function is a pass-through to `hashStringOf()`, just with a narrower
 * argument type.
 */
export function hashSchema(schema: JSONSchema | undefined): string {
  return hashStringOf(schema);
}
