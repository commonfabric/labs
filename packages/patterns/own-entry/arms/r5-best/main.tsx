// EXPERIMENT (own-entry, arm `r5-best`): a copy of
// packages/patterns/topics/main.tsx with the edits
// packages/patterns/own-entry/make-arms.ts lists. Not for merge. Comments
// outside those edits are copied unchanged and describe the original.
import {
  action,
  type Cell,
  type ComparableCell,
  computed,
  Default,
  entityRefToString,
  equals,
  getEntityId,
  handler,
  type KeyIndex,
  lift,
  NAME,
  pattern,
  type PerSession,
  type ReadonlyCell,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import {
  mentionableIndex,
  type MentionableRow,
} from "../../../collection-naming/mentionable.ts";
import {
  assignName,
  backfillNames,
  createNamed,
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  SEQUENCE_NAMING,
} from "../../../collection-naming/naming.ts";
import Topic, {
  type OwnEntry,
  rejectMutation,
  snippet,
  TOPIC_STATE_VERSION,
  type TopicAuthor,
  topicAuthorFromAgent,
  topicAuthorFromPerson,
  topicAuthorLabel,
  type TopicCrossrefRow,
  type TopicMentionable,
  type TopicMentionSource,
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
  TopicComment,
  TopicCrossrefRow,
  TopicInput,
  TopicLink,
  TopicLinkKind,
  TopicMentionRef,
  TopicMentionRefMap,
  TopicOutput,
  TopicPiece,
} from "./topic.tsx";

/**
 * What the board uses of a stored topic — its demand, not the topic's complete
 * contract.
 *
 * A holder names only the fields it reads and verbs it calls; see
 * [designing verbs so they can change](../../../docs/plans/verb-evolution.md).
 * This board calls no Topic verb, so the demand names none. Callers take a
 * Topic's address from `index` and reach its verbs on the Topic itself.
 *
 * The nine fields cover the card, compact index, activity sort, reference
 * pivot, and mention autocomplete. Seven carry defaults so a missing path does
 * not make the whole array unreadable. Two do not, for different reasons:
 * `createdAt` is required, because the Topic pattern defaults its input and
 * publishes that path unconditionally, and `shortName` is optional, because a
 * default there cannot be applied over a board deployed before the namespace.
 */
export interface TopicDemand extends TopicSummary {
  /** The display name, which the board's mention index copies into each
   * topic's row — the label every `@`-mention completion carries. The index
   * lift states the same three-string demand for itself; this entry is the
   * board-level record of it. */
  [NAME]: string | Default<""> | undefined;
  body: string | Default<"">;
  mentions: unknown[] | Default<[]>;

  /** The board's name for the topic, as the topic reads it out of the board's
   * names table. The card renders it as a badge and the mention index copies
   * it into the topic's universe row, so `#42` matches without expanding a
   * topic.
   *
   * OPTIONAL rather than defaulted, which is a fact about the compatibility
   * proof: a defaulted property moves the demand's defaults below an array
   * constraint the proof cannot show stable under default insertion, while an
   * optional one simply tolerates a topic that publishes none.
   *
   * A member's open producer contract allows any value at an undeclared
   * property. Demanding a string there narrows that contract even when the
   * property is optional, so `setsrc` requires an accepted compatibility
   * break until the producer guarantees the string type. An optional
   * `unknown` demand imposes no such restriction. A topic whose
   * lookup has produced no value — one filed a moment ago, or one from before
   * the board numbered anything — is absent here rather than blank, and every
   * consumer treats the two the same. */
  shortName?: string;
}

/** EXPERIMENT (r5-best): where the board keeps a topic's entry document,
 * under the name it was filed as. */
export interface EntrySlot {
  /** The board's name for the topic. */
  name: string;

  /** The entry, which the create also handed to the topic. */
  entry: Writable<OwnEntry>;
}

export interface TopicsInput {
  /** EXPERIMENT (r5-best): one slot per topic the board has filed. */
  entrySlots?: Writable<EntrySlot[] | Default<[]>>;

  /** The board's durable topic list. `addTopic` appends here; direct writes
   * are legitimate but unattributed, and a whole-array write forfeits the
   * mergeability the verb's append keeps. */
  topics?: Writable<TopicDemand[] | Default<[]>>;

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

  /** The name the create allocated, as it was written to the namespace. The
   * topic's own `shortName` is a lookup that may not have produced a value
   * when this returns, so this is the one to read: a caller must not have to
   * wait for a derivation to learn the name it just allocated. */
  name: string;
}

/** What `backfillNames` takes: the agent running it. */
export interface BackfillNamesEvent {
  /** The agent running the backfill, checked as `addTopic` checks it. */
  agentName: string;
}

/** What `backfillNames` returns. */
export interface BackfillNamesResult {
  /** The names this run wrote, in filing order; empty when every member was
   * already named, which is what a second run returns. */
  assigned: string[];
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

  /** Coalesced to 0 for a cold or older topic whose derived path is absent,
   * so the row itself never carries the mixed-version undefined. */
  commentCount: number | Default<0> | undefined;
  lastActivityAt: number | Default<0> | undefined;

  /** The board's name for the topic. Optional rather than defaulted, unlike
   * the two above, for the reason `TopicDemand.shortName` states. */
  shortName?: string;
}

/**
 * Each source's mention list, read once per source.
 *
 * A source whose value has not materialized yet — a topic appended a moment
 * ago, still mid-sync — reads back as `undefined`, and taking `.mentions` of
 * that throws. Thrown here it kills the whole pivot, and with it the append
 * that caused it: the board goes on serving every topic it already had and
 * silently accepts no new one.
 *
 * `mentionedBy` below already declares this element as `| undefined` and
 * already guards it with `mentions[from]?.some(...)`. So the tolerance is not
 * being added here; the producer is being made to honor the contract its own
 * consumer states.
 *
 * A read taken straight off the cell gets no help from the compiler. `get()` on
 * `ReadonlyCell<TopicMentionSource>` is declared to return a value rather than
 * `T | undefined` — `IReadable` in `packages/api/index.ts` — so omitting the
 * second `?.` there type-checks exactly as well as including it, and every gate
 * stays green over a board that silently accepts no new topic. Only a read
 * against a board with an in-flight append tells the two apart.
 *
 * Declaring the source structurally is what changes that. The parameter type
 * says `get(): { mentions: M } | undefined`, so omitting the second `?.` HERE
 * is a compile error: `deno task cfcheck` fails with "Object is possibly
 * 'undefined'". `deno task check` passes either way — it walks the
 * hand-maintained path list in `tasks/typecheck.ts`, which this package is not
 * on, and patterns are checked by `cfcheck`. So the structural declaration buys
 * two things rather than one: the read becomes testable, and the optionality
 * moves somewhere the pattern typechecker can see it.
 *
 * Whether a cell's `get()` may return undefined against its declared type is a
 * question about the cell contract rather than about this pattern, and it is
 * not answered here.
 */
export function mentionListsOf<M>(
  sources: readonly ({ get(): { mentions: M } | undefined } | undefined)[],
): (M | undefined)[] {
  return Array.from(sources, (source) => source?.get()?.mentions);
}

/**
 * The topics that mention `topic`, out of `list` — the pivot's whole join,
 * lifted out so a test can hand it a list built by hand.
 *
 * The result holds one element for each entry of `list` whose mentions name
 * `topic` and which is not `topic` itself, in `list`'s order. The pivot hands
 * it the list `distinctByIdentity` returns, which names each topic once.
 *
 * `mentions[i]` is what `list[i]` points at, read once by the caller because
 * reading it through the reactive array costs a link resolution per topic per
 * topic.
 *
 * The exclusion is asked of IDENTITY, never of array position, and that is the
 * whole reason this is a named function. A list holding one topic at two
 * indices must not route its self-mention through the twin and call the result
 * an inbound edge — and a position comparison passes every test where each
 * topic appears once. Handing this function a duplicated list is what tells the
 * two apart.
 *
 * Mention membership is checked before source identity: a source with no
 * matching mention contributes no edge and needs no identity comparison.
 *
 * `equals` resolves BOTH sides before comparing, so it answers "do these name
 * the same document" whether each side arrived as a cell or as the raw link a
 * read left behind. A method call on the value would depend on which it is.
 */
export function mentionedBy<T extends object>(
  topic: T,
  list: readonly T[],
  mentions: readonly (readonly (object | undefined)[] | undefined)[],
): T[] {
  return list.filter((other, from) =>
    mentions[from]?.some((mention) => equals(mention, topic)) &&
    !equals(other, topic)
  );
}

/**
 * The entries of `list` naming distinct topics, each kept at its first entry
 * and in `list`'s order, leaving out an entry with nothing behind it yet. These
 * are the topics the pivot builds rows for and joins over as sources.
 *
 * Identity is `equals`, the comparison `mentionedBy` makes, so two entries that
 * resolve to one document are one topic whether they hold the same link or one
 * holds an alias of it. Nothing in the pattern API turns a `ReadonlyCell` entry
 * into a resolved key carrying space, scope, and path, so each entry is
 * compared with `equals` against the distinct entries kept before it: at most
 * `n(n - 1) / 2` comparisons over `n` entries.
 */
export function distinctByIdentity<T extends object>(
  list: readonly (T | undefined)[],
): T[] {
  const distinct: T[] = [];
  for (const entry of list) {
    if (entry && !distinct.some((kept) => equals(kept, entry))) {
      distinct.push(entry);
    }
  }
  return distinct;
}

/**
 * The board's mention pivot: one row per distinct topic, naming the topics that
 * mention it.
 *
 * The whole reference graph is derived HERE, once, and every topic reads its
 * own row out of the result. The alternative — each topic deriving its own
 * inbound edges — is the same join done N times over the same corpus.
 *
 * The declared parameter is the entire cost of that: one list of references per
 * topic, `unknown` because they are compared by identity and never read
 * through. So the pivot over a whole board expands no topic's title, prose,
 * thread, verbs, or rendered UI. It reads the shape of the graph and nothing
 * else.
 *
 * Matching uses `equals` so aliases and scoped references keep their canonical
 * identity semantics. The scan runs over plain arrays and compares source
 * identity only after finding a matching mention.
 *
 * The rows and the join's sources both come from `distinctByIdentity`. A topic
 * the board lists at two entries therefore gets one row, which is what lets a
 * topic's lookup by identity find exactly one, and counts once as a source in
 * the row of every topic it mentions, at the place of its first entry.
 *
 * Each row is addressed by the topic it describes — `Writable.for(topic)` — so
 * a row keeps its identity wherever it sits in the array and however the board
 * is reordered. That is what lets every topic's lookup lift re-run freely on
 * any board change and still write nothing: an unchanged row recomputes to the
 * same links at the same address.
 */
const crossrefTable = lift(
  (
    { sources }: {
      // An array of CELLS, which is what lets ONE declaration answer both of
      // the pivot's questions: the cell is the topic's identity, and its value
      // is the short list of what that topic points at. A cell always writes as
      // a link, so the rows below are deterministic; an element read as a value
      // writes a link only while it still carries provenance and an inline copy
      // once it does not, which makes the same inputs produce two different
      // documents and fails the idempotency recheck.
      sources: ReadonlyCell<TopicMentionSource>[] | Default<[]>;
    },
  ): TopicCrossrefRow[] => {
    const rows: unknown[] = [];
    // Every pass below reads this plain array: an element read through the
    // reactive array resolves a link every time, and the passes read each
    // element many times. It holds each distinct topic at its first entry, and
    // is both the list of rows and the join's sources. An entry with nothing
    // behind it yet (mid-sync) has no identity to address a row by, and
    // `Writable.for(undefined)` is not a cause, so `distinctByIdentity` leaves
    // it out. It gets no row rather than a junk one — the lookup is by
    // identity, not by position, so a shorter table costs nothing.
    const list = distinctByIdentity(Array.from(sources));
    // Materialize each mention array once, from `list` itself, so `mentions[i]`
    // is what `list[i]` points at; scanning a reactive array resolves its
    // elements again for every destination topic.
    const mentions = mentionListsOf(list).map((refs) =>
      refs === undefined ? undefined : Array.from(refs)
    );
    list.forEach((topic) => {
      const inbound = mentionedBy(topic, list, mentions);
      // Addressed by the topic it describes, so a row keeps its identity
      // wherever it sits and however the board is reordered. That is what lets
      // every topic's lookup re-run freely on any board change and still write
      // nothing: an unchanged row recomputes to the same links at the same
      // address.
      rows.push(
        Writable.for<TopicCrossrefRow>(topic).set({
          topic,
          mentionedBy: inbound,
        }),
      );
    });
    return rows as TopicCrossrefRow[];
  },
);

/**
 * The board's cards, most recently active first.
 *
 * Sorts and returns the topics themselves. It does not build a card object per
 * topic, and that is the point: a constructed object is a new value with no
 * identity, so every render would hand the mapped sub-pattern fresh content
 * and every card's subtree would be re-addressed — new scheduler actions
 * registered and the old ones torn down — for topics whose content never
 * changed. Passing a topic through keeps the identity it already has.
 *
 * The CONSTRAINT declares the one field the sort reads, so ordering the board
 * expands no topic; the type parameter hands back what it was given, which is
 * the topics themselves. Those are two separate statements, and a cast could
 * only conflate them — the one here used to claim a card-shaped view the sort
 * never produced, which also hid `lastActivityAt`'s absence from the caller.
 *
 * Each card still bounds its own read: the elements are links, and the mapped
 * sub-pattern's argument schema is shrunk to the fields its body renders. That
 * schema is why every field a card touches carries a default — it is what a
 * piece holding older topics is updated against.
 */
const cardsByActivity = lift(
  <T extends { lastActivityAt: number | Default<0> | undefined }>(
    { rows }: { rows: T[] | Default<[]> },
  ): T[] =>
    rows.toSorted((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
);

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

  /** The board's topics, in filing order, through the shape the board demands
   * of them: the display scalars and the mention universe, and no verbs. A
   * caller that means to mutate a topic addresses the topic itself, where its
   * own schema governs. Survey through `index` instead; read this when you
   * already know which topic you are expanding. */
  topics: TopicDemand[];

  /** The board's mention universe, under the name the topic pattern's editor
   * autocompletes over — what `addTopic` wires into each child. One derived
   * document of copies, each holding its topic as an unread reference and
   * carrying the board's name for it, rather than the topics themselves, so a
   * reader of the universe expands no topic and `#42` finds a member without
   * expanding one; see `MentionableRow` in
   * `../collection-naming/mentionable.ts`. */
  mentionable: MentionableRow[] | Default<[]>;

  /** The namespace itself: each name to the topic it names. A slug pointing
   * here is what makes a member addressable as `<collection>/<name>`.
   * Published under the default its input carries. */
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;

  /** The names table, one row per named member, which every topic the board
   * creates reads its own name from. Published so a topic composed outside
   * `addTopic` can be wired to the same table. */
  namesTable: NamesTableRow[] | Default<[]>;

  /** What the board declares about its names, for a consumer deciding whether
   * a name may be held rather than an identity. */
  naming: NamingDeclaration;

  /** How many topics the board holds, nulls included. */
  topicCount: number;

  /** The board's mention pivot, one row per topic: the topic, and the topics
   * that mention it. Published so a topic composed outside `addTopic` can be
   * wired to the same table the board's own children read — the graph is
   * derived once, here, and never per topic. */
  crossrefs: TopicCrossrefRow[] | Default<[]>;

  /** The full-board survey surface: one bounded row per topic, carrying the
   * scalars a survey reads. A row IS its topic, so a row's own address is the
   * topic's — `--select index[].@` reads it, and an index into this array is
   * not a stable address. */
  index: TopicIndexRow[] | Default<[]>;

  /** EXPERIMENT (r5-best): one slot per topic, each holding that topic's own
   * entry document. */
  entrySlots: EntrySlot[] | Default<[]>;

  /** EXPERIMENT (r5-best): the named pivot the fills read their rows from. */
  pivot: PivotRow[] | Default<[]>;

  /** EXPERIMENT (r5-best): how many references each per-topic fill wrote.
   * Demanding it is what makes the fills run. */
  perEntryWrites: number[];

  /** Session-local draft for the footer composer (exposed for embedding and
   * headless driving, like the chat exemplar's drafts). */
  newTitle?: PerSession<Writable<string>>;

  /** File a topic. The atomic unit takes the initial body with the title, so
   * no reader observes a title-only halfway state and no follow-up `setBody`
   * finishes a create. Returns the created topic as its survey row — the
   * reference plus the write-time facts the pattern resolved. */
  addTopic: Stream<AddTopicEvent, AddTopicResult>;

  /** Name every unnamed member in filing order. Idempotent. A member filed
   * past `addTopic` also needs a one-time link-bind of `namesTable` onto it
   * before its row and its universe entry show the name, the same operator
   * step `mentionable` states for itself. */
  backfillNames: Stream<BackfillNamesEvent, BackfillNamesResult>;

  /** Submit the footer composer as the current viewer's canonical Profile. */
  submitTopic: Stream<void>;
}

/** Browser composer submit. Profile wishes are resolved by the pattern and
 * bound into this handler as plain snapshot values, which keeps the mutation
 * independently testable without weakening the canonical Profile path. */
export const submitProfileTopic = handler<void, {
  topics: Writable<TopicDemand[] | Default<[]>>;

  /** The mention universe, declared at the child's own demand — the three
   * strings a universe entry carries — so the board's index rows and a plain
   * list of pieces both satisfy it. `Writable` for the handler-state reason
   * `boardCrossrefs` states, and nothing here writes an entry. */
  mentionable: Writable<TopicMentionable[] | Default<[]>>;

  /** `Writable` because a `Cell` is what survives handler state: `HandlerState`
   * passes one through whole and recursively maps everything else, and a
   * `ReadonlyCell` is not a `Cell`, so it arrives as a plain readonly object
   * that no longer satisfies the input this is handed straight to. The input
   * is not what refuses it — it declares `ReadonlyCell`, and an intact
   * `ReadonlyCell` and the plain rows `StripCell` unwraps it to both fit.
   * Nothing here writes a row. */
  boardCrossrefs: Writable<TopicCrossrefRow[] | Default<[]>>;

  /** The names table, handed to the composed topic for the same reason and on
   * the same terms as `boardCrossrefs`. */
  boardNames: Writable<NamesTableRow[] | Default<[]>>;

  /** The namespace, written one key per create. Read for its keys and written
   * at one of them inside this handler, so the allocation and the append are
   * one transaction. */
  // deno-lint-ignore ban-types
  names: Writable<Default<NamesMap, {}>>;
  newTitle: Writable<string>;
  profileName: string;
  profileAvatar: string;
}>((_, {
  topics,
  mentionable,
  boardCrossrefs,
  boardNames,
  names,
  newTitle,
  profileName,
  profileAvatar,
}) => {
  const trimmed = newTitle.get().trim();
  const author = topicAuthorFromPerson(profileName, profileAvatar);
  if (!trimmed || !author) return;
  // EXPERIMENT: this arm's topic takes inputs the composer does not wire.
  // deno-lint-ignore no-explicit-any
  const piece = (Topic as any)({
    topicStateVersion: TOPIC_STATE_VERSION,
    title: trimmed,
    createdAt: Date.now(),
    createdBy: author,
    // Same wiring `addTopic` gives its children: the board's mention index
    // is the universe the new topic's editor autocompletes over, the board's
    // pivot is where it reads its inbound references, and the board's names
    // table is where it reads its own number.
    mentionable,
    boardCrossrefs,
    boardNames,
  });
  // The name and the append are one transaction, as they are in `addTopic`:
  // no reader observes the topic without its name, and a concurrent create
  // serializes on the map's keys rather than taking the same one.
  assignName(names, piece);
  topics.push(piece);
  newTitle.set("");
});

/** EXPERIMENT (r5-best): what the pivot reads of one topic — what it points
 * at, and the two display strings a topic that mentions it shows. */
interface PivotSource {
  mentions: ComparableCell<unknown>[] | Default<[]>;
  title: string | Default<"">;
  shortName?: string;
}

/** EXPERIMENT (r5-best): one row of the pivot, addressed by the topic it is
 * about and NAMED, so a per-entry fill finds its row by a key both sides
 * compute. Its members are cells carrying the two display strings, which is
 * what lets one type serve the pivot, the index over it, and the fill. */
interface PivotRow {
  name: string;
  mentionedBy: ReadonlyCell<PivotSource>[];
}

/** EXPERIMENT (r5-best): the board's mention pivot, named. One row per topic,
 * carrying the board's name for it and the topics that mention it as cells.
 * The name comes from the namespace, joined by the identity each side
 * RESOLVES to — `getEntityId` alone does not resolve, and a member whose
 * document has moved and left a forwarding link is reached through the old
 * address, so an unresolved join would lose it. */
const pivotTable = lift((
  { sources, names }: {
    sources: ReadonlyCell<PivotSource>[] | Default<[]>;
    // deno-lint-ignore ban-types
    names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
  },
): PivotRow[] => {
  const idOf = (cell: unknown): string | undefined => {
    const resolvable = cell as { resolveAsCell?: () => unknown } | undefined;
    const target = typeof resolvable?.resolveAsCell === "function"
      ? resolvable.resolveAsCell()
      : cell;
    const ref = getEntityId(target);
    return ref === undefined ? undefined : entityRefToString(ref);
  };
  const nameById = new Map<string, string>();
  for (const [name, member] of Object.entries(names)) {
    if (member === undefined) continue;
    const id = idOf(member);
    if (id !== undefined) nameById.set(id, name);
  }
  // Every pass below reads plain arrays: an element read through a reactive
  // array resolves a link every time.
  const list = Array.from(sources);
  const mentions = list.map((topic) => {
    const value = topic?.get();
    return value === undefined ? [] : Array.from(value.mentions ?? []);
  });
  const rows: unknown[] = [];
  list.forEach((topic, index) => {
    const id = idOf(topic);
    const name = id === undefined ? undefined : nameById.get(id);
    if (name === undefined) return;
    const inbound: ReadonlyCell<PivotSource>[] = [];
    list.forEach((source, other) => {
      if (other === index) return;
      if (mentions[other].some((mention) => equals(topic, mention))) {
        inbound.push(source);
      }
    });
    rows.push(
      Writable.for<PivotRow>(topic).set({ name, mentionedBy: inbound }),
    );
  });
  return rows as PivotRow[];
});

/** EXPERIMENT (r5-best): the pivot indexed by the name each row carries — a
 * string key, which is the only kind a member can compute for itself. */
const indexPivot = pattern<
  { rows: Cell<PivotRow[]> },
  { index: KeyIndex<string, PivotRow> }
>(({ rows }) => ({ index: rows.keyBy((row) => row.name) }));

/** EXPERIMENT (r5-best): ONE topic's entry, written from that topic's own row.
 * A mention change re-runs this for the topics whose row changed and for no
 * others, which is the whole point of it being per topic. The titles and names
 * it copies come from the mentioning topics themselves, each of which
 * publishes its own name, so no names table is read here. Returns what it
 * wrote, which is what a reader demands to make it run. */
const fillOneEntry = lift((
  { entry, name, row }: {
    entry: Writable<OwnEntry>;
    name: string;
    row: PivotRow | undefined;
  },
): number => {
  const mentionedBy = (row?.mentionedBy ?? []).map((source) => {
    const value = source.get();
    return { title: value?.title ?? "", shortName: value?.shortName ?? "" };
  });
  entry.set({
    name,
    mentionedBy,
  });
  return mentionedBy.length;
});

/** EXPERIMENT (r1-pruned): the universe, bounded to the most recently filed
 * members, so what a member loads at startup does not grow with the board. */
const boundedUniverse = lift((
  { rows }: {
    rows: {
      [NAME]: string | Default<"">;
      title: string | Default<"">;
      shortName: string | Default<"">;
      piece: unknown;
    }[] | Default<[]>;
  },
): MentionableRow[] =>
  rows.slice(Math.max(0, rows.length - 50)) as MentionableRow[]
);

export default pattern<TopicsInput, TopicsOutput>((
  { topics, names, entrySlots },
) => {
  const newTitle = new Writable.perSession("");

  // `.length` alone is what makes this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no topic. Reaching past
  // `.length` — or through a helper this analysis cannot see into — is what
  // puts the whole board back in the read.
  const topicCount = topics.get().length;
  const cards = cardsByActivity({ rows: topics });
  // Derived once for the whole board; every topic reads its own row out of it.
  const crossrefs = crossrefTable({ sources: topics });
  // Also derived once for the whole board: the mention universe every
  // child's editor autocompletes over, as one document of copies instead of
  // the topics themselves.
  const mentionable = boundedUniverse({
    rows: mentionableIndex({ members: topics }),
  });
  // Derived once for the whole board too; every topic reads its own row out
  // of it to learn the number the board calls it by.
  const table = namesTable({ names });
  // EXPERIMENT (r5-best): the named pivot, indexed by name, and one entry per
  // topic written from that topic's own row of it.
  const pivot = pivotTable({ sources: topics, names });
  const byName = indexPivot({ rows: pivot });
  const perEntryWrites = entrySlots.map((slot) => {
    // The lookup is wrapped so the compiler lowers it into a computation that
    // receives the index handle as a cell. Reading `.index` in the board body
    // and handing the result straight to a factory leaves the access as a
    // plain property read of the params cell, which is undefined at build
    // time.
    const row = computed(() => byName.index.lookup(slot.name));
    return fillOneEntry({
      entry: slot.entry,
      name: slot.name,
      row,
    });
  });
  const hasNoTopics = topicCount === 0;

  // Browser authorship comes from the current viewer's canonical Profile.
  // CLI streams below remain wish-free: agents sign each mutation in the
  // event payload, while Fabric records the human principal behind the key.
  // One wish, not three: `#profile` resolves the profile itself, and `name`
  // and `avatar` are fields on it. The `#profileName` / `#profileAvatar`
  // targets are the same two fields reached through a second and third
  // resolution of the same profile.
  const profileWish = wish<{ name: string; avatar: string }>({
    query: "#profile",
  });
  // A wish resolves after setup, so each of these stays a derivation. Reading
  // the fields once here would pin the composer to the empty profile the board
  // started with: the Start button never enables, and a topic filed through it
  // carries blank attribution.
  const profileName = profileWish.result?.name ?? "";
  const profileAvatar = profileWish.result?.avatar ?? "";
  const hasProfile = profileName.trim().length > 0;

  const addTopic = action<AddTopicEvent, AddTopicResult>((
    { title, body, agentName },
  ) => {
    const trimmed = (title ?? "").trim();
    const author = topicAuthorFromAgent(agentName) ??
      rejectMutation("addTopic", "agentName must be non-blank");
    if (!trimmed) rejectMutation("addTopic", "title must be non-empty");
    // EXPERIMENT (r5-best): the entry document is minted before the topic,
    // so the create can hand the topic that document and nothing broader.
    const entry = new Writable<OwnEntry>({
      name: "",
      mentionedBy: [],
    });
    const { name, member: piece } = createNamed(names, (allocated) =>
      Topic({
        shortName: allocated,
        topicStateVersion: TOPIC_STATE_VERSION,
        title: trimmed,
        // Body at create is part of the create's atomic unit; created-with is
        // not an update, so bodyUpdatedBy/At stay unset (createdBy covers it).
        // Preserved verbatim, matching setBody and the UI save path — trimming
        // would corrupt whitespace-sensitive Markdown (indented code blocks).
        body: body ?? "",
        createdAt: Date.now(),
        createdBy: author,
        // The board's mention index, so the editor has a mention universe. A
        // piece from before the index is rewired to it as a one-time
        // link-bind, the backfill the input declares for itself.
        mentionable,
        // EXPERIMENT (r5-best): this topic's own entry, and nothing else of
        // the board.
        ownEntry: entry,
      }));
    entrySlots.push({ name, entry });
    // The name and the append are one transaction: no reader observes the
    // topic without its name, and a concurrent create serializes on the map's
    // keys rather than taking the same one.
    // Mergeable append: concurrent creates from different users all land.
    // The session composer draft is `submitTopic`'s to clear; a headless
    // create has no draft.
    topics.push(piece);
    return { topic: piece, name };
  });

  const backfill = action<BackfillNamesEvent, BackfillNamesResult>(
    ({ agentName }) => {
      if (!topicAuthorFromAgent(agentName)) {
        rejectMutation("backfillNames", "agentName must be non-blank");
      }
      return { assigned: backfillNames(topics, names) };
    },
  );

  const submitTopic = submitProfileTopic({
    topics,
    mentionable,
    boardCrossrefs: crossrefs,
    boardNames: table,
    names,
    newTitle,
    profileName,
    profileAvatar,
  });

  return {
    [NAME]: `Topics (${topicCount})`,
    [UI]: (
      <cf-theme theme={TOPICS_THEME}>
        <cf-screen>
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
                  {card.shortName
                    ? (
                      <cf-badge size="sm" color="primary" data-member-name="">
                        {card.shortName}
                      </cf-badge>
                    )
                    : null}
                  <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                    <cf-text block style="font-weight: 600;">
                      {card.title || "(untitled topic)"}
                    </cf-text>
                    {card.body
                      ? (
                        <cf-text tone="muted" block truncate>
                          {snippet(card.body, 120)}
                        </cf-text>
                      )
                      : null}
                    <cf-text variant="caption" tone="muted">
                      {card.commentCount} comments · by {topicAuthorLabel(
                        card.createdBy,
                      )}
                      {" · "}
                      {whenLabel(card.lastActivityAt ?? 0)}
                    </cf-text>
                  </cf-vstack>
                  <cf-cell-link $cell={card} label="Open" static />
                </cf-hstack>
              </cf-card>
            ))}

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
    topics,
    mentionable,
    names,
    namesTable: table,
    // The sequence policy, claiming no name for the board: what it is bound
    // as is decided where the binding is made.
    naming: SEQUENCE_NAMING,
    topicCount,
    crossrefs,
    entrySlots,
    pivot,
    perEntryWrites,
    // The topics themselves, declared through the index's narrow row schema:
    // a row's address is the topic's address, so a survey and a follow-up read
    // name the same document.
    index: topics,
    newTitle,
    addTopic,
    backfillNames: backfill,
    submitTopic,
  };
});
