/**
 * Discovery-tag utilities for JSONSchema values.
 */

import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Schema keywords whose values are themselves schemas (or collections of
 * schemas). Used to walk the schema tree without descending into data
 * positions such as `default` or `examples`.
 */
const SCHEMA_CHILD_KEYWORDS = [
  "properties",
  "additionalProperties",
  "items",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "contentSchema",
  "$defs",
  "definitions",
] as const;

const RECORD_VALUED_KEYWORDS = new Set<string>([
  "properties",
  "$defs",
  "definitions",
]);

/**
 * Collect the discovery tags of a schema.
 *
 * Reads the structured `tags` fields emitted by the schema generator,
 * aggregated across the schema tree (root and nested schemas), lowercased
 * and deduplicated.
 */
export function tagsFromSchema(
  schema: JSONSchema | undefined | null,
): string[] {
  if (!isObjectOrArray(schema)) return [];

  const tags: string[] = [];
  const visited = new Set<object>();

  const visit = (node: unknown): void => {
    if (!isObjectNotArray(node)) {
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.tags)) {
      for (const tag of record.tags) {
        if (typeof tag !== "string") continue;
        const lowered = tag.toLowerCase();
        if (!tags.includes(lowered)) tags.push(lowered);
      }
    }

    for (const keyword of SCHEMA_CHILD_KEYWORDS) {
      const child = record[keyword];
      if (!isObjectOrArray(child)) continue;
      if (Array.isArray(child)) {
        for (const entry of child) visit(entry);
      } else if (RECORD_VALUED_KEYWORDS.has(keyword)) {
        for (const value of Object.values(child)) visit(value);
      } else {
        visit(child);
      }
    }
  };

  visit(schema);
  return tags;
}
