/**
 * Slot arithmetic for routed-frame tests, by the rule the router and
 * `parseRoutedJson` share: one slot per JSON value, whether scalar, object or
 * array, keys free, the root included.
 */

/** Counts values the way the rule states it, independently of the parser. */
export const countValues = (value: unknown): number =>
  1 +
  (value !== null && typeof value === "object"
    ? Object.values(value).reduce(
      (total: number, member) => total + countValues(member),
      0,
    )
    : 0);

/**
 * A routed frame of exactly `slots` values: root, type, requestId, an array
 * and its numbers, distinct so the frame compresses within the ratio bound.
 */
export const routedFrameOf = (slots: number): string =>
  `fvj1:${
    JSON.stringify({
      type: "response",
      requestId: "r",
      ok: Array.from({ length: slots - 4 }, (_, i) => i),
    })
  }`;
