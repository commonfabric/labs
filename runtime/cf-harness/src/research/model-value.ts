/** Bounded reads of untrusted JSON fields returned by a research model. */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** Returns a bounded string, or empty text for another JSON value. */
export const stringValue = (value: unknown, max = 2_000): string =>
  typeof value === "string" ? value.slice(0, max) : "";

/** Returns the bounded string entries in a model-provided list. */
export const stringList = (
  value: unknown,
  maxItems = 24,
  maxLength = 2_000,
): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLength));

/** Returns record fields at a model-input or model-result boundary. */
export const objectValue = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

/** Keeps the first occurrence of each model-provided value in input order. */
export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
