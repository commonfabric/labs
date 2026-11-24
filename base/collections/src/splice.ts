/** Splicing a whole collection into an array as one argument. */

/**
 * Replaces `deleteCount` elements of `array`, starting at `start`, with the
 * elements of `items`, and returns the removed elements. The result is the same
 * as `array.splice(start, deleteCount, ...items)`, but `items` is not passed as
 * separate arguments, so it can hold more elements than a call's argument list
 * allows. As with `splice`, `items` is read in full before `array` changes.
 */
export function spliceAll<T>(
  array: T[],
  start: number,
  deleteCount: number,
  items: Iterable<T>,
): T[] {
  const inserted = [...items];
  const tail = array.splice(start);
  const removed = tail.splice(0, deleteCount);
  for (const item of inserted) array.push(item);
  // `forEach` skips holes, so moving the rest back this way keeps them, as
  // `splice` does.
  const tailStart = array.length;
  array.length += tail.length;
  tail.forEach((item, index) => {
    array[tailStart + index] = item;
  });
  return removed;
}
