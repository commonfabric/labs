/**
 * Fixture for the completion walkthrough (`completion-over-the-cli.sh`).
 *
 * It exists so the walkthrough owns its subject: the shipped patterns are used
 * elsewhere, and a change to one of them should never break a demonstration of
 * what a Tab offers. Nothing else deploys this file.
 *
 * Every element here is a slot of the completion chain — space, piece, verb,
 * verb fields, cell path, result shape — so the walkthrough can name a
 * candidate set rather than assert that something came back:
 *
 * - `settings` is a nested object, so a cell path completes more than one
 *   segment deep.
 * - `items` holds child pieces, so a path crossing a `$link` boundary has a
 *   boundary to cross.
 * - `addItem` declares two fields and a doc comment; `renameItem` declares
 *   three; `sweep` declares none. Together they are the vocabulary a verb's
 *   flags come from and the prose a candidate is annotated with.
 * - `legacyAdd` is `@deprecated`, which the default verb listing holds back —
 *   so the walkthrough can ask whether completion agrees with the listing.
 * - `Item` carries a callable named `record` on its result cell AND is handed
 *   one of that name in its arguments, which is the shadowing rule the verbs
 *   listing states and the one no table walk can reach.
 */

import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

interface RecordEvent {
  /** What to record against this item. */
  text: string;
}

interface RecordResult {
  /** The count as persisted, so a caller can confirm the write landed. */
  recorded: number;
}

interface ItemInput {
  label?: Writable<string | Default<"">>;
  recorded?: Writable<number | Default<0>>;

  /**
   * A callable handed in by the board, so this piece's ARGUMENTS cell carries
   * a name its result cell also carries. The two are different streams, and
   * which one a caller reaches is the shadowing rule.
   */
  record?: Stream<RecordEvent, RecordResult>;
}

interface ItemOutput {
  [NAME]: string;
  label: string;
  recorded: number;

  /** Record one line against this item, and report the running count. */
  record: Stream<RecordEvent, RecordResult>;
}

/** One item, deployed as a child of the board below. */
export const Item = pattern<ItemInput, ItemOutput>(
  ({ label, recorded }) => {
    const record = action<RecordEvent, RecordResult>((event) => {
      const text = (event.text ?? "").trim();
      if (!text) throw new Error("record: text must be non-empty");
      const next = (recorded.get() ?? 0) + 1;
      recorded.set(next);
      return { recorded: next };
    });

    return {
      [NAME]: label,
      label,
      recorded,
      record,
    };
  },
);

interface AddItemEvent {
  /** The item's display label. */
  title: string;

  /** Whether the item starts pinned. */
  pinned?: boolean;
}

interface AddItemResult {
  /** The item this call created. */
  item: ItemOutput;

  /** How many items the board holds afterwards. */
  total: number;
}

interface RenameItemEvent {
  /** Which item to rename, by position. */
  index: number;

  /** The label to write. */
  newTitle: string;

  /** Leave the old label in place when it is already set. */
  keepExisting?: boolean;
}

interface RenameItemResult {
  /** The label as persisted. */
  label: string;
}

/**
 * Both fields optional so a projection may name one of them. A concise field
 * path closes the position it names, so selecting `settings.theme` out of a
 * schema that REQUIRES `density` reads as a required value that did not
 * materialize — which is a fact about the projection rather than about
 * completion, and not the one this fixture is for.
 */
interface BoardSettings {
  theme?: string;
  density?: string;
}

interface BoardInput {
  items?: Writable<ItemOutput[] | Default<[]>>;
  settings?: Writable<
    BoardSettings | Default<{ theme: "dark"; density: "cozy" }>
  >;
  revision?: Writable<number | Default<0>>;
}

interface BoardOutput {
  [NAME]: string;
  items: ItemOutput[];
  itemCount: number;
  settings: BoardSettings;
  revision: number;

  /** Add one item to the board, and report the new total. */
  addItem: Stream<AddItemEvent, AddItemResult>;

  /** Rename the item at a position. */
  renameItem: Stream<RenameItemEvent, RenameItemResult>;

  /** Bump the revision and return nothing. */
  sweep: Stream<void>;

  /**
   * Record against the board rather than one item. Handed to every child as
   * its `record` argument, which is what puts a callable of that name on the
   * child's arguments cell beside the one on its result cell.
   */
  noteAll: Stream<RecordEvent, RecordResult>;

  /** @deprecated Use addItem, which reports the new total. */
  legacyAdd: Stream<AddItemEvent>;
}

export default pattern<BoardInput, BoardOutput>(
  ({ items, settings, revision }) => {
    const noteAll = action<RecordEvent, RecordResult>((event) => {
      const text = (event.text ?? "").trim();
      if (!text) throw new Error("noteAll: text must be non-empty");
      const next = (revision.get() ?? 0) + 1;
      revision.set(next);
      return { recorded: next };
    });

    const addItem = action<AddItemEvent, AddItemResult>((event) => {
      const title = (event.title ?? "").trim();
      if (!title) throw new Error("addItem: title must be non-empty");
      const item = Item({ label: title, recorded: 0, record: noteAll });
      items.push(item);
      return { item, total: (items.get() ?? []).length };
    });

    const renameItem = action<RenameItemEvent, RenameItemResult>((event) => {
      const list = items.get() ?? [];
      const target = list[event.index];
      if (!target) throw new Error("renameItem: no item at that index");
      const label = (event.newTitle ?? "").trim();
      if (!label) throw new Error("renameItem: newTitle must be non-empty");
      if (event.keepExisting && (target.label ?? "").length > 0) {
        return { label: target.label };
      }
      items.key(event.index).key("label").set(label);
      return { label };
    });

    const sweep = action(() => {
      revision.set((revision.get() ?? 0) + 1);
    });

    const legacyAdd = action<AddItemEvent>((event) => {
      const title = (event.title ?? "").trim();
      if (!title) throw new Error("legacyAdd: title must be non-empty");
      items.push(Item({ label: title, recorded: 0, record: noteAll }));
    });

    return {
      [NAME]: "Completion fixture",
      items,
      itemCount: computed(() => (items.get() ?? []).length),
      settings,
      revision,
      addItem,
      renameItem,
      sweep,
      noteAll,
      legacyAdd,
    };
  },
);
