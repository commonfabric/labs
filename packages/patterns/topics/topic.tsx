import {
  action,
  cellFromUrl,
  type ComparableCell,
  computed,
  Default,
  equals,
  handler,
  type JSONSchema,
  lift,
  NAME,
  pattern,
  type PerSession,
  type ReadonlyCell,
  SELF,
  Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type {} from "commonfabric/schema";

import { isMemberName } from "../collection-naming/allocator.ts";

// ===== Shared types =====

/**
 * What a link points at — a rendering hint, not a behavior switch.
 *
 * An open domain rather than an enum, deliberately. This value is PROVIDED
 * data: it reaches a reader through a published result, where the update gate
 * requires the new type to be a subset of the old one. A closed enum there can
 * never gain a member, so declaring one is a promise never to learn a new kind
 * of link — and the set below is a guess about a corpus that keeps growing.
 *
 * Well-known values, which the composer offers and the renderer styles:
 * `"web"`, `"pr"`, `"topic"`, `"session"`. Anything else stores and renders as
 * itself rather than being refused.
 */
export type TopicLinkKind = string;

/** A display snapshot attached atomically to content. Fabric remains the
 * authority for which principal/key performed the write. `kind: "agent"`
 * disambiguates an agent acting with its human user's key. */
export interface TopicAuthor {
  /** Open for the same reason `TopicLinkKind` is: this is provided data, so a
   * closed set here could never gain `"service"` or whatever acts next.
   * Well-known values are `"person"` and `"agent"`, the latter marking an
   * agent acting with its human user's key. `"legacy"` records a display name
   * whose author kind is unknown. */
  kind: string;
  name: string;
  avatar?: string;
}

export interface AgentAuthoredEvent {
  /** Explicit content-level signature for an agent using its human user's
   * identity key. Fabric authenticates the write with that key; this says
   * which agent acted under it.
   *
   * Required so every authored-content call carries structured attribution.
   * Authenticated execution provenance can supersede the field by relaxing it
   * to optional without breaking existing callers. */
  agentName: string;
}

export interface AddCommentEvent extends AgentAuthoredEvent {
  /** The comment text, appended verbatim after trimming. Must be non-empty:
   * an empty body rejects rather than recording a blank thread entry. */
  body: string;
}

export interface AddLinkEvent extends AgentAuthoredEvent {
  /** What the link points at — a rendering hint, not a behavior switch.
   * Optional because the handler defaults it to `"web"`, and a caller should
   * not be made to supply a field the verb never needed. */
  kind?: TopicLinkKind;

  /** The link target. Must be http(s): anything else rejects, because a
   * user-supplied scheme on a shared surface is script execution in every
   * viewer's session. */
  url: string;

  /** Display label. Optional, and a blank one falls back to the URL. */
  label?: string;
}

export interface SetBodyEvent extends AgentAuthoredEvent {
  /** The complete replacement body, persisted verbatim — no trimming, so
   * whitespace-sensitive Markdown survives. An empty body is legal: clearing
   * a living document is an edit, not an error. */
  body: string;
}

export interface SetTitleEvent {
  /** The new title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The agent making this mutation, stored as structured attribution beside
   * the write time. Required so every successful rename is attributed. */
  agentName: string;
}

/**
 * Reference another piece from this topic.
 *
 * Carries no `agentName`, unlike every other verb here, and the absence is the
 * honest one: a mention records where a reference points and nothing about who
 * made it, so a signature would be accepted and then dropped. Fabric still has
 * the principal that made the write.
 */
export interface MentionEvent {
  /** The piece to reference — the piece itself, not an address. Identity here
   * is the cell, so this is what a caller passes and what gets stored.
   *
   * Declared through the one field every Topic has rather than `unknown`. The
   * cell declaration marks this as a reference position, so the CLI resolves a
   * canonical `/of:...` value from an inline JSON event into the live piece
   * link. It also bounds the validation read: `topic.get()` is `undefined` for
   * a value that is not a reference and an object for any piece, and `mention`
   * checks it before storing anything.
   *
   * `title` is also the most this can safely name: this schema reaches every
   * topic in `mentionable`, so a property without a default would be demanded
   * of topics written before it existed and refuse their update. `title`
   * carries one, and that default does double duty — it is also why the check
   * admits a piece that is not a topic at all, which reads back `{ title: "" }`
   * rather than `undefined`. `deno task pattern-vintage` proves the update side
   * by replaying a real board.
   *
   * Nothing reads THROUGH it beyond that one field — the value is stored and
   * compared. */
  topic: Writable<{ title: string | Default<""> }>;
}

/**
 * Retract a comment. The record stays, stamped; nothing is deleted.
 *
 * The comment is named by reference, which is the rule `TopicComment` states:
 * array elements have stable entity identity, so a caller passes the element
 * rather than a synthetic key nobody minted. A reader hands one over from the
 * row it is already rendering.
 */
export interface RemoveCommentEvent extends AgentAuthoredEvent {
  /** The comment to retract — the stored element, not a copy of its fields.
   * Names only what this verb reads and writes, for the reason
   * `MentionEvent.topic` names only `title`: the declaration bounds the
   * validation read, and a payload that is not a reference reads back
   * `undefined` and is refused rather than silently matching nothing.
   * `sentAt` carries a default, so it is what makes a real element read back
   * as an object; the stamp fields are optional, which is what lets this
   * schema reach comments written before they existed. */
  comment: Writable<{
    sentAt: number | Default<0>;
    removedAt?: number;
    removedBy?: TopicAuthor;
  }>;
}

/** Revise a comment's body in place. */
export interface EditCommentEvent extends AgentAuthoredEvent {
  /** The comment to revise, named and checked as in `RemoveCommentEvent`,
   * and additionally naming `body`, which this verb writes. */
  comment: Writable<{
    sentAt: number | Default<0>;
    body: string | Default<"">;
    editedAt?: number;
    removedAt?: number;
  }>;

  /** The complete replacement text, trimmed. Must be non-empty: emptying a
   * comment is a retraction, and `removeComment` is what says so. */
  body: string;
}

/**
 * Retract a link. The record stays, stamped, and stops resolving into
 * `mentions`.
 *
 * Takes EITHER the stored link or its `url`, and the url spelling is the
 * reason this verb differs from the others. A link record is not a piece and
 * carries no fid, so a caller that reaches this verb over the CLI has no way
 * to name one by reference — and `addLink` is the verb agents use most.
 * Exactly one of the two must be supplied.
 */
export interface RemoveLinkEvent extends AgentAuthoredEvent {
  /** The stored link element. What a reader passes, from the row it renders.
   * Named as in `RemoveCommentEvent`, with `url` playing the defaulted-field
   * role `sentAt` plays there. */
  link?: Writable<{
    url: string | Default<"">;
    removedAt?: number;
    removedBy?: TopicAuthor;
  }>;

  /** The link's URL, for a caller that cannot pass a reference. Retracts the
   * most recently added link still present with this URL, so retracting twice
   * retracts two rather than re-stamping one.
   *
   * Sequentially. Two concurrent retractions naming the same URL both resolve
   * the same newest-present element and merge into one stamped record, so
   * they retract one link between them rather than two. Naming the link by
   * reference is what makes a caller's target unambiguous under concurrency;
   * this spelling trades that for being reachable at all. */
  url?: string;
}

export interface RemoveCommentResult {
  /** The retraction as stamped, so a caller need not read back to confirm. */
  removedAt: number;
  removedBy: TopicAuthor;
}

export interface EditCommentResult {
  /** The body as persisted, and when the revision was stamped. */
  body: string;
  editedAt: number;
}

export interface RemoveLinkResult {
  /** The URL of the link that was retracted, which tells a caller using the
   * url spelling which of several same-url links it reached. */
  url: string;
  removedAt: number;
  removedBy: TopicAuthor;
}

/** Stop referencing a piece. */
export interface UnmentionEvent {
  /** Declared and checked exactly as `MentionEvent.topic` is, and for the same
   * reason: a payload that is not a reference matches no stored entry, so
   * without the check it would remove nothing and report success. */
  topic: Writable<{ title: string | Default<""> }>;
}

// ===== Verb results =====
//
// Each mutating verb returns exactly what it recorded, so a caller learns the
// outcome from the call instead of following it with a verification read. The
// records carry the fields the pattern resolved — the structured author it
// derived from `agentName`, and the write-time timestamp — which a caller
// cannot compute for itself. Counts are deliberately absent: every append here
// is a mergeable op, so a length observed inside one handling is not a fact
// about the resulting list.

export interface AddCommentResult {
  /** The comment as appended, including resolved author and `sentAt`. */
  comment: TopicComment;
}

export interface AddLinkResult {
  /** The link as appended, including resolved `addedBy` and `addedAt`. */
  link: TopicLink;
}

export interface SetBodyResult {
  /** The body as persisted — verbatim, so a caller can confirm that
   * whitespace-sensitive Markdown survived the round trip. */
  body: string;

  /** Attribution written for this save. A successful call includes both
   * fields because `setBody` requires `agentName`. */
  bodyUpdatedBy?: TopicAuthor;
  bodyUpdatedAt?: number;
}

export interface SetTitleResult {
  /** The title as persisted, after trimming. */
  title: string;

  /** Attribution written for this rename — always present, because the verb
   * requires `agentName`. */
  titleUpdatedBy: TopicAuthor;
  titleUpdatedAt: number;
}

export interface TopicComment {
  /** Snapshot taken at write time (profile enrichment comes later; never gate
   * authorship on a profile wish — CT-1879). Comments carry no minted id:
   * array elements have stable entity identity; future editing addresses
   * elements by reference (`equals()`), not by a synthetic key.
   *
   * Optional because durable Topics may contain a comment without structured
   * authorship. Current `addComment` calls require `agentName` and always write
   * this snapshot. */
  author?: TopicAuthor;
  body: string | Default<"">;
  sentAt: number | Default<0>;

  /** When the body was last revised, absent on a comment never edited. The
   * original `sentAt` and `author` are left alone: an edit changes what was
   * said, not who said it or when the thread reached this point. */
  editedAt?: number;

  /** Set when the comment was retracted, and the retraction is the whole of
   * it — the record stays, carrying what it always said. A reader hides it;
   * `commentCount` stops counting it; `lastActivityOf` keeps reading its
   * `sentAt`, which is what stops a retraction moving a topic backwards in
   * the board's ordering. */
  removedAt?: number;
  removedBy?: TopicAuthor;
}

/** Stored comment fields available to the author migration. */
interface StoredTopicComment extends TopicComment {
  /** Unrestricted legacy storage; only nonblank strings supply a name. */
  authorName?: unknown;
}

export interface TopicLink {
  kind: TopicLinkKind | Default<"web">;
  url: string | Default<"">;
  label: string | Default<"">;
  addedBy?: TopicAuthor;
  addedAt?: number;

  /** As on a comment, and with one consequence of its own: a retracted link
   * stops resolving into `mentions`, so the reference it contributed goes
   * with it rather than outliving the link that made it. */
  removedAt?: number;
  removedBy?: TopicAuthor;
}

/**
 * Whether `candidate` is one of `array`'s own elements.
 *
 * "Is a reference" is not the check these verbs need. A cell that reads back
 * as an object satisfies that while belonging to another piece entirely, and a
 * verb that then stamps it writes into a document this topic does not own. So
 * membership is proved by identity against the stored positions, which is the
 * `equals()` addressing `TopicComment` names in place of a synthetic key.
 *
 * This is a tightening rather than a privilege boundary, and it was argued
 * both ways before landing. A caller gains no authority here they lack
 * calling the other topic's own verb under the same principal, and
 * `MentionEvent.topic` accepts a foreign reference by design. What the check
 * buys is that a wrong argument fails loudly instead of succeeding against
 * something the caller did not mean to name — the write would otherwise land,
 * report success, and move a count on a topic nobody was looking at.
 */
const isElementOf = (
  array: {
    get(): readonly unknown[];
    key(index: number): { equals(other: object): boolean };
  },
  candidate: object,
): boolean => {
  const stored = array.get();
  for (let index = 0; index < stored.length; index++) {
    if (array.key(index).equals(candidate)) return true;
  }
  return false;
};

/** Whether a stamped record is still live.
 *
 * Used where the read is not reactive: `removeLink`'s own body scans the
 * stored links for the url spelling, and callers outside the pattern — a
 * test, a script — ask the same question. Inside a `computed()` the predicate
 * is written out instead, and that is not a style
 * choice: the schema a reactive read declares is what it can SEE, and a
 * property tested behind a helper call is not named in it. Filtering through
 * this function there yields a count that never changes, because `removedAt`
 * was never demanded and so reads back absent on every element. */
export const isPresent = (record: { removedAt?: number }): boolean =>
  record.removedAt === undefined;

export interface TopicInput {
  title?: Writable<string | Default<"">>;

  /** The topic's living document: durable conclusions get folded up into the
   * body; the comment thread below holds the deliberation. */
  body?: Writable<string | Default<"">>;
  comments?: Writable<StoredTopicComment[] | Default<[]>>;
  links?: Writable<TopicLink[] | Default<[]>>;
  createdAt?: number | Default<0>;
  createdBy?: TopicAuthor;

  /** Creator display name recorded without an author kind. */
  createdByName?: unknown;

  /** Number of ordered state upgrades completed by this topic. */
  topicStateVersion?: Writable<number | Default<0>>;

  bodyUpdatedBy?: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  bodyUpdatedAt?: Writable<number | Default<0>>;

  /** Attribution of the last rename, stamped by `setTitle` — the same pair
   * the body keeps, because a title is the other editable scalar. */
  titleUpdatedBy?: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;
  titleUpdatedAt?: Writable<number | Default<0>>;

  /** The board's mention universe — what the body editor autocompletes
   * over. Wired at creation to the board's mention index (one derived
   * document of copies; `MentionableRow` in
   * `../collection-naming/mentionable.ts`), and rewired onto a piece from
   * before the index as a one-time link-bind. A plain list of the pieces
   * themselves also satisfies the demand — a board not yet rewired, or a
   * composer without a board. Absent, the editor simply offers no
   * completions.
   *
   * Declared readable, which is what settles the retained link's proof. A
   * writable handle adds a write-back leg to that proof, asking this
   * three-field projection to accept every field the board's row publishes,
   * and the row carries a required `piece` this projection deliberately omits
   * — so a topic wired to a board is refused even the source it is running.
   * The declaration is not a runtime gate: a write through the handle is
   * refused by nothing, and where the universe is a plain list of pieces the
   * editor's name write-back reaches a member's own title through it. */
  mentionable?: ReadonlyCell<TopicMentionable[] | Default<[]>>;

  /** Where this topic's `[Label][key]` mentions point, keyed by the token that
   * appears in the body. The editor owns the contents; this pattern owns the
   * cell, which is what makes a mention durable and — because each entry holds
   * the destination as a REFERENCE — what makes the reference graph a question
   * about cell identity rather than about text.
   *
   * The default has to match the one `TopicOutput` publishes. A map published
   * under a different default than its input carries cannot be materialized. */
  // deno-lint-ignore ban-types
  references?: Writable<TopicMentionRefMap | Default<{}>>;

  /** Pieces this topic references outside its prose — what `mention` records.
   *
   * Its own list rather than an entry in `references`, because that map belongs
   * to the body editor: the editor mints its keys, rewrites its labels, and
   * collects entries whose token has left the document. A verb writing there
   * would be writing into somebody else's bookkeeping. Here there is nothing to
   * key by, because there is nothing to point back at from the prose — a
   * reference outside a sentence is just a link in a list. */
  mentioned?: Writable<unknown[] | Default<[]>>;

  /** The board's mention pivot, one row per topic. A topic reads its own row
   * out of it and nothing else; see `backlinksOf`. Absent, a topic simply shows
   * no inbound references.
   *
   * Readable, not writable: the pivot is the board's derivation, and a topic
   * has no business writing into it. Declaring the narrower cell says so where
   * a reader can see it, rather than leaving it to convention. */
  boardCrossrefs?: ReadonlyCell<TopicCrossrefRow[] | Default<[]>>;

  /**
   * The number the board calls this topic by, stored here. The board's create
   * allocates it over the board's namespace and passes it in, in the
   * transaction that creates the topic; `recordName` writes it onto a topic
   * filed before the board numbered anything. A number is permanent and never
   * reused, so this copy stays the number the board's namespace holds for the
   * topic.
   *
   * STORING a number and SHOWING one are separate, and only the showing is
   * gated: `SHOW_TOPIC_NUMBERS` decides what the topic publishes, and while it
   * is off this input still holds the number and `recordName` still writes it.
   * Nothing published carries it then, which is what the board's numbering
   * step loses and `BackfillNamesResult` in `./main.tsx` states.
   *
   * Absent on a topic nobody has numbered: one filed before the namespace
   * existed and not yet recorded, and one composed with no board at all. Such
   * a topic reports no number and renders without failing.
   *
   * Plain rather than `Writable`, because every reader of it wants the string
   * — the topic's own report of its number, a board's row demand, a mention
   * universe row. The one writer is `recordName`, which takes the writable
   * handle in its own state schema, beside the write that needs it.
   */
  shortName?: string;
}

/** What `recordName` takes: the number the board allocated for this topic. */
export interface RecordNameEvent {
  /**
   * The number to store, as the board's namespace holds it. Required, and
   * checked against the name grammar rather than stored as given: a topic has
   * no way to derive its own number, so a caller that could omit this would be
   * asking the topic to invent one.
   *
   * No `agentName` accompanies it, unlike every authored-content verb here,
   * and the absence is the honest one for the reason `MentionEvent` gives
   * about itself: the number is the board's allocation, so a content-level
   * signature would be accepted and then dropped. Fabric still records the
   * principal that made the write.
   */
  name: string;
}

/** What `recordName` returns. */
export interface RecordNameResult {
  /** The number the topic stores once the call returns. */
  name: string;

  /** Whether this call wrote it; `false` when the topic already stored it. */
  wrote: boolean;
}

/**
 * One `[Label][key]` mention: where it points, and whether the reader has given
 * it a wording of their own.
 *
 * `destination` is `unknown` because a mention may address any piece, and
 * because that is the declaration that keeps it a reference. Every consumer
 * here compares it by identity — nothing reads through it — so nothing needs
 * a wider type, and a wider type would start expanding the piece behind it.
 *
 * The shape is the `cf-code-editor` `$references` contract
 * (`packages/ui/src/v2/core/mention-refs.ts`), which notes carries too.
 */
export interface TopicMentionRef {
  destination: unknown;
  modifiedTitle: boolean;
}

/** A topic's mentions, keyed by the token that appears in its body. The keys
 * are local to one topic and mean nothing anywhere else. */
export type TopicMentionRefMap = Record<string, TopicMentionRef>;

/**
 * What the board's pivot reads from one topic: what it points at, and nothing
 * else. This is the entire cost of deriving the whole graph.
 *
 * The mentions are CELLS, and the annotation is what makes the answer settle.
 * Declared `unknown` each entry still arrives as a link — the proxy keeps the
 * back-pointer, and `equals` compares it correctly every time — but nothing
 * tells the runtime that the entry is a reference worth tracking, so whether
 * the document behind it has loaded when this runs is a matter of timing. The
 * pivot then computes a different graph on different passes and never
 * converges: the row for a topic that IS mentioned comes back empty, and the
 * idempotency recheck reports differing writes for `mentionedBy`.
 *
 * `ComparableCell` is that missing annotation. It does not change what an entry
 * is, only what the runtime knows to do about it, which is the whole difference
 * between a graph that settles and one that depends on load order.
 */
export interface TopicMentionSource {
  mentions: ComparableCell<unknown>[] | Default<[]>;
}

/**
 * One row of the board's mention pivot: a topic, and the topics that mention
 * it.
 *
 * ONE ROW PER DISTINCT TOPIC. That is the contract, not a property of the
 * board that happens to hold: the board's `crossrefTable` builds its rows from
 * `distinctByIdentity` over the board, which compares entries by `equals`, so a
 * board listing one topic at two entries — the same link twice, or a link and
 * an alias of it — gets one row for that topic. Nothing downstream dedupes, and
 * a reader finding its row by identity finds exactly one. The pivot's sources
 * come from the same distinct list, so that topic appears once, at its first
 * entry, in the `mentionedBy` of each topic it mentions, and never in its own.
 *
 * Both sides are declared `unknown`, which is the whole design rather than a
 * shortcut. A row holds cell REFERENCES — `unknown` is the declaration that
 * lets a cell be written into one without a cast, and the one that stops any
 * reader of the table expanding a topic it did not ask for. Each consumer
 * declares what it wants to see through them.
 */
export interface TopicCrossrefRow {
  /** The topic this row is about. `unknown` because it is written as a
   * reference and only ever compared — `equals` takes the raw link. Anything
   * wider retrieves the piece instead of pointing at it: declared `object`,
   * this field reads back as the whole expanded topic, `$UI` tree included. */
  topic: unknown;
  mentionedBy: unknown[];
}

/**
 * What the body editor's `@`-mention autocomplete needs of a mention
 * universe entry: the display name it lists and matches on, the title — the
 * persisted scalar other readers of the universe select, though the editor's
 * own schema does not — and the board's name for the topic as `shortName`,
 * which is what a `#42` query matches.
 *
 * `shortName` is OPTIONAL rather than defaulted, which is a fact about the
 * compatibility proof: a defaulted property moves the demand's defaults below
 * an array constraint the proof cannot show stable under default insertion,
 * and dropping the default without making the property optional makes it a
 * newly required field. No spelling makes the demand applicable over a topic
 * deployed before the namespace — a property added to a per-member demand is
 * refused over members that do not publish it, for the reason
 * `TopicDemand.shortName` in `./main.tsx` states. `TopicPiece` publishes it the
 * same way, so a plain list of topics satisfies this demand as the input
 * documents it may.
 *
 * `[NAME]` is not decoration here. `cf-code-editor` declares its entries as
 * `Mentionable`, whose schema carries `required: [NAME]`
 * (`packages/ui/src/v2/core/mentionable.ts`), so a sibling projection without
 * it silently offers no completions — the JSX prop binding is loose enough
 * that TypeScript does not object.
 *
 * These three are also deliberately the WHOLE demand. A board's universe row
 * carries its topic as a `piece` reference besides them, and leaving that
 * out of this projection is what keeps every walk under a topic's argument
 * out of the sibling topics: a property the declared demand does not select
 * is invisible to the walks that warm and watch the argument. The editor
 * reaches `piece` through its own declared contract instead, at the moment
 * a completion is picked.
 */
export interface TopicMentionable {
  [NAME]: string | Default<""> | undefined;
  title: string | Default<"">;
  shortName?: string;
}

/**
 * The least a board row needs from a topic: its title, and the scalars a
 * full-board survey summarizes.
 *
 * An input projection, not a published type — every reference this pattern
 * publishes is declared at `TopicPiece`. Keeping it out of the published
 * surface is what leaves it free to shrink.
 */
export interface TopicSummary {
  /** The topic's title. Defaulted rather than required, like every other
   * field a board card renders: the card list is a mapped sub-pattern, so
   * this type reaches a piece holding topics written before the field
   * existed as the argument schema its update is checked against, and a
   * required property those topics lack refuses that update outright.
   * `deno task pattern-vintage` is what catches it, by replaying a real
   * deployed board. */
  title: string | Default<"">;

  /** When the topic was filed (epoch milliseconds), stamped at create. */
  createdAt: number;
  createdBy?:
    | TopicAuthor
    | Default<{ kind: "person"; name: "" }>
    | undefined;
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;
}

/**
 * A #topic — a durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, and typed links out to other
 * core objects (PRs, agent sessions, other topics). Deliberately has no
 * status, labels, or assignees; what a topic grows next is part of the
 * experiment (CT-1878).
 *
 * This is the board-facing projection: the one stored in the tracker's list,
 * and the one a topic's editor autocompletes over through `mentionable`.
 * Session-local UI controls are intentionally excluded: a TopicPiece can be
 * followed from a shared list even when the viewer has no matching
 * session-local cells.
 */
export interface TopicPiece extends TopicSummary {
  /** The topic's display name. Like the other derived display fields, a cold
   * retained topic may not have produced this path yet; its persisted title
   * remains authoritative until it does. */
  [NAME]: string | Default<""> | undefined;

  /** The number the board calls this topic by, out of the `shortName` INPUT
   * the topic stores. The display name stays the title, and this rides beside
   * it: where a topic publishes one, its header and the board's card render it
   * as a badge, and a mention universe carries it, which is what a mention
   * pill and a `#42` query read.
   *
   * Absent while `SHOW_TOPIC_NUMBERS` is off, and for a topic whose input
   * holds no number: the property is simply not there. Every consumer treats
   * that as no name — the badge renders nothing, and the topic's universe row
   * carries the empty name, which matches no `#42` query and gives a mention
   * pill no number.
   *
   * This is the number the topic SHOWS. `TopicInput.shortName` is the number
   * it HOLDS, and the two part company whenever the switch is off.
   *
   * Optional rather than defaulted, and the difference is the compatibility
   * proof's: this is what a board's stored list is validated against, and a
   * defaulted property there moves the demand's defaults below an array
   * constraint the proof cannot show stable under default insertion. It is not
   * what lets the projection apply over a board whose members predate the
   * property, and nothing is; `TopicDemand.shortName` in `./main.tsx` states
   * why. */
  shortName?: string;

  /** The living document, verbatim Markdown. `setBody` replaces it whole. */
  body: string | Default<"">;

  /** The thread, in arrival order, each record carrying its author snapshot
   * and `sentAt`.
   *
   * MEMBERSHIP is append-only; a record is not. Nothing is ever removed from
   * this array — `removeComment` stamps `removedAt` and leaves the record in
   * place, and `editComment` revises a body and stamps `editedAt` — so a
   * reader that wants the live thread filters on `removedAt` rather than
   * taking the array as it stands. `commentCount` is that filtered count. */
  comments: TopicComment[];

  /** Typed outbound links, in arrival order, each carrying its author snapshot
   * and `addedAt`. Append-only in membership on the same terms as `comments`:
   * `removeLink` stamps rather than removes, and a stamped link additionally
   * stops resolving into `mentions`. */
  links: TopicLink[];

  /** Every piece this topic's prose and links point at, as references.
   *
   * The board's pivot is declared over this and nothing else, so what one topic
   * costs a full-board scan is exactly this list of identities. Declared
   * `unknown[]` because these are references, and comparing them never reads
   * what is behind them.
   *
   * The cell annotation that makes them comparable belongs to the READER, not
   * here: the pivot declares its own view of this list as
   * `TopicMentionSource.mentions: ComparableCell<unknown>[]`, and that is what
   * makes its graph settle rather than depend on load order. A published
   * `unknown[]` is what each reader annotates for itself.
   *
   * The default stands alone: a declared default and `| undefined` collide,
   * and the default is what a topic deployed before this path existed
   * materializes against. */
  mentions: unknown[] | Default<[]>;

  /** Where this topic's `[Label][key]` mentions point. Durable content, like
   * `links`. The body editor works on a session copy of this map, which a save
   * publishes here whole, beside the prose whose tokens name its entries. */
  // deno-lint-ignore ban-types
  references: TopicMentionRefMap | Default<{}>;

  /** Pieces referenced outside the prose, recorded by `mention`. */
  mentioned: unknown[] | Default<[]>;

  /** The topics that mention this one, read out of the board's pivot.
   *
   * Declared through `TopicSummary` rather than `TopicPiece`, and that is
   * load-bearing rather than stingy: a topic whose backlinks were topics would
   * be a type that contains itself, and resolving one from a list would walk
   * the graph. The summary carries no reference of its own, so it terminates.
   * A reader that wants more follows the link, which resolves whole. */
  referencedBy: TopicSummary[] | Default<[]>;
  bodyUpdatedBy?: TopicAuthor | undefined;
  bodyUpdatedAt?: number | undefined;

  /** Append to the thread — a point-in-time record of progress or
   * deliberation; durable conclusions belong in the body. Returns the
   * comment as recorded, resolved author and `sentAt` included. */
  addComment: Stream<AddCommentEvent, AddCommentResult>;

  /** Attach a typed outbound link — a PR, an agent session, a web page.
   * Returns the link as recorded, resolved `addedBy` and `addedAt`
   * included. Appends merge and nothing dedupes: a repeated URL is two
   * entries. */
  addLink: Stream<AddLinkEvent, AddLinkResult>;

  /** Replace the living document whole — read it, revise it, write it back
   * complete; the body is one value with whole-value conflict semantics.
   * Requires `agentName` and returns the persisted body with its attribution. */
  setBody: Stream<SetBodyEvent, SetBodyResult>;

  /** Reference another piece from this topic — the payload is the piece
   * itself, stored as a reference. Takes no `agentName` and returns no value;
   * Fabric retains the authenticated principal behind the edge. */
  mention: Stream<MentionEvent>;

  /** Stop referencing a piece: removes every `mention`-made entry naming it.
   * References made in the prose are retracted by editing the prose, not by
   * this. Takes no `agentName` and returns no value. */
  unmention: Stream<UnmentionEvent>;
}

/**
 * A #topic — one durable unit of shared attention: a title, a living body
 * document, a flat chronological comment thread, typed links out to other
 * core objects (PRs, agent sessions, web pages), and the references it makes
 * to sibling pieces.
 *
 * Durable conclusions get folded up into the body — revise it whole with
 * `setBody`; the thread holds the deliberation as point-in-time `addComment`
 * records. The thread only ever grows: `removeComment` and `removeLink` stamp
 * a record as retracted and leave it where it is, and `editComment` revises a
 * body in place, so what a reader shows is the array filtered rather than the
 * array itself. Sign every authored-content mutation with `agentName`:
 * Fabric records the human principal behind the key; the name says which
 * agent acted under it. `mention`, `unmention` and `recordName` carry no
 * content signature: the first two record where a reference points, and the
 * third records a number the board allocated. The session-draft cells and
 * `submit*` streams below belong to the rendered page, not the headless
 * contract — they read state only this session holds.
 */
export interface TopicOutput extends TopicPiece {
  [UI]: VNode;

  /**
   * Session-local composer/edit state. These controls belong to a direct Topic
   * instance, not the shared TopicPiece projection used by the tracker's list.
   */
  commentDraft: PerSession<Writable<string>>;
  bodyDraft: PerSession<Writable<string>>;

  /**
   * Whether the body editor is open.
   *
   * A bare session-scoped value rather than a cell-wrapped one, and that
   * spelling costs a capability worth knowing about before reaching for it: a
   * verb cannot take a whole Topic as captured state while any required
   * property is published this way. The piece does not materialize through the
   * verb's state schema, so the argument arrives undefined and the runtime
   * declines to run the verb at all — "stream action argument is undefined
   * (potential schema mismatch)", logged rather than thrown, with the write
   * silently absent.
   *
   * Nothing needs that today. A board names a member by writing the piece into
   * its namespace, and every path that does so builds the piece inside the
   * verb (`addTopic`, the browser composer) or resolves it out of the board's
   * own list (`backfillNames`); none of them takes a Topic as an argument, so
   * none reads one through a state schema. Cell-wrapping these two would buy
   * the capability at the cost of a `scope changed` break on every deployed
   * Topic, so it waits for a verb that needs it.
   */
  editingBody: PerSession<boolean>;
  titleDraft: PerSession<Writable<string>>;

  /** Whether the rename editor is open. Bare for the reason `editingBody`
   * states, and the constraint is per property: cell-wrapping one and not the
   * other buys nothing. */
  editingTitle: PerSession<boolean>;
  linkUrlDraft: PerSession<Writable<string>>;
  linkLabelDraft: PerSession<Writable<string>>;
  linkKindDraft: PerSession<Writable<TopicLinkKind>>;

  /**
   * The body draft's mention map, staged so Cancel can discard it.
   *
   * `cf-code-editor` writes an entry the moment a mention is inserted and
   * drops one the moment its token leaves the document, neither of them
   * waiting for Save. Pointed at the durable map while `$value` holds a
   * session draft, those writes would outlive a discarded edit: a canceled
   * insertion would leave an edge no token names, and a canceled deletion
   * would strip the destination from a token the durable body still carries.
   * The editor's own ordering assumes its two bindings share a lifetime, so
   * this gives them one.
   */
  referencesDraft: PerSession<Writable<TopicMentionRefMap>>;

  /** Rename the topic. Requires `agentName` and returns the persisted title
   * with its attribution. This direct-address verb stays outside the board's
   * narrow `TopicPiece` demand. */
  setTitle: Stream<SetTitleEvent, SetTitleResult>;

  /**
   * Retract a comment, naming it by reference. The record is stamped rather
   * than deleted, so the thread keeps its evidence while a reader stops
   * showing it and `commentCount` stops counting it.
   *
   * Here rather than on `TopicPiece`, for the reason `setTitle` is: boards
   * store that projection, so it is a demand on every topic they already
   * hold, and a required verb added to it would refuse every one deployed
   * before the verb existed. A verb has no default to be rescued by, so there
   * is no compatible way to demand a new one. Addressing the topic directly
   * reaches all three of these.
   */
  removeComment: Stream<RemoveCommentEvent, RemoveCommentResult>;

  /** Revise a comment's body in place, naming it by reference. Stamps
   * `editedAt` and leaves `author` and `sentAt` as they were. Outside the
   * projection for the reason `removeComment` states. */
  editComment: Stream<EditCommentEvent, EditCommentResult>;

  /** Retract a link, by reference or by `url`. Stamped like a comment, and a
   * retracted link stops resolving into `mentions`. The url spelling exists
   * because a link record carries no fid for a CLI caller to name. Outside
   * the projection for the reason `removeComment` states. */
  removeLink: Stream<RemoveLinkEvent, RemoveLinkResult>;

  /**
   * Store the number the board calls this topic by, which is the only way a
   * number reaches a topic the board did not pass one to at create: a board
   * writes a member's result and never a member's argument, so the topic has
   * to make the write itself.
   *
   * Idempotent, and permanent: a call naming the stored number writes nothing
   * and reports `wrote: false`, and a call naming a different one is refused.
   * The board's `backfillNames` sends this verb one event per topic it holds
   * that reports no number, and an operator can send it directly.
   *
   * THE NUMBER MUST BE THE ONE THE BOARD'S NAMESPACE HOLDS FOR THIS TOPIC, and
   * the verb cannot check that: a topic holds no namespace to look itself up
   * in, and giving it one is the board-derived table this design exists to
   * remove — `shortName` above says why. So the check is the caller's, and
   * `cf cell get --cell <board> names` is where the answer is. A number the
   * board did not allocate is stored as readily as one it did, and a number is
   * permanent: the step then allocates a different one, writes it into the
   * namespace, and is refused here for as long as the disagreement stands, so
   * `top/<n>` and the topic's own badge name different numbers and nothing in
   * the board reconciles them. `skills/topics/references/namespace-backfill.md`
   * carries that repair, which is by hand.
   *
   * Outside the projection for the reason `removeComment` states: a board
   * stores `TopicPiece`, so a required verb added there would refuse every
   * topic deployed before the verb existed.
   */
  recordName: Stream<RecordNameEvent, RecordNameResult>;

  /** Attribution of the last rename; unset until the first `setTitle`.
   * Beside `setTitle` rather than on the projection, for the same reason. */
  titleUpdatedBy?: TopicAuthor | undefined;
  titleUpdatedAt?: number | undefined;

  /** UI wrapper: open the rename editor, seeding the session draft from the
   * durable title. */
  startEditTitle: Stream<void>;

  /** UI wrapper: save the session title draft under the viewer's Profile —
   * the contract verb is `setTitle`, and both land through the same core, so
   * a browser rename stamps the same attribution and moves the same activity
   * clock. */
  saveTitle: Stream<void>;

  /** UI wrapper: close the rename editor; the session draft is the discard. */
  cancelEditTitle: Stream<void>;

  /** UI wrapper: append the session comment draft under the viewer's
   * Profile. Reads session-local state, so it is a silent no-op headless —
   * the contract verb is `addComment`. */
  submitComment: Stream<void>;

  /** UI wrapper: open the body editor, seeding the session drafts from the
   * durable body and mention map. */
  startEditBody: Stream<void>;

  /** UI wrapper: publish the session body and mention-map drafts whole,
   * attributed to the viewer's Profile — the contract verb is `setBody`. */
  saveBody: Stream<void>;

  /** UI wrapper: close the body editor; the session drafts are the discard. */
  cancelEditBody: Stream<void>;

  /** UI wrapper: append the session link drafts under the viewer's Profile —
   * the contract verb is `addLink`. */
  submitLink: Stream<void>;
}

// ===== Shared presentation =====

/** The Topics theme: calm editorial light. */
export const TOPICS_THEME = {
  fontFamily: "'Iowan Old Style', 'Palatino', 'Georgia', serif",
  borderRadius: "0.5rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#31572c",
    primaryForeground: "#fdfcf8",
    background: "#fdfcf8",
    surface: "#f6f3ea",
    text: "#26241f",
    textMuted: "#7d7767",
    border: "#e4dfd1",
    accent: "#a4531f",
    accentForeground: "#fdfcf8",
  },
};

