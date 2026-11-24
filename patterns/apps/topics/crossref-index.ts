/**
 * The board's index of its mention pivot by topic number, which lets a topic
 * find its own row by reading the positions filed under its number instead of
 * reading every row. It lives in a module of its own so that adding it leaves
 * the names the transformer gives the board's and the topic's derivations as
 * they are.
 */

import { lift, type ReadonlyCell, Writable } from "commonfabric";

import { isMemberName } from "../../product/collection-naming/allocator.ts";
import type { TopicCrossrefIndex, TopicCrossrefNamedRow } from "./topic.tsx";

/**
 * Groups positions by name: for each position `i` from zero to
 * `names.length - 1`, in order, `rowAt(i)` is filed under `names[i]`. A name
 * that is not a string, or not a member name (`isMemberName`), files nothing,
 * so no bucket can be named by an `Object.prototype` member or by a blank or
 * padded string. Two positions with one name share its bucket, in position
 * order.
 */
export function bucketRowsByName<R>(
  names: readonly unknown[],
  rowAt: (position: number) => R,
): Record<string, R[]> {
  const byName: Record<string, R[]> = {};
  names.forEach((name, position) => {
    if (typeof name !== "string" || !isMemberName(name)) return;
    if (!Object.hasOwn(byName, name)) byName[name] = [];
    byName[name].push(rowAt(position));
  });
  return byName;
}

/**
 * The pivot's positions by the number each row carries, and the pivot they
 * are positions of.
 *
 * It reads the pivot's length, each position's link, and each row's `name`.
 * Under lazy materialization that is all it reads, so a mention added or
 * removed anywhere on the board re-runs the pivot's rows and not this. With
 * lazy materialization off, reading the pivot's length reads every row whole,
 * `mentionedBy` included, so every mention edit re-runs this as well, and the
 * run writes the index it already holds. Each bucket element is a link to
 * a position of the pivot, `rows.key(i)`, so whoever follows it reads the row
 * the pivot holds there at the time, including after a reorder this has not
 * caught up with. It decides nothing: a topic reading a bucket checks that the
 * row it finds is its own, and reads the pivot itself when it is not.
 */
export const crossrefIndexOf = lift(
  (
    { rows }: { rows: ReadonlyCell<TopicCrossrefNamedRow[]> },
  ): TopicCrossrefIndex => {
    const count = rows.get()?.length ?? 0;
    const names = Array.from(
      { length: count },
      (_, position) => rows.key(position).key("name").get(),
    );
    const byName = bucketRowsByName<unknown>(
      names,
      (position) => rows.key(position),
    );
    const index: unknown = Writable.for<TopicCrossrefIndex>("crossref-index")
      .set({
        source: rows,
        byName: byName as TopicCrossrefIndex["byName"],
      });
    return index as TopicCrossrefIndex;
  },
);
