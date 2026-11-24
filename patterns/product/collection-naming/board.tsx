/**
 * The exemplar collection: a board of items that owns a member namespace.
 * `addItem` allocates the next name, creates the item holding it, and appends
 * the item in one write, so the created item is reachable at `names[<n>]` and
 * carries its own name the moment it exists; `backfillNames` names, in filing
 * order, whatever the board held before it numbered anything. The board
 * publishes its index — the items themselves, through the scalars a survey
 * reads and each item's own name — the names table that gives a member its
 * name by identity, and the declaration a consumer learns the naming policy
 * from.
 */

import {
  action,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import Item from "./item.tsx";
import { mentionableIndex, type MentionableRow } from "./mentionable.ts";
import {
  backfillNames,
  createNamed,
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  SEQUENCE_NAMING,
} from "./naming.ts";

/**
 * One row of the board's index: the item itself, declared through the scalars
 * a survey reads. The declared schema is the bound, so a reader surveying the
 * board expands no item's body or verbs.
 *
 * A row IS the item it describes, so a row's own address is the item's
 * address; nothing here carries a separate copy of it.
 */
export interface ItemIndexRow {
  /**
   * The item's title. Defaulted so a missing path does not make the whole
   * array unreadable.
   */
  title: string | Default<"">;

  /**
   * When the item was filed (epoch milliseconds), which the item pattern
   * publishes unconditionally.
   */
  createdAt: number;

  /**
   * The board's name for the item, as the item stores it.
   *
   * OPTIONAL rather than defaulted, which is what the compatibility proof
   * accepts: a defaulted property moves the demand's defaults below an array
   * constraint the proof cannot show stable under default insertion, while an
   * optional one carries no default to move. `ItemOutput` publishes it the
   * same way, which is alignment rather than a constraint this type imposes:
   * a required publication would satisfy this demand too. What the compiler
   * refuses is the other pairing, a required row against an optional
   * publication; `ItemOutput.shortName` in `item.tsx` states it in full.
   *
   * An item whose input holds no name — one filed before the board passed a
   * name in at create, or one filed past `addItem`, which includes every
   * member a backfill names — is absent here rather than blank, and the array
   * reads whole around it. That is the bound on what the spelling buys: it is
   * about the READ. `cf piece setsrc` refuses a member demand that gains any
   * property at all — optional included — over a board whose stored members
   * do not publish it, because the schema recorded on the retained link to
   * each member is unconstrained at that path.
   */
  shortName?: string;
}

/** What the board reads of a stored item: exactly the row it publishes. */
export type ItemDemand = ItemIndexRow;

/** What the board holds: its item list and its member namespace. */
export interface BoardInput {
  /**
   * The board's durable item list, in filing order. `addItem` appends here; a
   * whole-array write forfeits the mergeability the append keeps.
   */
  items?: Writable<ItemDemand[] | Default<[]>>;

  /**
   * The board's member namespace: each name to the item it names, held as an
   * unread reference. `addItem` writes one key per create and `backfillNames`
   * one key per member it names; nothing rewrites the map whole. Reads as
   * empty on a board from before it numbered anything, in the default form
   * `NamesMap` explains.
   */
  // deno-lint-ignore ban-types
  names?: Writable<Default<NamesMap, {}>>;
}

/** What `addItem` takes: the item's content and the agent filing it. */
export interface AddItemEvent {
  /** The item's title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The item's initial body, stored verbatim. */
  body?: string;

  /**
   * The agent making this mutation. Fabric records the human principal
   * behind the key; this names which agent acted under it. Required, and
   * checked rather than stored: a create that could be unsigned is a
   * tolerance the verb could never withdraw.
   */
  agentName: string;
}

/** What `addItem` returns. */
export interface AddItemResult {
  /**
   * The item this call created — the piece itself, declared through the
   * index's row schema so the default readback is bounded. Its `shortName`
   * is what the item publishes; `name` beside it is the allocation itself,
   * which a caller reads without depending on the item.
   */
  item: ItemIndexRow;

  /** The name the create allocated, as it was written to the map. */
  name: string;
}

/** What `backfillNames` takes: the agent running it. */
export interface BackfillNamesEvent {
  /** The agent running the backfill, checked as `addItem` checks it. */
  agentName: string;
}

/** What `backfillNames` returns. */
export interface BackfillNamesResult {
  /**
   * The names this run wrote, in filing order; empty when every member was
   * already named, which is what a second run returns.
   */
  assigned: string[];
}

/**
 * A board of items that names its members. Survey the board with one bounded
 * read of `index`: a row is its item, so select the row's own address
 * alongside `title` and `shortName`, and use that address for the item's own
 * reads. File with `addItem`, which allocates the next name in the same write
 * as the append and returns the item with the name it allocated. A board that
 * held items before it numbered anything runs `backfillNames` once.
 */
export interface BoardOutput {
  [NAME]: string;
  [UI]: VNode;

  /**
   * The board's items, in filing order, through the shape the board demands
   * of them.
   */
  items: ItemDemand[];

  /**
   * The survey surface: the items themselves, declared through the row
   * schema. A row IS its item, so a row's own address is the item's, and an
   * index into this array is not a stable address.
   */
  index: ItemIndexRow[] | Default<[]>;

  /**
   * The namespace itself: each name to the item it names. A slug pointing
   * here is what makes a member addressable as `<board>/<name>`. Published
   * under the default its input carries.
   */
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;

  /**
   * The names table, one row per named member: what `nameOf` reads to find
   * the name the board gives a member by identity, including a member whose
   * own `shortName` is absent.
   */
  namesTable: NamesTableRow[] | Default<[]>;

  /**
   * What the board declares about its names, for a consumer deciding whether
   * a name may be held rather than an identity.
   */
  naming: NamingDeclaration;

  /**
   * The board's mention universe, under the name the item pattern's editor
   * autocompletes over — what `addItem` wires into each item it creates. One
   * derived document of copies, each holding its item as an unread reference
   * and carrying the board's name for it, so `#42` finds a member without
   * expanding one; see `MentionableRow` in `mentionable.ts`.
   */
  mentionable: MentionableRow[] | Default<[]>;

  /** How many items the board holds. */
  itemCount: number;

  /** File an item: allocate its name and append it, atomically. */
  addItem: Stream<AddItemEvent, AddItemResult>;

  /** Name every unnamed member in filing order. Idempotent. */
  backfillNames: Stream<BackfillNamesEvent, BackfillNamesResult>;
}

/**
 * Rejects a mutation loudly. To a headless caller a silent early return is
 * indistinguishable from success; a throw surfaces as a failed handler
 * transaction and a nonzero CLI exit. The message carries the verb as a
 * stable prefix.
 */
const reject = (verb: string, reason: string): never => {
  throw new Error(`${verb} rejected: ${reason}`);
};

export default pattern<BoardInput, BoardOutput>(({ items, names }) => {
  // `.length` alone is what keeps this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no item.
  const itemCount = items.get().length;
  // Derived once for the whole board, for a caller's reverse lookup; no item
  // reads it.
  const table = namesTable({ names });
  // Also derived once for the whole board: the mention universe every item's
  // editor autocompletes over, as one document of copies.
  const mentionable = mentionableIndex({ members: items });
  const hasNoItems = itemCount === 0;

  const addItem = action<AddItemEvent, AddItemResult>(
    ({ title, body, agentName }) => {
      const trimmed = (title ?? "").trim();
      if (!(agentName ?? "").trim()) {
        reject("addItem", "agentName must be non-blank");
      }
      if (!trimmed) reject("addItem", "title must be non-empty");
      // The name, the create, and the append are one transaction: the item is
      // built holding the name the map records it under, no reader observes
      // the item without its name, and a concurrent create serializes on the
      // map's keys, re-running with the next name rather than taking the same
      // one.
      const { name, member: piece } = createNamed(names, (allocated) =>
        Item({
          title: trimmed,
          body: body ?? "",
          createdAt: Date.now(),
          // The name this create allocated, stored with the item, which is
          // what lets the item show it without reading the board.
          shortName: allocated,
          // The board's mention universe, so the item's body editor completes
          // `#42` and `[[` over its siblings.
          mentionable,
        }));
      // Mergeable append: concurrent creates all land.
      items.push(piece);
      return { item: piece, name };
    },
  );

  const backfill = action<BackfillNamesEvent, BackfillNamesResult>(
    ({ agentName }) => {
      if (!(agentName ?? "").trim()) {
        reject("backfillNames", "agentName must be non-blank");
      }
      return { assigned: backfillNames(items, names) };
    },
  );

  return {
    [NAME]: `Items (${itemCount})`,
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="2" padding="4">
          <cf-heading level={3}>Items</cf-heading>
          <cf-text variant="caption" tone="muted">
            {itemCount} items · each named by the board's sequence
          </cf-text>
        </cf-vstack>

        <cf-vstack gap="2" padding="4">
          {items.map((item) => (
            <cf-card>
              <cf-hstack gap="3" align="center">
                {item.shortName
                  ? (
                    <cf-badge size="sm" color="primary" data-member-name="">
                      {item.shortName}
                    </cf-badge>
                  )
                  : null}
                <cf-text block style="flex: 1; min-width: 0; font-weight: 600;">
                  {item.title || "(untitled item)"}
                </cf-text>
                <cf-cell-link $cell={item} label="Open" static />
              </cf-hstack>
            </cf-card>
          ))}

          {hasNoItems
            ? <cf-empty-state message="No items yet. File one with addItem." />
            : null}
        </cf-vstack>
      </cf-screen>
    ),
    items,
    // The items themselves, declared through the index's row schema: a row's
    // address is the item's address, so a survey and a follow-up read name
    // the same document.
    index: items,
    names,
    namesTable: table,
    // The sequence policy, claiming no name for the board: what it is bound
    // as is decided where the binding is made.
    naming: SEQUENCE_NAMING,
    mentionable,
    itemCount,
    addItem,
    backfillNames: backfill,
  };
});
