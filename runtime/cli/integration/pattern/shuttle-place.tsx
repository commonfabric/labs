/**
 * Fixture for the shuttle walkthrough (`shuttle-over-a-terminal.sh`).
 *
 * It exists so the walkthrough owns its subject: the shipped patterns are used
 * elsewhere, and a change to one of them should never break a demonstration of
 * what a shell standing in a space can reach. Nothing else deploys this file.
 *
 * Every member is a place the walkthrough stands at or a value it reads, and
 * each is here for one reason:
 *
 * - `label` is a stored scalar, which is the shortest thing `get` can return
 *   and the shortest thing `cd` can land on.
 * - `items` is a stored array, so a listing has numbered rows and a path has
 *   a segment below the piece to walk to.
 * - `settings` is a nested object, so a place can be two segments deep inside
 *   one piece.
 * - `summary` is computed from `items`, so what a read serves depends on
 *   whether anything ran the pattern since the last write. That is the
 *   difference between a warm read and a cold one, which the walkthrough
 *   reads rather than assumes.
 * - `addItem` and `clearItems` write, so the walkthrough has a way to change
 *   `items` from outside the shell and a way to change it from inside one.
 *   There are two of them because one would not be a choice: a piece with a
 *   single callable makes `call %1` pass whether the handle named that row or
 *   was ignored, where two rows with opposite effects make each `call %n`
 *   assert which row the number reached.
 * - `[UI]` is a real node with a nested tree, so the walkthrough can ask
 *   whether a read at the piece root serves it or holds it back.
 */

import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";

/** What `addItem` is given: the one line to append. */
interface AddEvent {
  /** The text to append to `items`. */
  text: string;
}

/** What the piece is started with, all of it optional and defaulted. */
interface PlaceInput {
  label?: Writable<string | Default<"a place">>;
  items?: Writable<string[] | Default<[]>>;
}

/** What the piece offers a reader standing on it. */
interface PlaceOutput {
  [NAME]: string;
  [UI]: VNode;

  /** A stored scalar. */
  label: string;

  /** A stored array, whose rows a listing numbers. */
  items: string[];

  /** A nested object, so a place can stand two segments inside the piece. */
  settings: { depth: number; note: string };

  /** Computed from `items`, so a stale read of it differs from a warm one. */
  summary: string;

  /** Appends one line to `items`. */
  addItem: Stream<AddEvent>;

  /** Empties `items`, which is the opposite of what `addItem` does. */
  clearItems: Stream<void>;
}

/** The fixture the shuttle walkthrough deploys, twice, under two slugs. */
export const ShuttlePlace = pattern<PlaceInput, PlaceOutput>(
  ({ label, items }) => {
    const addItem = action(({ text }: AddEvent) => {
      const trimmed = text.trim();
      if (trimmed !== "") items.push(trimmed);
    });

    const clearItems = action(() => {
      items.set([]);
    });

    const summary = computed(() => (items.get() ?? []).join(", "));

    return {
      [NAME]: "Shuttle place",
      [UI]: (
        <cf-vstack gap="2">
          <cf-heading level={4}>Shuttle place</cf-heading>
          <div id="shuttle-place-label">{label}</div>
        </cf-vstack>
      ),
      label,
      items,
      settings: { depth: 2, note: "two segments in" },
      summary,
      addItem,
      clearItems,
    };
  },
);

export default ShuttlePlace;
