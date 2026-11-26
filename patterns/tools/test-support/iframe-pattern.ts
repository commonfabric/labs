/**
 * Reads an iframe pattern's view in a pattern test: the resources the one
 * `cf-iframe` it renders hands its guest, and values compared by content.
 */

import { findElement, propValue, readValue } from "./vnode-helpers.ts";

/**
 * Returns `value` as JSON with every object's keys sorted, so two values
 * holding the same data compare equal whatever order their keys are stored
 * in.
 */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1),
        )
        : item,
  );

/** Returns the resource named `name` in the context the view hands its guest. */
export const contextResource = (view: unknown, name: string): unknown => {
  const context = propValue(findElement(view, "cf-iframe"), "$context");
  return typeof context === "object" && context !== null
    ? readValue(Object.entries(context).find(([key]) => key === name)?.[1])
    : undefined;
};
