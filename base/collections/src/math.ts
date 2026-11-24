/**
 * Minimum and maximum over a collection of numbers.
 *
 * `Math.min(...values)` and `Math.max(...values)` pass every value as a
 * separate argument, which overflows the call stack once the collection holds
 * more values than the engine allows as arguments. These functions walk the
 * collection instead, and otherwise give the same results: `Infinity` and
 * `-Infinity` for an empty collection, and `NaN` if any value is `NaN`.
 */

/** The smallest of `values`, or `Infinity` when there are none. */
export function minOf(values: Iterable<number>): number {
  let result = Infinity;
  for (const value of values) result = Math.min(result, value);
  return result;
}

/** The largest of `values`, or `-Infinity` when there are none. */
export function maxOf(values: Iterable<number>): number {
  let result = -Infinity;
  for (const value of values) result = Math.max(result, value);
  return result;
}
