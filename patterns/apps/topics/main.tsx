/**
 * A shared board of topics, each a unit of team attention with a title, a
 * living body, and a comment thread. The board shows a card for each topic with
 * its number, a snippet of its body, its author, comment count, and last
 * activity, shows the profile you are acting as, and has a field to start a new
 * topic.
 */
import {
  computed,
  Default,
  handler,
  indexedCollections,
  lift,
  NAME,
  type OpaqueCell,
  pattern,
  type PerSession,
  type ReadonlyCell,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";

import { isMemberName } from "../../product/collection-naming/allocator.ts";
import type { MentionableRow } from "../../product/collection-naming/mentionable.ts";
import {
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  nextNameAmong,
  recordNames,
  SEQUENCE_NAMING,
} from "../../product/collection-naming/naming.ts";
import Topic, {
  rejectMutation,
  snippet,
  TOPIC_STATE_VERSION,
  type TopicAuthor,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  type TopicBoard,
  type TopicMentionable,
  type TopicMirrored,
  TOPICS_SCREEN_STYLE,
  TOPICS_THEME,
  type TopicSummary,
  whenLabel,
} from "./topic.tsx";

// Re-export the shared types for consumers and tests.
export type {
  AddCommentEvent,
  AddCommentResult,
  AddLinkEvent,
  AddLinkResult,
  AgentAuthoredEvent,
  SetBodyEvent,
  SetBodyResult,
  SetTitleEvent,
  SetTitleResult,
  TopicAuthor,
  TopicBoard,
  TopicComment,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicMentionRef,
  TopicMentionRefMap,
  TopicOutput,
  TopicPiece,
} from "./topic.tsx";

/**
 * What a reader of the board's `topics` receives of each topic: the display
 * scalars, the body, and what it points at, and no verbs. Callers take a
 * Topic's address from `index` and reach its verbs on the Topic itself.
 *
 * Seven of the nine fields carry defaults so a missing path does not make the
 * whole array unreadable. Two do not, for different reasons: `createdAt` is
 * required, because the Topic pattern defaults its input and publishes that
 * path unconditionally, and `shortName` is optional, because a default there
 * cannot be applied over a topic filed before the board numbered anything.
 */
export interface TopicDemand extends TopicSummary {
  /** The topic's display name. */
  [NAME]: string | Default<""> | undefined;
  body: string | Default<"">;
  mentions: unknown[] | Default<[]>;

  /** The board's number for the topic, as the topic publishes it. Absent for
   * a topic that stores none, such as one filed before its board numbered
   * anything. */
  shortName?: string;
}

export interface TopicsInput {
  /** The board's member namespace: each name to the topic it names, held as an
   * unread reference. `addTopic` writes one key per create and `backfillNames`
   * one key per member it names; nothing rewrites the map whole. Reads as empty
   * on a board from before it numbered anything, in the default form `NamesMap`
   * explains. */
  // deno-lint-ignore ban-types
  names?: Writable<Default<NamesMap, {}>>;
}

export interface AddTopicEvent {
  /** The topic's title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The topic's initial living-document body. A topic born with a body
   * appears with it atomically — no reader observes the title-only halfway
   * state, and no follow-up `setBody` call is needed to finish a create
   * (verb contract: the atomic-unit rule). */
  body?: string;

  /** The agent making this mutation. The authenticated principal remains the
   * human whose identity key invoked the stream; this is the agent's explicit
   * content-level signature under that shared principal.
   *
   * Required, for the reason given on `AgentAuthoredEvent`: acceptance widens
   * compatibly and narrows only through a break, so tolerating an unsigned
   * create is a tolerance that could never be withdrawn. */
  agentName: string;
}

export interface AddTopicResult {
  /** The topic this call created — the piece itself, not a manufactured
   * identifier. `cf piece call` can project the child link with a `$link` marker;
   * the returned canonical reference composes directly into the next command.
   *
   * Declared through the index's row schema rather than the full `TopicPiece`,
   * and the narrowness is the contract: the declared schema bounds the default
   * readback — a full piece would expand the body, thread, and every
   * referenced sibling — and every name a verb's result publishes is permanent
   * with no gate checking it, so the result publishes the survey row the
   * caller already knows plus the write-time facts only the pattern could
   * resolve (`createdAt`, `createdBy`). */
  topic: TopicIndexRow;

  /** The number the create allocated, as it was written to the namespace and
   * passed into the topic. This is the one to read: the row IS the created
   * topic, so reading its `shortName` waits for that piece to materialize. */
  name: string;
}

/** What `backfillNames` takes: the agent running it. */
export interface BackfillNamesEvent {
  /** The agent running the backfill, checked as `addTopic` checks it. */
  agentName: string;
}

/**
 * What `backfillNames` returns: three lists of numbers in filing order, which
 * together cover every topic of the collection the run could number.
 *
 * The split follows where each write lands, and three lists is what that
 * takes. The namespace is the board's own document, so `assigned` is what this
 * run wrote there. A topic's stored number is the topic's own document, which
 * only the topic can write, so the run reports which topics it found already
 * carrying theirs and which it asked — and cannot report the outcome of an
 * asking it just made. Those last two are a settled fact and an unconfirmed
 * request, and no one list says both: merge them and a run can no longer say
 * it is finished, merge either into `assigned` and a write to the topic's
 * document is reported as a write to the board's.
 *
 * `../../product/collection-naming/README.md` carries the library side: the two backfills,
 * and the `recordName` contract a member has to provide for `recordNames` to
 * reach it.
 */
export interface BackfillNamesResult {
  /** The numbers this run wrote into the namespace; empty when every topic was
   * already in it, which is what a second run writes. */
  assigned: string[];

  /** The numbers of the topics that already report them. The run sent these
   * topics nothing. */
  named: string[];

  /** The numbers this run asked topics to store, one `recordName` call each.
   * None is confirmed: a send's effect is invisible to the transaction that
   * makes it, so a topic here is one whose number is not stored YET as far as
   * this run could see.
   *
   * Empty means the board is finished: every topic it holds reports its
   * number. Non-empty is not a failure but the set to run the verb over again
   * — the numbers that landed come back under `named`, and the rest are asked
   * for again. A number allocated for a topic that has not stored it is still
   * that topic's permanently, and `top/<n>` already reaches it. */
  pending: string[];
}

/** One row of the board's compact discovery index: the topic itself, declared
 * through a title-and-scalars schema. The declared schema is the bound, so a
 * reader surveying the board expands no topic's prose, thread, or verbs.
 *
 * A row IS the topic it describes, so a row's own address is the topic's
 * address; nothing here carries a separate copy of it. */
export interface TopicIndexRow {
  title: string;
  createdAt: number;

  /** Who filed the topic. A record without structured authorship materializes
   * the inert `{ kind: "person", name: "" }` default, which
   * `topicAuthorLabel()` renders as `someone`. */
  createdBy?: TopicAuthor | Default<{ kind: "person"; name: "" }> | undefined;

  /** Coalesced to 0 for a topic that publishes none, such as one on an older
   * pattern that has never run, so the row itself never carries the
   * mixed-version undefined. */
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;

  /** The board's number for the topic, as the topic publishes it, so absent
   * for as long as a topic publishes none. Optional rather than defaulted,
   * unlike the two above, for the reason `TopicDemand.shortName` states. */
  shortName?: string;
}

/**
 * The instant a row sorts by: its published `lastActivityAt`, or its
 * `createdAt` when it has published none.
 *
 * A topic on the current pattern is created with `lastActivityAt` and keeps it
 * stored. A topic on an older pattern derives it, so it exists only once that
 * topic has run: one filed headlessly and never opened publishes none, and
 * {@link TopicIndexRow} coalesces that absence to `0`. Ordering on that `0`
 * puts the newest topic on the board beneath every topic that has ever run —
 * the opposite of what a board sorted by recency is for, and invisible,
 * because the row is present and merely last.
 *
 * `createdAt` is the one instant a cold row always carries: the Topic pattern
 * defaults its input and publishes that path unconditionally, which is why the
 * demand declares it required. Falling back to it orders a cold topic by when
 * it was filed, which is what a reader means by recency for a topic that has
 * had no activity since.
 *
 * The absence arrives as `0` rather than `undefined`, so this tests the value
 * and does not merely coalesce with `??`. A published `lastActivityAt` is a max
 * that includes `createdAt`, so it is never `0` for a topic that has run, and
 * the fallback cannot mask a real one.
 */
export function activityOrderOf(
  row: {
    lastActivityAt: number | Default<0> | undefined;
    createdAt: number;
  },
): number {
  return (row.lastActivityAt ?? 0) || row.createdAt;
}

/**
 * One rendered card, derived once for the cards the board shows.
 *
 * Everything a card shows is a plain string here, and that is the point: the
 * card list is a mapped sub-pattern, so any helper call or conditional in the
 * card's JSX — `snippet(card.body)`, `topicAuthorLabel(card.createdBy)`,
 * `whenLabel(...)`, `x ? <a/> : null` — becomes a computed cell of its own,
 * minted per card, persisted per session and watched by every reader.
 * Deriving the strings in one computation over the query's rows pays that
 * once per change in place of every card paying it on every load.
 *
 * `topic` is the member itself, held as a reference and never read through
 * here: the card's Open link navigates to it.
 */
export interface CardRow {
  /** The topic, as a reference: what the card's Open link navigates to. */
  topic: unknown;

  /** The board's number for the topic, or the empty string where it publishes
   * none — the one conditional the card keeps, since a badge with no text is
   * still a badge. */
  badge: string;
  title: string;

  /** The body's first 120 characters, or the empty string for a bodiless
   * topic, which the card renders as no line at all. */
  snippet: string;

  /** The caption line: comment count, author, and when the topic was last
   * active. */
  caption: string;
}

/** How many cards the board shows at first, and adds per "Show more". */
const CARD_PAGE = 50;

/**
 * The cards' topics, most recently active first, as many as the session has
 * asked to see, each with what its card shows. The order is `activityOrderOf()`'s, stated
 * in SQL, with the topic's reference breaking ties so that the order is
 * total.
 */
const CARDS_SQL = `
  SELECT member_cf_link AS topic,
    COALESCE(shortName, '') AS shortName, COALESCE(title, '') AS title,
    COALESCE(substr(body, 1, 400), '') AS lead,
    COALESCE(commentCount, 0) AS commentCount,
    COALESCE(authorKind, 'person') AS authorKind,
    COALESCE(authorName, '') AS authorName,
    COALESCE(lastActivityAt, 0) AS lastActivityAt,
    COALESCE(createdAt, 0) AS createdAt
  FROM topics
  ORDER BY CASE WHEN COALESCE(lastActivityAt, 0) > 0 THEN lastActivityAt
    ELSE createdAt END DESC, member_cf_link
  LIMIT :shown`;

/**
 * The cards of the rows the card query returned. A lift at module scope, so
 * that its declared parameter is the whole of what it reads, and so that a
 * measurement can name it. The rows are the session's, as the count of them
 * is, so the cards are stored per session too: at space scope, each session's
 * page would replace the last one written.
 */
const cardRowsByActivity = lift(
  ({ rows }: { rows?: CardFields[] }): PerSession<CardRow[]> =>
    cardRowsOf(rows ?? []),
);

/**
 * One row of the board's reference graph: a topic, and the topics that
 * mention it. Both sides are held as references and never read through.
 */
export interface TopicCrossrefRow {
  /** The topic this row is about. */
  topic: unknown;

  /** The topics that mention it, each once, in filing order. A topic that
   * mentions itself is not among them. */
  mentionedBy: unknown[];
}

/** A {@link TopicCrossrefRow} and the number of the topic it describes. */
export interface TopicCrossrefNamedRow extends TopicCrossrefRow {
  /** The number of the topic this row describes, absent for a topic with
   * none. */
  name?: string;
}

/** The rows of the board's reference graph, grouped by topic number. */
export interface TopicCrossrefIndex {
  /** Under each number, the rows of the topics that carry it. */
  byName: Record<string, TopicCrossrefRow[]>;
}

/**
 * Every reference between two topics of the board, each pair once, ordered
 * by the mentioning topic's place in filing order. `target` is the mentioned
 * topic's reference as text, which is what `MEMBERS_SQL` returns as `key`.
 */
const EDGES_SQL = `
  SELECT e.target_cf_link AS target, e.source_cf_link AS source
  FROM (
    SELECT source_cf_link, target_cf_link FROM topics_mentioned
    UNION
    SELECT source_cf_link, target_cf_link FROM topics_mentions) e
  JOIN topics s ON s.member_cf_link = e.source_cf_link
  JOIN topics t ON t.member_cf_link = e.target_cf_link
  WHERE e.source_cf_link <> e.target_cf_link
  ORDER BY s.shortName IS NULL, CAST(s.shortName AS INTEGER), s.rowid`;

/** A row of `EDGES_SQL`. */
interface EdgeRow {
  target: string;
  source: OpaqueCell<TopicDemand>;
}

/**
 * The board's reference graph, one row per topic of `members` and in their
 * order, from the references `edges` lists.
 */
export function crossrefRowsOf(
  members: readonly MemberRow[],
  edges: readonly EdgeRow[],
): TopicCrossrefNamedRow[] {
  const inbound = new Map<string, unknown[]>();
  for (const edge of edges) {
    const sources = inbound.get(edge.target);
    if (sources === undefined) inbound.set(edge.target, [edge.source]);
    else sources.push(edge.source);
  }
  return members.map((row) => ({
    topic: row.topic,
    mentionedBy: inbound.get(row.key) ?? [],
    ...(row.shortName ? { name: row.shortName } : {}),
  }));
}

/**
 * Groups `rows` by the number each carries. A row with no number, or with a
 * name that is not a member name (`isMemberName`), is filed nowhere, so no
 * group can be named by an `Object.prototype` member.
 */
export function crossrefIndexOf(
  rows: readonly TopicCrossrefNamedRow[],
): TopicCrossrefIndex {
  const byName: Record<string, TopicCrossrefRow[]> = {};
  for (const { name, topic, mentionedBy } of rows) {
    if (typeof name !== "string" || !isMemberName(name)) continue;
    if (!Object.hasOwn(byName, name)) byName[name] = [];
    byName[name].push({ topic, mentionedBy });
  }
  return { byName };
}

/**
 * Every topic of the board, in filing order: numbered topics by number, then
 * unnumbered topics in the order they joined the collection. A number is
 * allocated densely at filing, so it is the filing order of every topic that
 * has one. A topic `addTopic` has just created has no mirrored number until
 * it has been set up, and for that moment it sorts last, where its number
 * will put it.
 */
const MEMBERS_SQL = `
  SELECT member_cf_link AS topic, member_cf_link AS key,
    COALESCE(title, '') AS title, COALESCE(shortName, '') AS shortName
  FROM topics
  ORDER BY shortName IS NULL, CAST(shortName AS INTEGER), rowid`;

/** A row of `CARDS_SQL`: one topic's mirrored scalars and its reference. */
export interface CardSource {
  /** The topic, as a reference that is passed along unread. */
  topic: OpaqueCell<TopicDemand>;
  shortName: string;
  title: string;

  /** The start of the body, longer than a card's snippet. */
  lead: string;
  commentCount: number;
  authorKind: string;
  authorName: string;
  lastActivityAt: number;
  createdAt: number;
}

/**
 * What a card is formatted from: a `CardSource` whose topic is declared as
 * something passed along, so that the derivation over these rows reads no
 * topic.
 */
export type CardFields = Omit<CardSource, "topic"> & { topic: unknown };

/** A row of `MEMBERS_SQL`: a topic's reference, title and number. */
interface MemberRow {
  topic: OpaqueCell<TopicDemand>;

  /** The topic's reference as text, which references between topics are
   * grouped by. */
  key: string;
  title: string;
  shortName: string;
}

/** The settled or pending rows of a query. */
interface Rows<Row> {
  pending: boolean;
  result?: Row[];
  error?: unknown;
}

/**
 * The cards of `rows`, in the order given: each row's strings, formatted as a
 * card shows them, beside the row's topic.
 */
export function cardRowsOf(rows: readonly CardFields[]): CardRow[] {
  return rows.map((row) => ({
    topic: row.topic,
    badge: row.shortName,
    title: row.title || "(untitled topic)",
    snippet: row.lead ? snippet(row.lead, 120) : "",
    caption: `${row.commentCount} comments · by ${
      topicAuthorLabel({ kind: row.authorKind, name: row.authorName })
    } · ${whenLabel(row.lastActivityAt)}`,
  }));
}

/**
 * Topics — a tracker over #topic pieces: durable units of shared attention
 * (CT-1878). Deliberately minimal: no statuses, labels, or assignees; topics
 * sort by last activity. Replaces Linear / GitHub issues / loose process docs
 * for the team; PR workflows stay in GitHub and arrive here as links.
 *
 * Headless use: survey the whole board with one bounded read of `index` — a
 * row is its Topic, so select the row's own address alongside `title` and use
 * that canonical address as the piece for the Topic's reads and verbs.
 * File with `addTopic`, title and optional initial body in one call, then work
 * on the Topic directly: the body is its living document, the thread its
 * append-only deliberation. Sign every authored-content mutation with
 * `agentName`; Fabric records the human principal behind the key, and the name
 * says which agent acted under it. Reference-only `mention` and `unmention`
 * calls carry no content signature.
 */
export interface TopicsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The board's topics, in filing order, through the display scalars and
   * what each points at, and no verbs. Read out of the board's collection, so
   * reading it reads every topic's reference. A caller that means to mutate a
   * topic addresses the topic itself, where its own schema governs. Survey
   * through `index` instead; read this when you already know which topic you
   * are expanding. */
  topics: TopicDemand[];

  /** The board's topics as a collection: what `addTopic` adds to, and what a
   * topic asks which topics mention it. Published so a topic composed outside
   * `addTopic` can be wired to the collection the board's own children ask,
   * and so a caller can put its own question to the tables `TopicBoard`
   * names. */
  board: TopicBoard;

  /** The board's mention universe, under the name the topic pattern's editor
   * autocompletes over — what `addTopic` wires into each child. One row per
   * topic, read out of the board's collection: the topic as an unread
   * reference, its title, and its number, or the empty string where it has
   * none. A reader of the universe expands no topic, and a `#42` query finds
   * a member without expanding one; see `MentionableRow` in
   * `../../product/collection-naming/mentionable.ts`. */
  mentionable: MentionableRow[] | Default<[]>;

  /** The namespace itself: each name to the topic it names. A slug pointing
   * here is what makes a member addressable as `<collection>/<name>`.
   * Published under the default its input carries. */
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;

  /** The names table, one row per numbered member: what `nameOf` reads to find
   * the number the board gives a topic by identity, including a topic whose own
   * `shortName` is absent. No topic reads it — a topic reports the number it
   * stores — so this is published for a caller doing that reverse lookup. */
  namesTable: NamesTableRow[] | Default<[]>;

  /** What the board declares about its names, for a consumer deciding whether
   * a name may be held rather than an identity. */
  naming: NamingDeclaration;

  /** How many topics the board's collection holds. */
  topicCount: number;

  /** The board's reference graph, one row per topic in filing order: the
   * topic, and the topics that mention it. Read out of the board's
   * collection, and derived only for a reader that asks for it: a topic
   * asks the collection for its own backlinks and does not read this. */
  crossrefs: TopicCrossrefNamedRow[] | Default<[]>;

  /** `crossrefs` grouped by topic number: under each number, the rows of the
   * topics carrying it. */
  crossrefIndex: TopicCrossrefIndex;

  /** The full-board survey surface: one bounded row per topic, carrying the
   * scalars a survey reads. A row IS its topic, so a row's own address is the
   * topic's — `--select index[].@` reads it, and an index into this array is
   * not a stable address. */
  index: TopicIndexRow[] | Default<[]>;

  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle?: PerSession<Writable<string>>;

  /** File a topic. The atomic unit takes the initial body with the title, so
   * no reader observes a title-only halfway state and no follow-up `setBody`
   * finishes a create. Returns the created topic as its survey row — the
   * reference plus the write-time facts the pattern resolved. */
  addTopic: Stream<AddTopicEvent, AddTopicResult>;

  /** Number every topic the collection holds that the namespace does not, in
   * filing order, and ask every topic that reports no number to store the one
   * the namespace holds for it. Every way of filing a topic numbers it, so a
   * run finds work only where the namespace lacks a topic the collection
   * holds. Refused while the board's topics have not loaded, since a run over
   * rows that have not arrived would report the board finished. Idempotent: a
   * run over topics that all report their numbers writes nothing and sends
   * nothing. What one run cannot confirm is the asking, so
   * the result separates the topics it found numbered from the ones it asked,
   * and running it again completes whichever asking did not land. */
  backfillNames: Stream<BackfillNamesEvent, BackfillNamesResult>;

  /** Submit the footer composer as the current viewer's canonical Profile. */
  submitTopic: Stream<void>;
}

