/**
 * Discovery-tag utilities for JSONSchema values.
 */

import type { JSONSchema } from "@commonfabric/api";
import { extractHashtags } from "@commonfabric/utils/hashtags";
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
 * Extracts hashtags from schema descriptions,
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
    if (typeof record.description === "string") {
      for (const tag of extractHashtags(record.description)) {
        if (!tags.includes(tag)) tags.push(tag);
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
