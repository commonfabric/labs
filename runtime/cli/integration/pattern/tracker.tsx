/**
 * Fixture for the CLI verb-session demo (`docs/common/verbs/session-walkthrough.md`).
 *
 * It exists so the demo owns its subject: the shipped patterns are used
 * elsewhere, and a change to one of them should never break a demonstration of
 * what driving a pattern through `cf` looks like. Nothing else deploys this
 * file.
 *
 * A work-item tracker, chosen because a tree with cross-links is where
 * addresses stop being a convenience and become the only correct answer: one
 * item can be a child of a second and blocked-on by a third, and only an
 * address tells a caller those are the same item rather than three copies.
 *
 * The board holds root items only. Everything deeper is reachable through
 * `children`, which is what makes an unshaped read of `items` expand the whole
 * tree — the cost that shaped reads exist to bound.
 */

import {
  action,
  type Default,
  NAME,
  pattern,
  type PatternFactory,
  SELF,
  type Stream,
  Writable,
} from "commonfabric";

/** One work item. Deliberately small: this fixture is about what a verb hands
 * back and how a caller addresses what it made, not about modeling work. */
export interface ItemOutput {
  /** File a new item beneath this one. */
  addChild: Stream<AddChildEvent, AddChildResult>;

  /** Append a progress note. Notes are append-only; nothing rewrites one. */
  recordNote: Stream<RecordNoteEvent, RecordNoteResult>;

  /** Mark this item done. Descendants are left alone — finishing a parent
   * says nothing about its children, which is what `openBelow` reports. */
  finish: Stream<FinishEvent, FinishResult>;

  /** Record that this item waits on another. The blocker may be anywhere on
   * the board — this is the edge that makes the tree a graph. */
  blockOn: Stream<BlockOnEvent, BlockOnResult>;

  /** Mark this item archived. Declares no result — the value-less shape. */
  archive: Stream<void>;

  [NAME]: string;
  title: string;

  /** "open" until a verb changes it — "done" or "archived". */
  status: string;

  /** Append-only progress record. Each entry carries a time the caller did not
   * supply and could not have supplied — the pattern reads the clock. */
  notes: Note[];

  /** The item this one files under, or null at a root. Carried so a caller can
   * walk up as well as down, per the documented self-reference shape. */
  parent: ItemOutput | null;

  /** The tree. */
  children: ItemOutput[];

  /** Items this one waits on. These are not descendants — a blocker can live
   * anywhere in the board, which is what turns the tree into a graph and makes
   * one item reachable by two different paths. */
  blockedOn: ItemOutput[];
}

/** One progress note. `at` is epoch milliseconds, coarsened to one-second
 * resolution by the sandbox clock. */
export interface Note {
  body: string;
  at: number;
}

/** Plain-input style: everything a caller supplies is ordinary data. `status`
 * and `children` are pattern-local state rather than inputs, per the
 * self-reference shape — which also keeps this type free of `Writable<>`, so
 * the factory annotation below matches without stripping cell wrappers. */
interface ItemInput {
  title: string | Default<"Untitled">;
  parent?: ItemOutput | null | Default<null>;
}

interface AddChildEvent {
  /** One line naming the work. */
  title: string;
}

interface AddChildResult {
  /** The item this call created — the piece itself, not a minted identifier.
   * It reaches the caller as a link the CLI can render as an address. */
  item: ItemOutput;
}

interface RecordNoteEvent {
  /** What happened, in the words you would tell a colleague. */
  body: string;
}

interface RecordNoteResult {
  /** The note as persisted, including the time the pattern stamped on it. A
   * caller cannot compute `at` — that is the whole reason this comes back. */
  note: Note;

  /** How many notes this item now carries, after the append. */
  noteCount: number;
}

interface FinishEvent {
  /** Optional closing note, recorded with the same stamp as the finish. */
  body?: string;
}

interface FinishResult {
  /** When the item was finished, as persisted. */
  at: number;

  /** Descendants still open beneath this item. Zero means the subtree is
   * genuinely done; anything else is the caller's next question, and it takes
   * a walk of the whole subtree to answer. */
  openBelow: number;
}

interface BlockOnEvent {
  /** The item this one waits on. `Writable<>` is what declares this position a
   * reference rather than a shape — the spelling shipped patterns already use
   * for `addPiece`, `appendLink`, and the card-pile moves. */
  on: Writable<ItemOutput>;
}