/**
 * Whether Topics shows a topic's number: the badge in the topic's header and
 * on its board card, the number beside a mention's label, and the topics a
 * `#42` query offers in the body editor.
 *
 * Off while only some topics have a number, because a number on some of a
 * board's topics and not on the rest confuses the people reading it. The board
 * numbers every topic it creates, but a topic filed before the board numbered
 * anything has no number until `backfillNames` numbers it and that topic
 * stores what it was asked to.
 *
 * Off, a topic publishes no `shortName`, and that is the whole mechanism:
 * every place a number shows reads a topic's `shortName` — its header, the
 * board's card and `index` row, and each entry of a mention universe, whether
 * the board's copies or a plain list of topics. The gate sits on the
 * publication rather than on each display because a universe handed the raw
 * member list has no row to blank: `cf-code-editor` takes a mention's short
 * name off the destination piece there, which
 * `docs/specs/collection-naming.md` reserves for a universe row
 * (https://github.com/commontoolsinc/labs/issues/7771).
 *
 * The numbers themselves are untouched. The board still allocates one on every
 * create, records it in `names`, and lists it beside its topic in
 * `namesTable`; a topic still stores its own in the `shortName` INPUT, which
 * this does not gate, and `recordName` still writes it; and a number still
 * addresses its topic as `top/<n>`.
 *
 * WHAT IT COSTS, which is the reason to turn it on rather than leave it:
 * a topic's published `shortName` is the only signal the board's numbering
 * step can read, so while this is off `backfillNames` cannot tell a topic that
 * stores its number from one that does not. It asks every topic every run and
 * reports every number under `pending`. Repeating it is safe and not idle: a
 * topic that already stores the number declines it and writes nothing further,
 * a topic whose number never landed stores it now, and the asking is itself a
 * write either way. `BackfillNamesResult` in `./main.tsx` says what an operator
 * reads instead, and `skills/topics/references/namespace-backfill.md` says what
 * a re-run writes per topic.
 *
 * WHAT TURNING IT ON WILL NEED IN TESTS, which is the part nothing else will
 * remind anyone of. This is a module constant, so a pattern test cannot vary
 * it: it is baked into the compiled program, and every Topics test therefore
 * runs the `false` branch only. Nothing today guards the `true` branch of the
 * publication below, and nothing can. When this flips, three things become
 * assertable and should be asserted in `./naming.test.tsx` in the same change:
 * a topic publishing the number it stores; the board's `index` row and mention
 * universe row carrying it; and `backfillNames` reporting a stored number
 * under `named` with an empty `pending`, which is the report this switch
 * currently costs. Several cases there read numbers out of cells the test
 * supplies purely because nothing published carries one; those can then read
 * the publication directly. The library's own already-recorded branch is held
 * meanwhile in `../collection-naming/naming.test.tsx`, over stand-in members
 * that publish a name, because Topics cannot reach it.
 *
 * TODO(mike): Turn this on once every topic on the deployed Topics board has a
 * number. Doing so restores the step's report by itself; nothing else changes.
 */