/** Browser composer submit. Profile wishes are resolved by the pattern and
 * bound into this handler as plain snapshot values, which keeps the mutation
 * independently testable without weakening the canonical Profile path. */
export const submitProfileTopic = handler<void, {
  /** The board's collection, which the new topic is added to and handed, so
   * that it can ask which topics mention it. */
  board: TopicBoard;

  /** The mention universe, declared at the child's own demand — the three
   * strings a universe entry carries. Handed to the new topic as it arrives;
   * nothing here reads an entry. */
  mentionable: ReadonlyCell<TopicMentionable[] | Default<[]>>;

  /** The namespace, written one key per create. Read for its keys and written
   * at one of them inside this handler, so the allocation and the add are one
   * transaction. */
  // deno-lint-ignore ban-types
  names: Writable<Default<NamesMap, {}>>;
  newTitle: Writable<string>;
  profileName: string;
}>((_, { board, mentionable, names, newTitle, profileName }) => {
  const trimmed = newTitle.get().trim();
  const author = topicAuthorFromPerson(profileName);
  if (!trimmed || !author) return;
  // The number, the create, and the add are one transaction, as they are in
  // `addTopic`: no reader observes the topic without its number, and a
  // concurrent create serializes on the map's keys rather than taking the
  // same one.
  const filedAt = Date.now();
  // The allocation and the write of the namespace are this handler's own, as
  // `createNamed()` makes them: it takes the namespace through a structural
  // type, which is no handle in the compiled pattern language.
  const allocated = nextNameAmong(Object.keys(names.get() ?? {}));
  const piece = Topic({
    topicStateVersion: TOPIC_STATE_VERSION,
    title: trimmed,
    createdAt: filedAt,
    // Kept by the topic's verbs from here on; a new topic has no comment and
    // no activity but its creation.
    commentCount: 0,
    lastActivityAt: filedAt,
    createdBy: author,
    // The number this create allocated, stored with the topic, which is
    // what lets the topic report it without reading the board.
    shortName: allocated,
    // Same wiring `addTopic` gives its children.
    mentionable,
    board,
  });
  names.key(allocated).set(piece);
  board.add("topics", piece);
  newTitle.set("");
});

