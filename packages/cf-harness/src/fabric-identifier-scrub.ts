/**
 * Replaces bare fabric identifiers in model-facing or retrospective text with
 * a fixed placeholder. Schemed links and harness handle tokens remain intact.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";

export const scrubBareFabricIdentifiers = (text: string): string =>
  text
    .replaceAll(/\bdata:[^\s"'`)\]}]+/gi, "[fabric-id]")
    .replaceAll(/\bdid:[A-Za-z0-9]+:[A-Za-z0-9._%-]+/g, "[fabric-id]")
    .replaceAll(
      /(?<![A-Za-z0-9:])[A-Za-z0-9]+:[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
      "[fabric-id]",
    );

/**
 * Applies the bare-identifier scrub to every string and object key in a value.
 * A key that becomes indistinguishable from a sibling is overwritten because
 * the model-facing or retrospective boundary cannot distinguish it either.
 */
export const scrubBareFabricIdentifiersDeep = (value: unknown): unknown =>
  scrubBareFabricIdentifiersWithPointers(value).value;

/** Escapes one object key for an exact JSON Pointer. */
export const escapeJsonPointerSegment = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** One scrubbed value and the artifact positions changed by that same walk. */
export interface FabricIdentifierProjection {
  /** Value whose strings and keys passed through the identifier scrub. */
  value: unknown;

  /** Exact positions changed, using the container when its key was scrubbed. */
  scrubbedPointers: readonly string[];
}

/** Scrubs identifiers and records their positions without copying them into pointers. */
export const scrubBareFabricIdentifiersWithPointers = (
  value: unknown,
  pointer = "",
): FabricIdentifierProjection => {
  const pointers = new Set<string>();
  const visit = (current: unknown, at: string, record = true): unknown => {
    if (typeof current === "string") {
      const scrubbed = scrubBareFabricIdentifiers(current);
      if (record && scrubbed !== current) pointers.add(at);
      return scrubbed;
    }
    if (Array.isArray(current)) {
      return current.map((entry, index) =>
        visit(entry, `${at}/${index}`, record)
      );
    }
    if (!isObjectOrArray(current)) return current;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      const scrubbedKey = scrubBareFabricIdentifiers(key);
      const childPointer = scrubbedKey === key
        ? `${at}/${escapeJsonPointerSegment(key)}`
        : at;
      if (record && scrubbedKey !== key) pointers.add(at);
      Object.defineProperty(result, scrubbedKey, {
        value: visit(entry, childPointer, record && scrubbedKey === key),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  };
  return { value: visit(value, pointer), scrubbedPointers: [...pointers] };
};

/** Positions whose strings or member names carry a bare fabric identifier. */
export const bareFabricIdentifierPointers = (
  value: unknown,
  pointer = "",
): readonly string[] =>
  scrubBareFabricIdentifiersWithPointers(value, pointer).scrubbedPointers;