export const SHOW_TOPIC_NUMBERS: boolean = false;

// ===== Pure helpers =====

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Label derived purely from the stored timestamp — never from the current
 * clock — so it stays idempotent inside computeds (lunch-poll idiom). */
export const whenLabel = (ts: number): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
};

export const snippet = (text: string, max: number): string => {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Build the content-level signature required by headless mutation streams.
 * The authenticated human principal is deliberately not copied here: Fabric
 * already owns that authority and history. */
export const topicAuthorFromAgent = (
  agentName: string,
): TopicAuthor | undefined => {
  const name = (agentName ?? "").trim();
  return name ? { kind: "agent", name } : undefined;
};

/** Snapshot the canonical Profile fields used by browser mutations. */
export const topicAuthorFromPerson = (
  profileName: string,
  profileAvatar = "",
): TopicAuthor | undefined => {
  const name = (profileName ?? "").trim();
  if (!name) return undefined;
  const avatar = (profileAvatar ?? "").trim();
  return avatar ? { kind: "person", name, avatar } : { kind: "person", name };
};

/** Reject a mutation loudly. To a headless caller a silent early-return is
 * indistinguishable from success (verb contract rule 4,
 * docs/plans/pattern-verb-contract.md); a throw surfaces as a failed handler
 * transaction and a nonzero CLI exit. Stable error codes arrive with the
 * invocation protocol; until then the message carries a stable
 * "<verb> rejected:" prefix. UI composer wrappers keep their silent guards —
 * an empty draft is a non-event in a composer. */
export const rejectMutation = (verb: string, reason: string): never => {
  throw new Error(`${verb} rejected: ${reason}`);
};

/** The display string for an author, falling back to `someone` when there is
 * none or the name is blank. Agent snapshots are labeled explicitly because
 * they share the authenticated principal's identity key. */
export const topicAuthorLabel = (
  author: TopicAuthor | undefined,
): string => {
  const name = (author?.name ?? "").trim() || "someone";
  return author?.kind === "agent" ? `${name} (agent)` : name;
};

/** Only http(s) URLs may become live anchors — a user-supplied `javascript:`
 * href on a shared surface is script execution in every viewer's session.
 * Enforced at write (addLink rejects) AND at render (non-http renders as
 * text), since stored data may predate the write guard. */
export const isSafeLinkUrl = (url: string): boolean =>
  /^https?:\/\//i.test((url ?? "").trim());

const LINK_KIND_ITEMS = [
  { label: "Web", value: "web" },
  { label: "PR", value: "pr" },
  { label: "Topic", value: "topic" },
  { label: "Agent session", value: "session" },
];

/** The one place a comment record is built and appended. The contract verb
 * and the browser composer both ride it, so the trim rule, structured author,
 * and write-time stamp cannot drift between them. Callers guard emptiness on
 * their own terms first — the verb rejects, the composer silently declines.
 * Mergeable append: concurrent comments all land. */
export const appendComment = (
  comments: Writable<TopicComment[] | Default<[]>>,
  body: string,
  author: TopicAuthor,
): TopicComment => {
  const comment = {
    author,
    body: body.trim(),
    sentAt: Date.now(),
  };
  comments.push(comment);
  return comment;
};

/** The one place a link record is built and appended, for the same reason as
 * `appendComment`: the kind default, the label-falls-back-to-URL rule, and
 * the write-time stamp live here and nowhere else. URL safety stays with the
 * callers — the verb rejects an unsafe URL, the composer declines it. */
export const appendLink = (
  links: Writable<TopicLink[] | Default<[]>>,
  url: string,
  kind: TopicLinkKind | undefined,
  label: string | undefined,
  author: TopicAuthor | undefined,
): TopicLink => {
  const trimmedUrl = url.trim();
  const link = {
    kind: kind ?? ("web" as const),
    url: trimmedUrl,
    label: (label ?? "").trim() || trimmedUrl,
    addedBy: author,
    addedAt: Date.now(),
  };
  links.push(link);
  return link;
};

/** Author fields that may be only partially populated in stored comments. */
interface TopicUpgradeComment {
  /** Structured destination whose existing properties are preserved. */
  author?: Partial<TopicAuthor>;

  /** Legacy storage key retained for version-zero inputs. */
  authorName?: unknown;
}

/** Handles shared by ordered Topic upgrades and every durable mutation. */
interface TopicUpgradeState {
  /** Number of steps already committed for this topic. */
  topicStateVersion: Writable<number>;

  /** Legacy storage key; its spelling remains fixed for version-zero inputs. */
  createdByName: ReadonlyCell<unknown>;

  /** Structured creator destination, including partially populated stored data. */
  createdBy: Writable<Partial<TopicAuthor> | undefined>;

  /** Original comment identities, including the fixed legacy `authorName` key. */
  comments: Writable<TopicUpgradeComment[]>;
}

/** Object schemas whose properties extend generated mutation contracts. */
type TopicObjectSchema = Exclude<JSONSchema, boolean>;

/** Generated reader contract for partially populated structured creators. */
const TOPIC_CREATOR_SCHEMA = toSchema<
  Writable<Partial<TopicAuthor> | undefined>
>();

/** Generated reader contract for partially populated comment authors. */
const TOPIC_COMMENT_AUTHOR_SCHEMA = toSchema<
  Partial<TopicAuthor>
>();

/**
 * Reader contract that materializes strings while retaining opaque legacy data.
 * Both structured-author projections must stay inline: this contract is also
 * embedded inside handler schemas, whose roots resolve local references.
 */
const TOPIC_UPGRADE_SCHEMA = {
  type: "object",
  properties: {
    topicStateVersion: toSchema<Writable<number>>(),
    createdBy: TOPIC_CREATOR_SCHEMA,
    // Concrete strings are read; every other legacy value stays opaque.
    // A TypeScript `string | unknown` collapses to opaque-only `unknown`.
    createdByName: {
      type: ["string", "unknown"],
      asCell: ["readonly"],
    },
    comments: {
      type: "array",
      asCell: ["cell"],
      items: {
        type: "object",
        properties: {
          author: TOPIC_COMMENT_AUTHOR_SCHEMA,
          authorName: { type: ["string", "unknown"] },
        },
      },
    },
  },
  required: [
    "topicStateVersion",
    "createdByName",
    "createdBy",
    "comments",
  ],
} as const;

/** Durable fields and upgrade handles bound to a Topic mutation. */
type TopicWriteState<K extends keyof TopicInput = never> =
  & Required<Pick<TopicInput, K>>
  & {
    /** Shared state checked before the mutation's first durable write. */
    upgrade: Writable<TopicUpgradeState>;
  };

/**
 * Upgrades version zero to one by filling missing structured author names.
 * Legacy key spellings in this step are storage identifiers and remain fixed.
 * Returns true after completing all writes, or false when reads are incomplete.
 * Handlers defer ambiguous absent values to the lift, whose reads suspend on
 * unresolved links. Existing structured names, kinds, and avatars take priority.
 */
const upgradeLegacyAuthors = (
  input: TopicUpgradeState,
  fromHandler: boolean,
): boolean => {
  const { createdByName, createdBy, comments } = input;

  const legacyCreatorName = createdByName.get();
  const creator = createdBy.get();
  const storedCreatorName = createdBy.key("name").get();
  const creatorKind = createdBy.key("kind").get();
  const creatorName = !storedCreatorName?.trim() &&
      typeof legacyCreatorName === "string" && legacyCreatorName.trim() &&
      legacyCreatorName.trim() !== "someone"
    ? legacyCreatorName
    : undefined;
  // Handles keep unresolved reads pending in the lift. Eager handler reads
  // can return undefined for both absent fields and unresolved links.
  const storedComments = comments.get();
  if (storedComments === undefined) return false;
  const commentAuthors = storedComments.map((_, index) => {
    const comment = comments.key(index);
    const author = comment.key("author").get();
    const storedName = comment.key("author").key("name").get();
    const kind = comment.key("author").key("kind").get();
    const legacyName = comment.key("authorName").get();
    return {
      index,
      ready: Boolean(storedName?.trim()) ||
        (author !== undefined && storedName !== undefined &&
          kind !== undefined && legacyName !== undefined),
      absent: author === undefined,
      name: !storedName?.trim() &&
          typeof legacyName === "string" && legacyName.trim() &&
          legacyName.trim() !== "someone"
        ? legacyName
        : undefined,
      kind,
    };
  });

  if (
    fromHandler && ((!storedCreatorName?.trim() &&
      (creator === undefined || storedCreatorName === undefined ||
        creatorKind === undefined || legacyCreatorName === undefined)) ||
      commentAuthors.some(({ ready }) => !ready))
  ) return false;

  if (creatorName !== undefined) {
    if (creator === undefined) {
      createdBy.set({ name: creatorName, kind: "legacy" });
    } else {
      createdBy.key("name").set(creatorName);
      if (!creatorKind) createdBy.key("kind").set("legacy");
    }
  }
  commentAuthors.forEach(({ index, name, kind, absent }) => {
    if (name === undefined) return;
    const author = comments.key(index).key("author");
    if (absent) {
      author.set({ name, kind: "legacy" });
    } else {
      author.key("name").set(name);
      if (!kind) author.key("kind").set("legacy");
    }
  });
  return true;
};

/** Ordered, append-only steps; entry zero upgrades state version zero to one. */
const TOPIC_STATE_UPGRADES = ["legacy-authors"] as const;

/** State version stamped by every current Topics board creation path. */
export const TOPIC_STATE_VERSION = TOPIC_STATE_UPGRADES.length;

/** Dispatches each known step; the return type requires exhaustive handling. */
const runTopicUpgrade = (
  step: (typeof TOPIC_STATE_UPGRADES)[number],
  state: TopicUpgradeState,
  fromHandler: boolean,
): boolean => {
  switch (step) {
    case "legacy-authors":
      return upgradeLegacyAuthors(state, fromHandler);
  }
};

/**
 * Runs pending upgrades in order, recording each version after its step's writes.
 * With a verb, refuses unsupported versions before a durable mutation; without
 * one, leaves such state untouched so the running Topic can still render it.
 */
const upgradeTopicState = (state: TopicUpgradeState, verb?: string): void => {
  const fromHandler = verb !== undefined;
  const version = state.topicStateVersion.get();
  if (
    !Number.isSafeInteger(version) || version < 0 ||
    version > TOPIC_STATE_VERSION
  ) {
    if (fromHandler) {
      rejectMutation(verb, `unsupported topic state version ${version}`);
    }
    return;
  }
  for (let index = version; index < TOPIC_STATE_VERSION; index++) {
    const step = TOPIC_STATE_UPGRADES[index];
    // Author fields are additive: content handlers can still edit version
    // zero while its migration waits for complete reads.
    if (!runTopicUpgrade(step, state, fromHandler)) return;
    state.topicStateVersion.set(index + 1);
  }
};

/** Runs pending state upgrades whenever the Topic runs, without a result read. */
const migrateTopicState = lift(
  (state: TopicUpgradeState): void => upgradeTopicState(state),
  TOPIC_UPGRADE_SCHEMA,
  toSchema<void>(),
);

/** Generated object contract extended with the concrete legacy reader. */
const SUBMIT_PROFILE_COMMENT_STATE_SCHEMA = toSchema<
  SubmitProfileCommentState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const RETRACT_PROFILE_COMMENT_STATE_SCHEMA = toSchema<
  RetractProfileCommentState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const SAVE_PROFILE_TITLE_STATE_SCHEMA = toSchema<
  SaveProfileTitleState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const SAVE_PROFILE_BODY_STATE_SCHEMA = toSchema<
  SaveProfileBodyState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const DROP_MENTION_STATE_SCHEMA = toSchema<
  DropMentionState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const RETRACT_PROFILE_LINK_STATE_SCHEMA = toSchema<
  RetractProfileLinkState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const SUBMIT_PROFILE_LINK_STATE_SCHEMA = toSchema<
  SubmitProfileLinkState
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const COMMENTS_WRITE_SCHEMA = toSchema<
  TopicWriteState<"comments">
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const LINKS_WRITE_SCHEMA = toSchema<
  TopicWriteState<"links">
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const BODY_WRITE_SCHEMA = toSchema<
  TopicWriteState<"body" | "bodyUpdatedBy" | "bodyUpdatedAt">
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const TITLE_WRITE_SCHEMA = toSchema<
  TopicWriteState<"title" | "titleUpdatedBy" | "titleUpdatedAt">
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const MENTIONED_WRITE_SCHEMA = toSchema<
  TopicWriteState<"mentioned">
>() as TopicObjectSchema;

/** Generated object contract extended with the concrete legacy reader. */
const RECORD_NAME_STATE_SCHEMA = toSchema<
  RecordNameState
>() as TopicObjectSchema;

/** Bound state for `submitProfileComment`. */
type SubmitProfileCommentState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Stored thread containing the mutation target. */
  comments: Writable<TopicComment[] | Default<[]>>;

  /** Session draft cleared after a successful comment submit. */
  commentDraft: Writable<string>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser comment submit with Profile fields already resolved by the pattern.
 * Keeping the mutation in a module-scope handler lets tests bind deterministic
 * Profile snapshots while production still sources them only from wishes. */
export const submitProfileComment = handler<void, SubmitProfileCommentState>(
  toSchema<void>(),
  {
    ...SUBMIT_PROFILE_COMMENT_STATE_SCHEMA,
    properties: {
      ...SUBMIT_PROFILE_COMMENT_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (_, { upgrade, comments, commentDraft, profileName, profileAvatar }) => {
    const text = commentDraft.get();
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!text.trim() || !author) return;
    upgradeTopicState(upgrade.get(), "submitProfileComment");
    appendComment(comments, text, author);
    commentDraft.set("");
  },
);

/** Bound state for `retractProfileComment`. */
type RetractProfileCommentState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Stored thread containing the mutation target. */
  comments: Writable<TopicComment[] | Default<[]>>;

  // A CELL, for the reason `dropMention` gives about `topic`: bound as a plain
  // value it arrives resolved, matches no stored position, and removes
  // nothing.
  /** Original comment cell selected for retraction. */
  comment: Writable<TopicComment>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser comment retraction under the current Profile snapshot.
 *
 * Bound to the element the thread renders, which is an element of a filtered,
 * sorted `computed()`. Such an element keeps the identity of the position it
 * was derived from, so `equals()` matches it against the stored array and the
 * two writes below land on the stored record rather than on a copy of it.
 * That is a measured property rather than an assumed one — it is what
 * `view-identity.test.tsx` pins, and what
 * `integration/topic-retraction-controls.test.ts` proves through a real click.
 *
 * The membership check is therefore not redundant. It is what decides how a
 * regression in that property presents: refused here, a control bound to a
 * copy does nothing, where without it the copy would be stamped and the
 * reader would be shown a thread the topic does not hold. */
export const retractProfileComment = handler<void, RetractProfileCommentState>(
  toSchema<void>(),
  {
    ...RETRACT_PROFILE_COMMENT_STATE_SCHEMA,
    properties: {
      ...RETRACT_PROFILE_COMMENT_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (_, { upgrade, comments, comment, profileName, profileAvatar }) => {
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!author) return;
    if (!comment || comment.get() === undefined) return;
    if (!isElementOf(comments, comment)) return;
    if (comment.get()?.removedAt !== undefined) return;
    upgradeTopicState(upgrade.get(), "retractProfileComment");
    comment.key("removedAt").set(Date.now());
    comment.key("removedBy").set(author);
  },
);

/** The one place a rename lands. The contract verb and the browser save both
 * ride it, so the trim rule, the attribution stamp, and the activity clock
 * move together — a title write without its attribution pair is exactly the
 * stale-metadata state this rules out, since `titleUpdatedBy` would keep
 * describing an earlier rename. Callers guard emptiness and resolve their
 * author first. */
export const persistTitle = (
  title: Writable<string | Default<"">>,
  titleUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >,
  titleUpdatedAt: Writable<number | Default<0>>,
  text: string,
  author: TopicAuthor,
): SetTitleResult => {
  const trimmed = text.trim();
  title.set(trimmed);
  const at = Date.now();
  titleUpdatedBy.set(author);
  titleUpdatedAt.set(at);
  return { title: trimmed, titleUpdatedBy: author, titleUpdatedAt: at };
};

/** Bound state for `saveProfileTitle`. */
type SaveProfileTitleState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Durable title saved with its attribution stamps. */
  title: Writable<string | Default<"">>;

  /** Session title draft awaiting an explicit save. */
  titleDraft: Writable<string>;

  /** Session editor visibility after a successful save. */
  editingTitle: Writable<boolean>;

  /** Author snapshot of the latest title save. */
  titleUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;

  /** Timestamp of the latest title save. */
  titleUpdatedAt: Writable<number | Default<0>>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser title save under the current Profile snapshot. The header binds a
 * session draft, never the durable title: a live-bound shared string would
 * conflict per keystroke, and a title write outside `persistTitle` would
 * leave `titleUpdatedBy` and the activity clock describing an earlier
 * rename. */
export const saveProfileTitle = handler<void, SaveProfileTitleState>(
  toSchema<void>(),
  {
    ...SAVE_PROFILE_TITLE_STATE_SCHEMA,
    properties: {
      ...SAVE_PROFILE_TITLE_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (
    _,
    {
      upgrade,
      title,
      titleDraft,
      editingTitle,
      titleUpdatedBy,
      titleUpdatedAt,
      profileName,
      profileAvatar,
    },
  ) => {
    const text = titleDraft.get();
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!text.trim() || !author) return;
    upgradeTopicState(upgrade.get(), "saveProfileTitle");
    persistTitle(title, titleUpdatedBy, titleUpdatedAt, text, author);
    editingTitle.set(false);
  },
);

/** Bound state for `saveProfileBody`. */
type SaveProfileBodyState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Durable prose saved with its references and attribution. */
  body: Writable<string | Default<"">>;

  /** Session prose draft awaiting an explicit save. */
  bodyDraft: Writable<string>;

  /** Durable mention map published with the body. */
  references: Writable<
    // deno-lint-ignore ban-types
    TopicMentionRefMap | Default<{}>
  >;

  /** Session mention map accompanying the body draft. */
  referencesDraft: Writable<TopicMentionRefMap>;

  /** Session editor visibility after a successful save. */
  editingBody: Writable<boolean>;

  /** Author snapshot of the latest body save. */
  bodyUpdatedBy: Writable<
    TopicAuthor | Default<{ kind: "person"; name: "" }>
  >;

  /** Timestamp of the latest body save. */
  bodyUpdatedAt: Writable<number | Default<0>>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser body save under the current Profile snapshot. */
export const saveProfileBody = handler<void, SaveProfileBodyState>(
  toSchema<void>(),
  {
    ...SAVE_PROFILE_BODY_STATE_SCHEMA,
    properties: {
      ...SAVE_PROFILE_BODY_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (
    _,
    {
      upgrade,
      body,
      bodyDraft,
      references,
      referencesDraft,
      editingBody,
      bodyUpdatedBy,
      bodyUpdatedAt,
      profileName,
      profileAvatar,
    },
  ) => {
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!author) return;
    upgradeTopicState(upgrade.get(), "saveProfileBody");
    // One whole-value set per explicit save keeps the conflict window small; a
    // live-bound textarea on a shared string would conflict per keystroke.
    body.set(bodyDraft.get());
    // The map publishes with the prose it describes, in this one transaction:
    // the tokens and the destinations they name are one document, and a save
    // that landed only half of it would leave a dead link either way. Whole-map,
    // for the same reason the body above is whole-value — an entry belongs to
    // the draft that minted it, and the two conflict as one document or not at
    // all. `destination` is `unknown`, which is what carries each one across as
    // a link rather than expanding the piece behind it.
    references.set(referencesDraft.get());
    bodyUpdatedBy.set(author);
    bodyUpdatedAt.set(Date.now());
    editingBody.set(false);
  },
);

/** Bound state for `dropMention`. */
type DropMentionState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Durable set of verb-made piece references. */
  mentioned: Writable<unknown[] | Default<[]>>;

  // A CELL, because `removeByValue` matches a cell by its link. Bound as a
  // plain value it would arrive resolved, match nothing, and remove nothing.
  /** Original piece cell selected for reference removal. */
  topic: Writable<unknown>;
};

/**
 * Drop one verb-made reference from the browser.
 *
 * A handler rather than an inline closure because the card renders one control
 * per entry, and each has to carry the piece it removes. Retracting is
 * `removeByValue` here for the same reason it is in `unmention`: it resolves
 * against durable state instead of rewriting the list.
 */
export const dropMention = handler<void, DropMentionState>(
  toSchema<void>(),
  {
    ...DROP_MENTION_STATE_SCHEMA,
    properties: {
      ...DROP_MENTION_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (_, { upgrade, mentioned, topic }) => {
    if (!topic) return;
    upgradeTopicState(upgrade.get(), "dropMention");
    mentioned.removeByValue(topic);
  },
);

/** Bound state for `retractProfileLink`. */
type RetractProfileLinkState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Stored links containing the mutation target. */
  links: Writable<TopicLink[] | Default<[]>>;

  /** Original link cell selected for retraction. */
  link: Writable<TopicLink>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser link retraction under the current Profile snapshot.
 *
 * The reference form of `removeLink`, bound the way
 * {@link retractProfileComment} is bound and for the same reasons. A stamped
 * link additionally stops resolving into `mentions`, so this control retracts
 * a reference as well as a row. */
export const retractProfileLink = handler<void, RetractProfileLinkState>(
  toSchema<void>(),
  {
    ...RETRACT_PROFILE_LINK_STATE_SCHEMA,
    properties: {
      ...RETRACT_PROFILE_LINK_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (_, { upgrade, links, link, profileName, profileAvatar }) => {
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!author) return;
    if (!link || link.get() === undefined) return;
    if (!isElementOf(links, link)) return;
    if (link.get()?.removedAt !== undefined) return;
    upgradeTopicState(upgrade.get(), "retractProfileLink");
    link.key("removedAt").set(Date.now());
    link.key("removedBy").set(author);
  },
);

/** Bound state for `submitProfileLink`. */
type SubmitProfileLinkState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** Stored links containing the mutation target. */
  links: Writable<TopicLink[] | Default<[]>>;

  /** Session URL draft validated before link creation. */
  linkUrlDraft: Writable<string>;

  /** Session label draft accompanying the URL. */
  linkLabelDraft: Writable<string>;

  /** Session link category draft. */
  linkKindDraft: Writable<TopicLinkKind>;

  /** Resolved canonical Profile name for attribution. */
  profileName: string;

  /** Resolved canonical Profile avatar for attribution. */
  profileAvatar: string;
};

/** Browser link submit under the current Profile snapshot. */
export const submitProfileLink = handler<void, SubmitProfileLinkState>(
  toSchema<void>(),
  {
    ...SUBMIT_PROFILE_LINK_STATE_SCHEMA,
    properties: {
      ...SUBMIT_PROFILE_LINK_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (
    _,
    {
      upgrade,
      links,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      profileName,
      profileAvatar,
    },
  ) => {
    const url = linkUrlDraft.get();
    const author = topicAuthorFromPerson(profileName, profileAvatar);
    if (!url.trim() || !isSafeLinkUrl(url) || !author) return;
    upgradeTopicState(upgrade.get(), "submitProfileLink");
    appendLink(links, url, linkKindDraft.get(), linkLabelDraft.get(), author);
    linkUrlDraft.set("");
    linkLabelDraft.set("");
    linkKindDraft.set("web");
  },
);

// ===== Derivations =====
//
// Each of these is a module-scope `lift` rather than a pattern-body derivation
// for one reason: the declared parameter type is what bounds the read. An
// inferred input schema falls back to reading its input whole, while a `lift`'s
// declared parameter is a ceiling that no opaque helper in its body can widen.

/**
 * This topic's INBOUND references: its own row of the board's pivot.
 *
 * The board has already done the join, so this is a lookup, and it is written
 * as one — find the row whose `topic` is this piece, hand back its
 * `mentionedBy`. Nothing else about the table is touched.
 *
 * It re-runs whenever any row changes, which at board scale is often. That is
 * fine, and deliberately so: the rows are addressed by the topic each describes
 * rather than by position, so a re-run over an unchanged board recomputes the
 * same links and writes nothing. What would make it expensive is reading
 * through the references, which is why the parameter declares them `unknown`:
 * `topic` is compared by identity and `mentionedBy` is passed through as links,
 * so surveying the whole table expands no topic at all.
 *
 * HACK, as elsewhere in this pattern: reads `unknown[]`, publishes
 * `TopicSummary[]`. A reference through a lift is a link and resolves to the
 * whole topic however little the lift declared, so the assertion states what a
 * consumer receives while the narrow parameter bounds what this reads.
 */
const backlinksOf = lift((
  { table, self }: {
    table:
      | { topic: ComparableCell<unknown>; mentionedBy: unknown[] }[]
      | Default<[]>;
    self: ComparableCell<unknown>;
  },
): TopicSummary[] =>
  // `filter` + `flatMap` rather than `find`, so a topic with no row on the
  // table — no board wired in — yields an empty array from the shape of the
  // expression instead of from a `?? []` bolted onto a miss. At most one row
  // matches: the board's pivot builds one row per distinct topic, compared by
  // `equals` as this lookup compares.
  table
    .filter((row) => equals(self, row.topic))
    .flatMap((row) => row.mentionedBy) as TopicSummary[]
);

/**
 * Every piece this topic points at, from both places a reference can come from:
 * the body editor's mention map, and a link whose URL names a piece.
 *
 * The two arrive already resolved — the editor mints a mention as a reference,
 * and `cellFromUrl` answers a link's URL with the cell it names. So this only
 * concatenates, and the parameter says as much: `destination` and the resolved
 * cells are `unknown`, compared by identity and never read through.
 *
 * A URL naming no piece resolves with no cell, which is how an ordinary web
 * link stays an ordinary web link.
 */
const mentionsOf = lift((
  { references, mentioned, linkTargets }: {
    // deno-lint-ignore ban-types
    references: Record<string, { destination: unknown }> | Default<{}>;
    mentioned: unknown[] | Default<[]>;
    linkTargets: { cell?: unknown; pending?: boolean }[] | Default<[]>;
  },
): unknown[] =>
  [
    // Three places a reference can come from, and only the last two are this
    // pattern's to write: the body editor's map, the `mention` verb's list,
    // and a link whose URL named a piece.
    ...Object.values(references).map((ref) => ref?.destination),
    ...mentioned,
    ...linkTargets.map((resolution) => resolution?.cell),
  ].filter((destination) => destination !== undefined && destination !== null)
);

/** How many comments are there to read — retracted ones excluded, because the
 * board's card would otherwise promise more than the topic shows.
 *
 * A module-scope `lift` rather than a `computed()` in the pattern body, and
 * the difference is load-bearing: this value is in the board's demand, so it
 * is projected onto every stored topic including generations written before
 * retraction existed. The lift declares `removedAt` in its own parameter,
 * which is what makes the property visible to the read at all. */
const presentCommentCountOf = lift((
  { comments }: { comments: { removedAt?: number }[] },
): number => comments.filter((c) => c.removedAt === undefined).length);

/** Max of creation, the newest comment, the newest link, the last body save,
 * and the last rename — declared over just those five timestamp surfaces.
 *
 * Every retracted and edited record still counts here, and that is the point
 * rather than an oversight. This is a max over what the arrays hold, so
 * skipping a retracted record would let the answer move BACKWARDS when the
 * newest comment is the one retracted, reordering the board under a reader.
 * A stamped retraction cannot do that, and a retraction is itself activity,
 * so its own stamp moves the clock forward. */
const lastActivityOf = lift((
  { comments, links, createdAt, bodyUpdatedAt, titleUpdatedAt }: {
    comments: { sentAt: number; editedAt?: number; removedAt?: number }[];
    links: { addedAt?: number; removedAt?: number }[];
    createdAt: number;
    bodyUpdatedAt: number;
    titleUpdatedAt: number;
  },
): number => {
  let newest = Math.max(createdAt, bodyUpdatedAt, titleUpdatedAt);
  for (const c of comments) {
    newest = Math.max(newest, c.sentAt, c.editedAt ?? 0, c.removedAt ?? 0);
  }
  // `addedAt` is optional on TopicLink: links written before it existed carry
  // no timestamp and simply do not move the clock.
  for (const l of links) {
    newest = Math.max(newest, l.addedAt ?? 0, l.removedAt ?? 0);
  }
  return newest;
});

/** The structured author, projected rather than returned as a dangling link to
 * an absent optional input path, so a sibling Topic's schema can validate the
 * piece. A topic with no author reads as the inert sentinel rather than as
 * nothing. */
const createdByOf = lift((
  { createdBy }: { createdBy?: TopicAuthor },
): TopicAuthor =>
  createdBy && createdBy.name.trim() ? createdBy : { kind: "person", name: "" }
);

/** Handles `addComment` after bringing durable Topic state up to date. */
const addCommentHandler = handler<
  AddCommentEvent,
  TopicWriteState<"comments">,
  AddCommentResult
>(
  toSchema<AddCommentEvent>(),
  {
    ...COMMENTS_WRITE_SCHEMA,
    properties: {
      ...COMMENTS_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ body: text, agentName }, { upgrade, comments }) => {
    const trimmed = (text ?? "").trim();
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("addComment", "agentName must be non-blank");
    if (!trimmed) rejectMutation("addComment", "body must be non-empty");
    upgradeTopicState(upgrade.get(), "addComment");
    return { comment: appendComment(comments, trimmed, author) };
  },
);

/** Handles `addLink` after bringing durable Topic state up to date. */
const addLinkHandler = handler<
  AddLinkEvent,
  TopicWriteState<"links">,
  AddLinkResult
>(
  toSchema<AddLinkEvent>(),
  {
    ...LINKS_WRITE_SCHEMA,
    properties: {
      ...LINKS_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ kind, url, label, agentName }, { upgrade, links }) => {
    const trimmedUrl = (url ?? "").trim();
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("addLink", "agentName must be non-blank");
    if (!trimmedUrl) rejectMutation("addLink", "url must be non-empty");
    if (!isSafeLinkUrl(trimmedUrl)) {
      rejectMutation("addLink", "url must be http(s)");
    }
    upgradeTopicState(upgrade.get(), "addLink");
    return { link: appendLink(links, trimmedUrl, kind, label, author) };
  },
);

/** Handles `removeComment` after bringing durable Topic state up to date. */
const removeCommentHandler = handler<
  RemoveCommentEvent,
  TopicWriteState<"comments">,
  RemoveCommentResult
>(
  toSchema<RemoveCommentEvent>(),
  {
    ...COMMENTS_WRITE_SCHEMA,
    properties: {
      ...COMMENTS_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ comment, agentName }, { upgrade, comments }) => {
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("removeComment", "agentName must be non-blank");
    // The same reference check `mention` makes, and it earns its place for
    // the same reason: a payload that is not a reference has no stored
    // element behind it, so the writes below would land on nothing and
    // report success.
    if (!comment || comment.get() === undefined) {
      rejectMutation("removeComment", "comment must be a reference");
    }
    if (!isElementOf(comments, comment)) {
      rejectMutation("removeComment", "comment is not on this topic");
    }
    if (comment.get()?.removedAt !== undefined) {
      rejectMutation("removeComment", "comment is already retracted");
    }
    upgradeTopicState(upgrade.get(), "removeComment");
    const removedAt = Date.now();
    // Two field writes into the element the caller named, not a rewrite of
    // the array. Concurrent retractions of distinct comments merge, and
    // every surviving reference stays a reference.
    comment.key("removedAt").set(removedAt);
    comment.key("removedBy").set(author);
    return { removedAt, removedBy: author };
  },
);

/** Handles `editComment` after bringing durable Topic state up to date. */
const editCommentHandler = handler<
  EditCommentEvent,
  TopicWriteState<"comments">,
  EditCommentResult
>(
  toSchema<EditCommentEvent>(),
  {
    ...COMMENTS_WRITE_SCHEMA,
    properties: {
      ...COMMENTS_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ comment, body: text, agentName }, { upgrade, comments }) => {
    // Checked, not bound: `editComment` requires a signature like every
    // other mutation here, and then stores nothing from it. `author` and
    // `sentAt` stay as the comment was written — an edit changes what was
    // said, not who said it. Fabric still records the principal behind
    // the write.
    if (!topicAuthorFromAgent(agentName)) {
      rejectMutation("editComment", "agentName must be non-blank");
    }
    if (!comment || comment.get() === undefined) {
      rejectMutation("editComment", "comment must be a reference");
    }
    if (!isElementOf(comments, comment)) {
      rejectMutation("editComment", "comment is not on this topic");
    }
    if (comment.get()?.removedAt !== undefined) {
      rejectMutation("editComment", "comment is retracted");
    }
    const trimmed = (text ?? "").trim();
    if (!trimmed) rejectMutation("editComment", "body must be non-empty");
    upgradeTopicState(upgrade.get(), "editComment");
    const editedAt = Date.now();
    comment.key("body").set(trimmed);
    comment.key("editedAt").set(editedAt);
    return { body: trimmed, editedAt };
  },
);

/** Handles `removeLink` after bringing durable Topic state up to date. */
const removeLinkHandler = handler<
  RemoveLinkEvent,
  TopicWriteState<"links">,
  RemoveLinkResult
>(
  toSchema<RemoveLinkEvent>(),
  {
    ...LINKS_WRITE_SCHEMA,
    properties: {
      ...LINKS_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ link, url, agentName }, { upgrade, links }) => {
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("removeLink", "agentName must be non-blank");
    const named = (url ?? "").trim();
    if (link && named) {
      rejectMutation("removeLink", "pass link or url, not both");
    }
    let target = link;
    if (!target) {
      if (!named) {
        rejectMutation("removeLink", "pass link or url");
      }
      // The url spelling resolves to an element the same way the reference
      // spelling arrives as one, so both paths stamp a stored record.
      // Newest first, so retracting twice retracts two rather than
      // re-stamping the one already gone.
      const stored = links.get();
      for (let i = stored.length - 1; i >= 0; i--) {
        const candidate = stored[i];
        if (candidate?.url === named && isPresent(candidate)) {
          target = links.key(i) as typeof link;
          break;
        }
      }
      if (!target) {
        rejectMutation("removeLink", `no link present with url ${named}`);
      }
    } else if (target.get() === undefined) {
      rejectMutation("removeLink", "link must be a reference");
    } else if (!isElementOf(links, target)) {
      rejectMutation("removeLink", "link is not on this topic");
    } else if (target.get()?.removedAt !== undefined) {
      rejectMutation("removeLink", "link is already retracted");
    }
    upgradeTopicState(upgrade.get(), "removeLink");
    const removedAt = Date.now();
    target!.key("removedAt").set(removedAt);
    target!.key("removedBy").set(author);
    return {
      url: target!.get()?.url ?? named,
      removedAt,
      removedBy: author,
    };
  },
);

/** Handles `setBody` after bringing durable Topic state up to date. */
const setBodyHandler = handler<
  SetBodyEvent,
  TopicWriteState<"body" | "bodyUpdatedBy" | "bodyUpdatedAt">,
  SetBodyResult
>(
  toSchema<SetBodyEvent>(),
  {
    ...BODY_WRITE_SCHEMA,
    properties: {
      ...BODY_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (
    { body: text, agentName },
    { upgrade, body, bodyUpdatedBy, bodyUpdatedAt },
  ) => {
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("setBody", "agentName must be non-blank");
    const persisted = text ?? "";
    upgradeTopicState(upgrade.get(), "setBody");
    body.set(persisted);
    const bodyUpdatedAtValue = Date.now();
    bodyUpdatedBy.set(author);
    bodyUpdatedAt.set(bodyUpdatedAtValue);
    return {
      body: persisted,
      bodyUpdatedBy: author,
      bodyUpdatedAt: bodyUpdatedAtValue,
    };
  },
);

/** Handles `setTitle` after bringing durable Topic state up to date. */
const setTitleHandler = handler<
  SetTitleEvent,
  TopicWriteState<"title" | "titleUpdatedBy" | "titleUpdatedAt">,
  SetTitleResult
>(
  toSchema<SetTitleEvent>(),
  {
    ...TITLE_WRITE_SCHEMA,
    properties: {
      ...TITLE_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  (
    { title: text, agentName },
    { upgrade, title, titleUpdatedBy, titleUpdatedAt },
  ) => {
    const trimmed = (text ?? "").trim();
    const author = topicAuthorFromAgent(agentName ?? "") ??
      rejectMutation("setTitle", "agentName must be non-blank");
    if (!trimmed) rejectMutation("setTitle", "title must be non-empty");
    upgradeTopicState(upgrade.get(), "setTitle");
    return persistTitle(
      title,
      titleUpdatedBy,
      titleUpdatedAt,
      trimmed,
      author,
    );
  },
);

/** Handles `mention` after bringing durable Topic state up to date. */
const mentionHandler = handler<MentionEvent, TopicWriteState<"mentioned">>(
  toSchema<MentionEvent>(),
  {
    ...MENTIONED_WRITE_SCHEMA,
    properties: {
      ...MENTIONED_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ topic }, { upgrade, mentioned }) => {
    // A reference, or a rejection. The schema wraps whatever it is handed as
    // a cell without looking behind it, so this is the boundary — and the
    // narrowed payload is what makes it one read of one field: `undefined`
    // is a value with no document behind it, and any real piece answers with
    // an object because `title` carries a default.
    if (!topic || topic.get() === undefined) {
      rejectMutation("mention", "topic must be a reference");
    }
    // A set-add, not an append: referencing the same piece twice is one
    // reference. Mergeable, so concurrent mentions of distinct pieces all
    // land and a repeated one is a no-op against durable state.
    upgradeTopicState(upgrade.get(), "mention");
    mentioned.addUnique(topic);
  },
);

/** Handles `unmention` after bringing durable Topic state up to date. */
const unmentionHandler = handler<UnmentionEvent, TopicWriteState<"mentioned">>(
  toSchema<UnmentionEvent>(),
  {
    ...MENTIONED_WRITE_SCHEMA,
    properties: {
      ...MENTIONED_WRITE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ topic }, { upgrade, mentioned }) => {
    // Same check as `mention`, and it earns its place here too: a payload
    // that is not a reference matches no stored entry, so the removal below
    // would quietly do nothing and report success.
    if (!topic || topic.get() === undefined) {
      rejectMutation("unmention", "topic must be a reference");
    }
    // `removeByValue`, not `remove` or `removeAll`: those two rebuild the
    // array and set it back, which is both a clobbering write and the shape
    // that flattens surviving references. This one resolves against durable
    // state, so concurrent removals of distinct entries merge.
    upgradeTopicState(upgrade.get(), "unmention");
    mentioned.removeByValue(topic);
  },
);

/** Bound state for `recordName`. */
type RecordNameState = {
  /** Shared upgrade handles for this Topic. */
  upgrade: Writable<TopicUpgradeState>;

  /** The topic's own stored number, absent until a call records one. The
   * writable handle the write needs, over an input every other reader takes
   * as the plain string it holds. */
  shortName: Writable<string | undefined>;
};

/** Handles `recordName` after bringing durable Topic state up to date. */
const recordNameHandler = handler<
  RecordNameEvent,
  RecordNameState,
  RecordNameResult
>(
  toSchema<RecordNameEvent>(),
  {
    ...RECORD_NAME_STATE_SCHEMA,
    properties: {
      ...RECORD_NAME_STATE_SCHEMA.properties,
      upgrade: { ...TOPIC_UPGRADE_SCHEMA, asCell: ["cell"] },
    },
  },
  ({ name }, { upgrade, shortName }) => {
    const given = (name ?? "").trim();
    // The grammar is the whole of what a topic can check: it holds no
    // namespace to look the number up in, which is what keeps this verb from
    // reading its board — or, through a board table, every sibling topic.
    if (!isMemberName(given)) {
      rejectMutation("recordName", `name must be a member name: \`${given}\``);
    }
    const stored = shortName.get();
    // A number is permanent and never reused, so a topic holding one holds
    // it. Naming that same number is a caller's repeat — the board's step
    // re-sends whatever it cannot see stored yet — and naming a different one
    // is a mistake worth refusing rather than a correction to apply.
    if (stored === given) return { name: given, wrote: false };
    if (stored !== undefined && stored !== "") {
      rejectMutation("recordName", `topic already stores \`${stored}\``);
    }
    upgradeTopicState(upgrade.get(), "recordName");
    shortName.set(given);
    return { name: given, wrote: true };
  },
);

// ===== The pattern =====

export default pattern<TopicInput, TopicOutput>(
  (
    {
      title,
      body,
      comments,
      links,
      createdAt,
      createdBy,
      createdByName,
      topicStateVersion,
      bodyUpdatedBy,
      bodyUpdatedAt,
      titleUpdatedBy,
      titleUpdatedAt,
      mentionable,
      references,
      mentioned,
      boardCrossrefs,
      // The number this topic STORES; `shortName` below is what it shows.
      // Named apart because `upgradeLegacyAuthors` already uses `storedName`
      // for an author's name.
      shortName: storedNumber,
      [SELF]: self,
    },
  ) => {
    const upgrade = { topicStateVersion, createdByName, createdBy, comments };
    migrateTopicState(upgrade);

    // Session-local UI state (new-tab test: none of this should carry over).
    const commentDraft = new Writable.perSession("");
    const editingBody = new Writable.perSession(false);
    const bodyDraft = new Writable.perSession("");
    const editingTitle = new Writable.perSession(false);
    const titleDraft = new Writable.perSession("");
    const linkUrlDraft = new Writable.perSession("");
    const linkLabelDraft = new Writable.perSession("");
    const linkKindDraft = new Writable.perSession<TopicLinkKind>("web");
    const referencesDraft = new Writable.perSession<TopicMentionRefMap>({});

    // Browser mutations snapshot the current viewer's canonical Profile.
    // Agent-facing streams below deliberately remain wish-free and accept the
    // agent's content-level signature in the same event as the mutation.
    // One wish, not three: `#profile` resolves the profile itself, and `name`
    // and `avatar` are fields on it.
    const profileWish = wish<{ name: string; avatar: string }>({
      query: "#profile",
    });
    // A wish resolves after setup, so each of these stays a derivation. Reading
    // the fields once here would pin the page to the empty profile the topic
    // opened with: the composer's controls never enable, and a comment or edit
    // made through them carries blank attribution.
    const profileName = profileWish.result?.name ?? "";
    const profileAvatar = profileWish.result?.avatar ?? "";
    const hasProfile = profileName.trim().length > 0;
    const createdByView = createdByOf({ createdBy });
    // The number the topic shows and publishes, out of the number it stores.
    // Every reader of a topic's number reads this, so gating it here hides the
    // number from all of them, whatever the topic's mention universe is wired
    // to. The store is untouched: `recordName` writes the input and reads it
    // back to stay idempotent, both while the switch is off.
    const shortName = SHOW_TOPIC_NUMBERS ? storedNumber : undefined;

    // --- Streams (external API; also usable headlessly via CLI) ---

    const addComment = addCommentHandler({ upgrade, comments });

    const addLink = addLinkHandler({ upgrade, links });

    const removeComment = removeCommentHandler({ upgrade, comments });

    const editComment = editCommentHandler({ upgrade, comments });

    const removeLink = removeLinkHandler({ upgrade, links });

    const setBody = setBodyHandler({
      upgrade,
      body,
      bodyUpdatedBy,
      bodyUpdatedAt,
    });

    const setTitle = setTitleHandler({
      upgrade,
      title,
      titleUpdatedBy,
      titleUpdatedAt,
    });

    /**
     * Record a reference to another piece.
     *
     * Writes the destination ITSELF into the map — no address is parsed, no id
     * is minted for the target, and nothing is written into the target. What
     * makes this an edge is that the stored value and the piece are the same
     * cell.
     *
     * The entry carries a key but no prose token, so a mention made this way is
     * a reference without a sentence around it. The editor leaves it alone: it
     * only collects keys it saw when the document loaded or minted itself, so a
     * key that arrived from elsewhere is kept.
     */
    const mention = mentionHandler({ upgrade, mentioned });

    /** Stop referencing a piece — every entry naming it. */
    const unmention = unmentionHandler({ upgrade, mentioned });

    /** Store the number the board calls this topic by. */
    const recordName = recordNameHandler({ upgrade, shortName: storedNumber });

    // --- UI-side actions (close over session drafts) ---

    const submitComment = submitProfileComment({
      upgrade,
      comments,
      commentDraft,
      profileName,
      profileAvatar,
    });

    const startEditTitle = action(() => {
      titleDraft.set(title.get());
      editingTitle.set(true);
    });

    const saveTitle = saveProfileTitle({
      upgrade,
      title,
      titleDraft,
      editingTitle,
      titleUpdatedBy,
      titleUpdatedAt,
      profileName,
      profileAvatar,
    });

    // Nothing to undo: the draft is session-local, so leaving it behind IS
    // the discard.
    const cancelEditTitle = action(() => {
      editingTitle.set(false);
    });

    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      // Seeded together with the prose, so the editor opens on a map that
      // resolves every token the draft carries. Each `destination` crosses as
      // a link, which is what `unknown` is declared for.
      referencesDraft.set(references.get());
      editingBody.set(true);
    });

    const saveBody = saveProfileBody({
      upgrade,
      body,
      bodyDraft,
      references,
      referencesDraft,
      editingBody,
      bodyUpdatedBy,
      bodyUpdatedAt,
      profileName,
      profileAvatar,
    });

    // Nothing to undo: the prose and its mention map are both session drafts,
    // so leaving them behind IS the discard.
    const cancelEditBody = action(() => {
      editingBody.set(false);
    });

    const submitLink = submitProfileLink({
      upgrade,
      links,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      profileName,
      profileAvatar,
    });

    // --- Derived values ---

    // Each of these reads its own topic's data, which the page renders in full
    // anyway, and the shrunk schemas say so: a `.length` read declares
    // `items: unknown` and never expands an element.
    //
    // Each filtered view goes inside `computed()`: a method call on an opaque
    // pattern value is not lowerable on its own. The retraction rule is the
    // same in both — a stamped record is not there to read — and only
    // `lastActivityAt` below is deliberately exempt from it. Whatever else
    // needs the retraction rule reads one of those two, or the count beside
    // them, rather than applying it a second time.

    // A count of what is there to read, so retracted comments are excluded —
    // the board's card would otherwise promise more comments than the topic
    // shows.
    const commentCount = presentCommentCountOf({ comments });

    const lastActivityAt = lastActivityOf({
      comments,
      links,
      createdAt,
      bodyUpdatedAt,
      titleUpdatedAt,
    });

    // This keeps its own pass over the predicate, and that is the whole of
    // the sharing left to do: the only other reader is `presentCommentCountOf`
    // above, which has to stay a module-scope lift because the board demands
    // it. Two readers is the floor a shared intermediate could reach, so one
    // would add a node and remove no work — and widening the lift to hand back
    // records instead of a count would broaden what the board reads, which is
    // the thing this stage is not allowed to do.
    const commentsView = computed(() =>
      comments.get().filter((c) => c.removedAt === undefined).toSorted((a, b) =>
        a.sentAt - b.sentAt
      )
    );

    const linksView = computed(() =>
      links.get().filter((l) => l.removedAt === undefined)
    );
    // Each presence boolean reads the derivation above it rather than the
    // records: `linksView` answers for a length alone, and `commentCount`
    // is already the count of comments there are to read.
    const hasLinks = linksView.length > 0;
    const hasComments = commentCount > 0;
    const hasBody = body.get().trim().length > 0;

    // Inbound: who points at this topic, looked up in the board's pivot rather
    // than derived a second time.
    const referencedBy = backlinksOf({
      table: boardCrossrefs,
      self,
    });
    const hasReferences = referencedBy.length > 0;
    // Only what THIS pattern owns is offered for removal. The union `mentions`
    // also carries the editor's map and the link resolutions, and a control
    // here could not honestly retract either: a mention in the prose is removed
    // by editing the prose, and a link's reference belongs to the link.
    const mentionedView = mentioned.get();
    const hasMentioned = mentionedView.length > 0;

    const topicName = title.get().trim() || "(untitled topic)";

    // Declared BEFORE the link resolution below, and the ordering is
    // load-bearing rather than stylistic. A `.map()` over a reactive array
    // lowers to an inline pattern, and inline patterns are NUMBERED IN SOURCE
    // ORDER. A deployed piece records the number it was instantiated from, so
    // inserting a new map ahead of an existing one renumbers that one and
    // strands every piece already made by it — `deno task pattern-vintage`
    // reports it as a refused update, which is how this was found. New maps
    // therefore go after the ones already here, and the rendered view holds
    // two of them.
    const view = (
      <cf-theme theme={TOPICS_THEME}>
        <cf-screen>
          <cf-vstack slot="header" gap="1" padding="4">
            {editingTitle
              ? (
                <cf-hstack gap="2" align="center">
                  <cf-input
                    $value={titleDraft}
                    placeholder="Topic title…"
                    style="font-size: 1.25rem; font-weight: 600; flex: 1;"
                  />
                  <cf-button
                    variant="primary"
                    disabled={!hasProfile}
                    onClick={saveTitle}
                  >
                    Save
                  </cf-button>
                  <cf-button variant="ghost" onClick={cancelEditTitle}>
                    Cancel
                  </cf-button>
                </cf-hstack>
              )
              : (
                <cf-hstack gap="2" justify="between" align="center">
                  <cf-hstack
                    gap="2"
                    align="center"
                    style="flex: 1; min-width: 0;"
                  >
                    {shortName
                      ? (
                        <cf-badge size="sm" color="primary" data-member-name="">
                          {shortName}
                        </cf-badge>
                      )
                      : null}
                    <cf-text
                      block
                      style="font-size: 1.25rem; font-weight: 600;"
                    >
                      {topicName}
                    </cf-text>
                  </cf-hstack>
                  <cf-button
                    variant="ghost"
                    disabled={!hasProfile}
                    onClick={startEditTitle}
                  >
                    Rename
                  </cf-button>
                </cf-hstack>
              )}
            <cf-hstack justify="between" align="center">
              <cf-text variant="caption" tone="muted">
                started by {topicAuthorLabel(createdByView)}
                {createdAt ? ` · ${whenLabel(createdAt)}` : ""}
              </cf-text>
              <cf-hstack gap="2" align="center">
                <cf-text variant="caption" tone="muted">Acting as</cf-text>
                {hasProfile
                  ? (
                    <cf-profile-badge
                      $profile={profileWish.result}
                      size="sm"
                      noNavigate
                    />
                  )
                  : <div>{profileWish[UI]}</div>}
              </cf-hstack>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="3" padding="4">
            {/* ── The living body document ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack justify="between" align="center">
                  <cf-heading level={5}>Body</cf-heading>
                  {editingBody ? null : (
                    <cf-button
                      variant="secondary"
                      disabled={!hasProfile}
                      onClick={startEditBody}
                    >
                      Edit
                    </cf-button>
                  )}
                </cf-hstack>

                {editingBody
                  ? (
                    <cf-vstack gap="2">
                      <cf-code-editor
                        $value={bodyDraft}
                        $mentionable={mentionable}
                        $references={referencesDraft}
                        language="text/markdown"
                        mode="prose"
                        wordWrap
                        tabIndent
                        placeholder="The topic's living document…"
                        style="min-height: 12rem;"
                      />
                      <cf-hstack gap="2">
                        <cf-button
                          variant="primary"
                          disabled={!hasProfile}
                          onClick={saveBody}
                        >
                          Save
                        </cf-button>
                        <cf-button variant="ghost" onClick={cancelEditBody}>
                          Cancel
                        </cf-button>
                      </cf-hstack>
                    </cf-vstack>
                  )
                  : hasBody
                  ? <cf-markdown content={body} />
                  : (
                    <cf-text tone="muted" block>
                      No body yet. The body is this topic's living document —
                      durable conclusions get folded up here while the thread
                      below holds the deliberation.
                    </cf-text>
                  )}
                {bodyUpdatedAt.get()
                  ? (
                    <cf-text variant="caption" tone="muted">
                      Last updated by {topicAuthorLabel(bodyUpdatedBy.get())}
                      {" · "}
                      {whenLabel(bodyUpdatedAt.get() ?? 0)}
                    </cf-text>
                  )
                  : null}
              </cf-vstack>
            </cf-card>

            {/* ── Links out ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-heading level={5}>Links</cf-heading>
                {hasLinks
                  ? (
                    <cf-vstack gap="1">
                      {linksView.map((link) => (
                        <cf-hstack gap="2" align="center" data-link-row="">
                          <cf-badge size="xs" color="neutral">
                            {link.kind}
                          </cf-badge>
                          {isSafeLinkUrl(link.url)
                            ? (
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noreferrer"
                                style="color: inherit;"
                              >
                                {link.label || link.url}
                              </a>
                            )
                            : (
                              <cf-text tone="muted">
                                {link.label || link.url}
                              </cf-text>
                            )}
                          {link.addedBy
                            ? (
                              <cf-text variant="caption" tone="muted">
                                by {topicAuthorLabel(link.addedBy)}
                              </cf-text>
                            )
                            : null}
                          <cf-button
                            variant="ghost"
                            size="sm"
                            disabled={!hasProfile}
                            data-retract="link"
                            onClick={retractProfileLink({
                              upgrade,
                              links,
                              link,
                              profileName,
                              profileAvatar,
                            })}
                          >
                            Retract
                          </cf-button>
                        </cf-hstack>
                      ))}
                    </cf-vstack>
                  )
                  : (
                    <cf-text tone="muted" block>
                      No links yet — PRs, agent sessions, other topics.
                    </cf-text>
                  )}
                <cf-hstack gap="2" align="end">
                  <cf-field label="Kind" style="width: 130px;">
                    <cf-select
                      $value={linkKindDraft}
                      items={LINK_KIND_ITEMS}
                    />
                  </cf-field>
                  <cf-field label="URL" style="flex: 1;">
                    <cf-input $value={linkUrlDraft} placeholder="https://…" />
                  </cf-field>
                  <cf-field label="Label" style="width: 180px;">
                    <cf-input
                      $value={linkLabelDraft}
                      placeholder="optional"
                    />
                  </cf-field>
                  <cf-button
                    variant="secondary"
                    disabled={!hasProfile}
                    onClick={submitLink}
                  >
                    Add
                  </cf-button>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            {/* ── The thread ── */}
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack justify="between" align="center">
                  <cf-heading level={5}>Thread</cf-heading>
                  <cf-text variant="caption" tone="muted">
                    {commentCount} comments
                  </cf-text>
                </cf-hstack>

                {hasComments
                  ? (
                    <cf-vstack gap="2">
                      {commentsView.map((comment) => (
                        <cf-vstack
                          gap="0"
                          data-comment-row=""
                          style="border-left: 2px solid var(--cf-theme-color-border); padding-left: 0.75rem;"
                        >
                          <cf-hstack gap="2" align="center">
                            <cf-avatar
                              src={comment.author?.avatar || ""}
                              name={topicAuthorLabel(comment.author)}
                              size="xs"
                            />
                            <cf-text style="font-weight: 600;">
                              {topicAuthorLabel(comment.author)}
                            </cf-text>
                            <cf-text variant="caption" tone="muted">
                              {whenLabel(comment.sentAt)}
                            </cf-text>
                            {
                              /* An edit is only honest if a reader can see one
                                happened. `editedAt` says the body is no longer
                                what its author sent, and `sentAt` deliberately
                                still reads as when the thread reached here. */
                            }
                            {comment.editedAt
                              ? (
                                <cf-text
                                  variant="caption"
                                  tone="muted"
                                  data-edited=""
                                >
                                  edited
                                </cf-text>
                              )
                              : null}
                            <cf-button
                              variant="ghost"
                              size="sm"
                              disabled={!hasProfile}
                              data-retract="comment"
                              onClick={retractProfileComment({
                                upgrade,
                                comments,
                                comment,
                                profileName,
                                profileAvatar,
                              })}
                            >
                              Retract
                            </cf-button>
                          </cf-hstack>
                          <cf-text block style="white-space: pre-wrap;">
                            {comment.body}
                          </cf-text>
                        </cf-vstack>
                      ))}
                    </cf-vstack>
                  )
                  : (
                    <cf-text tone="muted" block>
                      No comments yet.
                    </cf-text>
                  )}

                <cf-hstack gap="2" align="end">
                  <cf-field label="Comment" style="flex: 1;">
                    <cf-textarea
                      $value={commentDraft}
                      rows={3}
                      placeholder="Add to the thread…"
                    />
                  </cf-field>
                  <cf-button
                    variant="primary"
                    disabled={!hasProfile}
                    onClick={submitComment}
                  >
                    Send
                  </cf-button>
                </cf-hstack>
              </cf-vstack>
            </cf-card>

            {/* ── Referenced by (the board's pivot; nothing persisted) ── */}
            {hasReferences
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>Referenced by</cf-heading>
                    <cf-vstack gap="1">
                      {referencedBy.map((topic) => (
                        <cf-cell-link $cell={topic} />
                      ))}
                    </cf-vstack>
                  </cf-vstack>
                </cf-card>
              )
              : null}

            {/* ── References made outside the prose (the `mention` verb) ── */}
            {hasMentioned
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>References</cf-heading>
                    <cf-text variant="caption" tone="muted">
                      Added directly rather than written into the body. A
                      mention inside the text is removed by editing the text.
                    </cf-text>
                    <cf-vstack gap="1">
                      {mentionedView.map((topic) => (
                        <cf-hstack gap="2" align="center">
                          <cf-cell-link $cell={topic} />
                          <cf-button
                            variant="ghost"
                            onClick={dropMention({ upgrade, mentioned, topic })}
                          >
                            Remove
                          </cf-button>
                        </cf-hstack>
                      ))}
                    </cf-vstack>
                  </cf-vstack>
                </cf-card>
              )
              : null}
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    );

    // A link's URL, asked of `cellFromUrl` once per link. Most answer with no
    // cell — they are web pages — and those simply are not mentions.
    // The receiver is `linksView`, the same active links the Links card
    // renders, and it carries the whole link record rather than the URLs
    // alone: a retracted link stops resolving, so the reference it
    // contributed to `mentions` goes with it instead of outliving the link
    // that made it. A url-only array could not carry `removedAt` to say so.
    const linkTargets = linksView.map((link) =>
      cellFromUrl({ url: link.url ?? "" })
    );
    // Outbound: what this topic points at. Only this half depends on the
    // topic's own content, which is what keeps the board's join reading one
    // small list per topic.
    const mentions = mentionsOf({ references, mentioned, linkTargets });

    return {
      [NAME]: topicName,
      [UI]: view,
      title,
      body,
      comments,
      links,
      createdAt,
      createdBy: createdByView,
      shortName,
      bodyUpdatedBy,
      bodyUpdatedAt,
      commentCount,
      lastActivityAt,
      references,
      mentioned,
      mentions,
      referencedBy,
      titleUpdatedBy,
      titleUpdatedAt,
      addComment,
      addLink,
      removeComment,
      editComment,
      removeLink,
      setBody,
      setTitle,
      mention,
      unmention,
      recordName,
      commentDraft,
      bodyDraft,
      editingBody,
      titleDraft,
      editingTitle,
      linkUrlDraft,
      linkLabelDraft,
      linkKindDraft,
      referencesDraft,
      startEditTitle,
      saveTitle,
      cancelEditTitle,
      submitComment,
      startEditBody,
      saveBody,
      cancelEditBody,
      submitLink,
    };
  },
);