/** What the handlers that create a topic are bound to. */
interface BoardCreateState {
  /** The board's collection, which the new topic is added to and handed. */
  board: TopicBoard;

  /** The mention universe, handed to the new topic as it arrives. */
  mentionable: ReadonlyCell<TopicMentionable[] | Default<[]>>;

  /** The namespace, written one key per create. */
  // deno-lint-ignore ban-types
  names: Writable<Default<NamesMap, {}>>;
}

/** Files a topic: the number, the create and the add, in one transaction. */
const addTopicHandler = handler<
  AddTopicEvent,
  BoardCreateState,
  AddTopicResult
>((
  { title, body, agentName },
  { board, mentionable, names },
) => {
  const trimmed = (title ?? "").trim();
  const author = topicAuthorFromAgent(agentName) ??
    rejectMutation("addTopic", "agentName must be non-blank");
  if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
  // The number, the create, and the add are one transaction: the topic is
  // built holding the number the map records it under, no reader observes the
  // topic without its number, and a concurrent create serializes on the
  // map's keys, re-running with the next number rather than taking the same
  // one.
  const filedAt = Date.now();
  // The allocation and the write of the namespace, as `createNamed()` makes
  // them, are written here: it takes the namespace through a structural type,
  // which is no handle in the compiled pattern language.
  const name = nextNameAmong(Object.keys(names.get() ?? {}));
  const piece = Topic({
    topicStateVersion: TOPIC_STATE_VERSION,
    title: trimmed,
    // Body at create is part of the create's atomic unit; created-with is
    // not an update, so bodyUpdatedBy/At stay unset (createdBy covers it).
    // Preserved verbatim, matching setBody and the UI save path — trimming
    // would corrupt whitespace-sensitive Markdown (indented code blocks).
    body: body ?? "",
    createdAt: filedAt,
    // Kept by the topic's verbs from here on; a new topic has no comment
    // and no activity but its creation.
    commentCount: 0,
    lastActivityAt: filedAt,
    createdBy: author,
    // The number this create allocated, stored with the topic, which is
    // what lets the topic report it without reading the board.
    shortName: name,
    // The board's mention universe, which the editor autocompletes over.
    mentionable,
    // The board's collection, which the topic asks for the topics that
    // mention it.
    board,
  });
  names.key(name).set(piece);
  // The session composer draft is `submitTopic`'s to clear; a headless
  // create has no draft.
  board.add("topics", piece);
  return { topic: piece, name };
});

