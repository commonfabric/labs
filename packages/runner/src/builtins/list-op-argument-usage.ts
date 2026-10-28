import type { Pattern } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";

export type ListOpArgumentUsage = {
  usesElement: boolean;
  usesIndex: boolean;
  usesArray: boolean;
  usesParams: boolean;
};

/**
 * The run-input fields a list operation fills with a link to a cell that exists
 * already: the entry, and the list it belongs to.
 */
export const LIST_OP_REFERENCED_ARGUMENT_FIELDS: readonly string[] = [
  "element",
  "array",
];

/**
 * The run-input field a list operation fills with the bindings its callback
 * captures from the enclosing pattern: a record holding a write redirect to
 * each captured cell, and any values captured beside them.
 */
export const LIST_OP_CAPTURED_ARGUMENT_FIELDS: readonly string[] = ["params"];

/**
 * The reserved callback slots `usage` reports unused, which a run leaves out
 * of a row's argument and drops from a stored argument that a run under an
 * earlier reading of the schema filled.
 */
export function unusedListOpArgumentFields(
  usage: ListOpArgumentUsage,
): readonly string[] {
  return [
    ...(usage.usesElement ? [] : ["element"]),
    ...(usage.usesIndex ? [] : ["index"]),
    ...(usage.usesArray ? [] : ["array"]),
    ...(usage.usesParams ? [] : ["params"]),
  ];
}

const usageCache = new WeakMap<object, ListOpArgumentUsage>();

/**
 * Whether the pattern's argument schema names a value at `path`. The schema
 * is read as the dialect reads it (`docs/specs/json_schema.md`, "Special
 * Handling of additionalProperties"): an object naming properties and
 * carrying no `additionalProperties` is closed to an unnamed key, and so is
 * one naming none, so a callback that never declared `index` or `array`
 * reports neither; a `false` schema at the path reports the same. Both
 * fallbacks are passed outright because `schemaAtPath` admits an unnamed key
 * by default, which other readers rely on.
 */
function hasArgumentSchema(
  pattern: Pattern,
  path: readonly string[],
): boolean {
  if (pattern.argumentSchema === undefined) return false;
  return ContextualFlowControl.schemaAtPath(
    pattern.argumentSchema,
    path,
    undefined,
    false,
    false,
  ) !== false;
}

export function inferListOpArgumentUsage(
  pattern: Pattern,
): ListOpArgumentUsage {
  const cached = usageCache.get(pattern as object);
  if (cached) return cached;

  if (pattern.argumentSchema === undefined) {
    const legacyUsage = {
      usesElement: true,
      usesIndex: true,
      usesArray: true,
      usesParams: true,
    } satisfies ListOpArgumentUsage;
    usageCache.set(pattern as object, legacyUsage);
    return legacyUsage;
  }

  const usage = {
    usesElement: hasArgumentSchema(pattern, ["element"]),
    usesIndex: hasArgumentSchema(pattern, ["index"]),
    usesArray: hasArgumentSchema(pattern, ["array"]),
    usesParams: hasArgumentSchema(pattern, ["params"]),
  } satisfies ListOpArgumentUsage;

  usageCache.set(pattern as object, usage);
  return usage;
}