interface BlockOnResult {
  /** The item that now waits — this one. */
  blocked: ItemOutput;

  /** The item it waits on. Still a reference: it arrived as one, is stored as
   * one, and is handed back as one, so the caller gets an address rather than
   * a copy of the target. */
  on: Writable<ItemOutput>;

  /** How many items this one waits on, after the edge was written. */
  blockedOnCount: number;
}

/** Count descendants still open, depth-first. A module-scope helper because
 * SES forbids loop statements inside a pattern-owned callback body, and this
 * has to recurse to an unknown depth. */
function countOpenBelow(items: readonly ItemOutput[]): number {
  return items.reduce(
    (total, child) =>
      total + (child.status === "open" ? 1 : 0) +
      countOpenBelow(child.children ?? []),
    0,
  );
}

// Annotated rather than inferred: `addChild` returns an `ItemOutput`, and it
// builds one by calling `Item`, so inference would have to resolve `Item`'s
// type from inside its own initializer. The annotation breaks that cycle.
export const Item: PatternFactory<ItemInput, ItemOutput> = pattern<
  ItemInput,
  ItemOutput
>(
  ({ title, parent, [SELF]: self }) => {
    const status = new Writable("open");
    const notes = new Writable<Note[]>([]);
    const children = new Writable<ItemOutput[]>([]);
    const blockedOn = new Writable<ItemOutput[]>([]);

    const addChild = action<AddChildEvent, AddChildResult>((event) => {
      const trimmed = (event.title ?? "").trim();
      if (!trimmed) throw new Error("addChild: title must be non-empty");
      const item = Item({ title: trimmed, parent: self });
      children.push(item);
      return { item };
    });

    const recordNote = action<RecordNoteEvent, RecordNoteResult>((event) => {
      const trimmed = (event.body ?? "").trim();
      if (!trimmed) throw new Error("recordNote: body must be non-empty");
      // The clock is a handler-only capability, and coarsened to one second.
      const note = { body: trimmed, at: Date.now() };
      notes.push(note);
      return { note, noteCount: (notes.get() ?? []).length };
    });

    const finish = action<FinishEvent, FinishResult>((event) => {
      const at = Date.now();
      const closing = (event.body ?? "").trim();
      if (closing) notes.push({ body: closing, at });
      status.set("done");
      return { at, openBelow: countOpenBelow(children.get() ?? []) };
    });

    const blockOn = action<BlockOnEvent, BlockOnResult>((event) => {
      const target = event.on;
      if (!target) throw new Error("blockOn: on must name an item");
      blockedOn.push(target);
      return {
        blocked: self,
        on: target,
        blockedOnCount: (blockedOn.get() ?? []).length,
      };
    });

    const archive = action(() => {
      status.set("archived");
    });

    return {
      [NAME]: title,
      title,
      status,
      notes,
      parent,
      children,
      blockedOn,
      addChild,
      recordNote,
      finish,
      blockOn,
      archive,
    };
  },
);

/** File a new root item on the board. */
interface AddItemEvent {
  /** One line naming the work. */
  title: string;
}

interface AddItemResult {
  /** The root item this call created. */
  item: ItemOutput;
}

interface BoardInput {
  items?: Writable<ItemOutput[] | Default<[]>>;
}

/** A work-item tracker: root items on a board, everything deeper under an
 * item's `children`. State changes only through verbs — a caller files,
 * notes, finishes, archives, and relates items; nothing here is written
 * directly. */
interface BoardOutput {
  [NAME]: string;

  /** Root items only. The tree hangs off each one's `children`. */
  items: ItemOutput[];

  /** File a new root item on the board. */
  addItem: Stream<AddItemEvent, AddItemResult>;
}

export default pattern<BoardInput, BoardOutput>(({ items }) => {
  const addItem = action<AddItemEvent, AddItemResult>((event) => {
    const trimmed = (event.title ?? "").trim();
    if (!trimmed) throw new Error("addItem: title must be non-empty");
    const item = Item({ title: trimmed, parent: null });
    items.push(item);
    return { item };
  });

  return {
    [NAME]: "Work tracker",
    items,
    addItem,
  };
});