/**
 * Numbers the topics of the collection that the namespace lacks. Refuses to
 * run before the query listing them has returned: over rows that have not
 * arrived it would find no topic, write nothing, and report the board
 * finished.
 */
const backfillNamesHandler = handler<
  BackfillNamesEvent,
  Pick<BoardCreateState, "names"> & {
    /** The topics the board's collection holds, in filing order. */
    members: Writable<TopicDemand[] | Default<[]>>;

    /** Whether the query `members` is read out of has returned. */
    membersLoaded: boolean;
  },
  BackfillNamesResult
>(
  ({ agentName }, { names, members, membersLoaded }) => {
    if (!topicAuthorFromAgent(agentName)) {
      rejectMutation("backfillNames", "agentName must be non-blank");
    }
    if (!membersLoaded) {
      rejectMutation(
        "backfillNames",
        "the board's topics have not loaded yet; run it again",
      );
    }
    return recordNames(members, names);
  },
);

/**
 * The count a write to the board also advances, and who may advance it. A
 * topic holds the board's handle so that it can ask which topics mention it,
 * and anything the board's handle is linked into holds it too; these two are
 * the board's own ways of adding a topic.
 */
type BoardGuard = WritePolicyAnyOf<number, [
  WriteAuthorizedBy<unknown, typeof addTopicHandler>,
  WriteAuthorizedBy<unknown, typeof submitProfileTopic>,
]>;

/** Shows another page of cards in the session that asked. */
const showMoreCards = handler<void, { shown: Writable<number> }>(
  (_, { shown }) => {
    shown.set(shown.get() + CARD_PAGE);
  },
);

export default pattern<TopicsInput, TopicsOutput>(({ names }) => {
  const newTitle = new Writable.perSession("");
  // How many cards this session is looking at. A board is read most recent
  // first, so a session that wants older topics asks for them a page at a
  // time, and no other session's list grows with it.
  const shown = new Writable.perSession(CARD_PAGE);

  // The board's topics. Membership lives here and nowhere else: every listing
  // below is a query, so none of them reads a topic.
  // Who may write the board: see `BoardGuard`.
  const guard = new Writable<BoardGuard>(0);

  const board = indexedCollections<{ topics: TopicMirrored }>({
    topics: {
      columns: {
        title: "text",
        body: "text",
        shortName: "text",
        createdAt: "integer",
        commentCount: "integer",
        lastActivityAt: "integer",
        authorKind: { type: "text", path: ["filedBy", "kind"] },
        authorName: { type: "text", path: ["filedBy", "name"] },
      },
      // What a topic points at. `mentioned` is what the `mention` verb
      // stores; `mentions` is what the topic derives from that, its prose and
      // its links, once it has run.
      relations: ["mentioned", "mentions"],
    },
  }, { guard });

  const counted = board.query<{ n: number }>(
    "SELECT count(*) AS n FROM topics",
  );
  const topicCount = computed<number>(() => counted.result?.[0]?.n ?? 0);
  // A count that has not arrived yet is not a count of none.
  const hasNoTopics = computed<boolean>(() => counted.result?.[0]?.n === 0);

  // The cards the board shows, already in order, and the strings each
  // renders, derived in one computation. The query is asked for the
  // session's own count, so its result is the session's: at the default
  // scope, the result every session reads would be the page the session that
  // asked last asked for.
  const listed = board.query<CardSource>(CARDS_SQL, {
    params: { shown },
    scope: "session",
  });
  const cards = cardRowsByActivity({ rows: listed.result });
  const hasMoreCards = computed<boolean>(() =>
    (counted.result?.[0]?.n ?? 0) > shown.get()
  );
  const showMore = showMoreCards({ shown });

  // Every topic, in filing order: the references behind `topics` and `index`,
  // and the rows of the mention universe every child's editor autocompletes
  // over.
  const members: Rows<MemberRow> = board.query<MemberRow>(MEMBERS_SQL);
  // HACK, as in the topic pattern: the rows hold references, and the
  // assertion states what a reader following one receives.
  const topicList = computed(() => {
    const listedTopics: unknown[] = (members.result ?? []).map((row) =>
      row.topic
    );
    return listedTopics as TopicDemand[];
  });
  const mentionable = computed<MentionableRow[]>(() =>
    (members.result ?? []).map((row) => ({
      [NAME]: row.title.trim() || "(untitled topic)",
      title: row.title,
      shortName: row.shortName,
      piece: row.topic,
    }))
  );
  // The reference graph as rows, for a reader that asks for the whole of it.
  const edges = board.query<EdgeRow>(EDGES_SQL);
  const crossrefs = computed<TopicCrossrefNamedRow[]>(() =>
    crossrefRowsOf(members.result ?? [], edges.result ?? [])
  );
  const crossrefIndex = computed<TopicCrossrefIndex>(() =>
    crossrefIndexOf(
      crossrefRowsOf(members.result ?? [], edges.result ?? []),
    )
  );
  // Derived once for the whole board, for a caller's reverse lookup by
  // identity; no topic reads it.
  const table = namesTable({ names });

  // Browser authorship comes from the current viewer's canonical Profile.
  // CLI streams below remain wish-free: agents sign each mutation in the
  // event payload, while Fabric records the human principal behind the key.
  // One wish, not two: `#profile` resolves the profile itself, and `name` is a
  // field on it. The `#profileName` target is the same field reached through a
  // second resolution of the same profile.
  const profileWish = wish<{ name: string }>({
    query: "#profile",
  });
  // A wish resolves after setup, so each of these stays a derivation. Reading
  // the fields once here would pin the composer to the empty profile the board
  // started with: the Start button never enables, and a topic filed through it
  // carries blank attribution.
  const profileName = profileWish.result?.name ?? "";
  const hasProfile = profileName.trim().length > 0;

  const addTopic = addTopicHandler({ board, mentionable, names });
  // A members query that has not returned has no result yet, which is not a
  // board of no topics.
  const membersLoaded = computed<boolean>(() => members.result !== undefined);
  const backfill = backfillNamesHandler({
    names,
    members: topicList,
    membersLoaded,
  });

  const submitTopic = submitProfileTopic({
    board,
    mentionable,
    names,
    newTitle,
    profileName,
  });

  return {
    [NAME]: `Topics (${topicCount})`,
    [UI]: (
      <cf-theme theme={TOPICS_THEME}>
        <cf-screen style={TOPICS_SCREEN_STYLE}>
          <cf-vstack slot="header" gap="2" padding="4">
            <cf-hstack justify="between" align="center">
              <cf-vstack gap="0">
                <cf-heading level={3}>Topics</cf-heading>
                <cf-text variant="caption" tone="muted">
                  {topicCount} topics · durable units of shared attention
                </cf-text>
              </cf-vstack>
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

          <cf-vstack gap="2" padding="4">
            {cards.map((card) => (
              <cf-card>
                <cf-hstack gap="3" align="center">
                  {card.badge
                    ? (
                      <cf-badge size="sm" color="primary" data-member-name="">
                        {card.badge}
                      </cf-badge>
                    )
                    : null}
                  <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                    <cf-text block style="font-weight: 600;">
                      {card.title}
                    </cf-text>
                    {card.snippet
                      ? (
                        <cf-text tone="muted" block truncate>
                          {card.snippet}
                        </cf-text>
                      )
                      : null}
                    <cf-text variant="caption" tone="muted">
                      {card.caption}
                    </cf-text>
                  </cf-vstack>
                  <cf-cell-link $cell={card.topic} label="Open" static />
                </cf-hstack>
              </cf-card>
            ))}

            {hasMoreCards
              ? (
                <cf-button
                  id="show-more-cards"
                  variant="secondary"
                  onClick={showMore}
                >
                  Show more…
                </cf-button>
              )
              : null}

            {hasNoTopics
              ? (
                <cf-empty-state message="No topics yet. Start the first one below." />
              )
              : null}
          </cf-vstack>

          <cf-vstack slot="footer" gap="2" padding="4">
            <cf-hstack gap="2" align="end">
              <cf-field label="New topic" style="flex: 1;">
                <cf-input
                  $value={newTitle}
                  placeholder="What deserves shared attention?"
                />
              </cf-field>
              <cf-button
                variant="primary"
                disabled={!hasProfile}
                onClick={submitTopic}
              >
                Start
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    ),
    topics: topicList,
    board,
    mentionable,
    names,
    namesTable: table,
    // The sequence policy, claiming no name for the board: what it is bound
    // as is decided where the binding is made.
    naming: SEQUENCE_NAMING,
    topicCount,
    crossrefs,
    crossrefIndex,
    // The topics themselves, declared through the index's narrow row schema:
    // a row's address is the topic's address, so a survey and a follow-up read
    // name the same document.
    index: topicList,
    newTitle,
    addTopic,
    backfillNames: backfill,
    submitTopic,
  };
});
