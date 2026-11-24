/// <cts-enable />
/**
 * A board of topics that mention one another, held in an indexed collection
 * rather than in a list. The board never reads all of its topics: the runtime
 * mirrors each topic's title and mentions into a SQLite database, and both
 * the board's listing and each topic's "mentioned by" are queries over it.
 * A topic is identified by its cell reference throughout, in the tables as
 * much as in the pattern, and every query returns that reference beside the
 * title it mirrors. The listing returns it as an opaque reference, which
 * selecting a row passes along unread; "mentioned by" returns it as a cell,
 * through which a field the collection does not mirror is read.
 */
import {
  type AsyncResult,
  type Cell,
  computed,
  type Default,
  handler,
  hasError,
  type IndexedCollections,
  indexedCollections,
  isObsolete,
  isPending,
  isSyncing,
  lift,
  NAME,
  type OpaqueCell,
  pattern,
  resultOf,
  SELF,
  type Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

/** What the collection mirrors of a topic. */
interface TopicFields {
  title: string;
  mentions: unknown[];
}

/** The board's collection, whose one kind of member is the topic. */
type Board = IndexedCollections<{ topics: TopicFields }>;

interface TopicInput {
  title: Writable<string>;
  mentions: Writable<Default<unknown[], []>>;
  board: Board;
}

/**
 * What the board reads and calls of the topic a listing row selected. Only
 * the title is required of it: a topic's "mentioned by" is absent until
 * something asks for it, and a row whose reference did not satisfy its type
 * would drop out of the result that holds it.
 */
export interface SelectedTopic {
  title: string;
  mentionedBy?: Rows<MentioningTopic>;
  mention?: Stream<{ topic: TopicRef }>;
}

/** A reference to a topic that is passed along without being read. */
export type TopicRef = OpaqueCell<TopicFields>;

/**
 * A listing row: the mirrored title, and a reference to the topic that is
 * handed on without being read.
 */
export interface ListedTopic {
  topic: TopicRef;
  title: string;
}

/**
 * A "mentioned by" row: the mirrored title, and the mentioning topic as a
 * cell, through which any field the collection does not mirror is read.
 */
export interface MentioningTopic {
  topic: Cell<TopicFields>;
  title: string;
}

/** A query's status and row projection; the rows retain native availability. */
interface Rows<Row> {
  pending: boolean;
  result?: Row[];
  error?: unknown;
}

/** The board's public status fields, derived from the query that owns them. */
export const queryStatus = lift((request: AsyncResult<object>) => {
  if (isObsolete(request)) {
    // The retired result carries its hint; retirement is not a query error.
    return { pending: false, error: undefined };
  }
  return {
    pending: isPending(request) || isSyncing(request),
    error: hasError(request) ? request.message || "Query failed." : undefined,
  };
});

export interface TopicOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  mentions: unknown[];
  mentionedBy: Rows<MentioningTopic>;
  rename: Stream<{ title: string }>;
  mention: Stream<{ topic: TopicRef }>;
}

const renameTopic = handler<{ title: string }, { title: Writable<string> }>(
  ({ title: next }, { title }) => title.set(next),
);

const mentionTopic = handler<
  { topic: TopicRef },
  { mentions: Writable<unknown[]> }
>(({ topic }, { mentions }) => mentions.push(topic));

export const Topic = pattern<TopicInput, TopicOutput>(
  ({ title, mentions, board, [SELF]: self }) => {
    // Every topic whose `mentions` holds this one, read off the relation
    // table by this topic's own reference.
    const mentionedBy = board.query<MentioningTopic>(
      "SELECT m.member_cf_link AS topic, m.title AS title " +
        "FROM topics_mentions e JOIN topics m " +
        "ON m.member_cf_link = e.source_cf_link " +
        "WHERE e.target_cf_link = :self_cf_link ORDER BY m.title",
      { params: { self_cf_link: self } },
    );
    const mentionedStatus = queryStatus(mentionedBy);
    const mentioning = resultOf(mentionedBy).rows;
    const mentionedByTitles = computed(() =>
      mentioning.map((row) => row.title)
    );

    return {
      [NAME]: title,
      [UI]: (
        <cf-vstack gap="1">
          <cf-heading level={4}>{title}</cf-heading>
          <cf-label id="mentioned-by">
            Mentioned by: {mentionedByTitles.map((name) => <span>{name}</span>)}
          </cf-label>
        </cf-vstack>
      ),
      title,
      mentions,
      mentionedBy: {
        pending: mentionedStatus.pending,
        error: mentionedStatus.error,
        result: mentioning,
      },
      rename: renameTopic({ title }),
      mention: mentionTopic({ mentions }),
    };
  },
);

export interface BoardOutput {
  [NAME]: string;
  [UI]: VNode;
  titles: Rows<ListedTopic>;
  topicCount: number;
  selected: SelectedTopic | undefined;
  addTopic: Stream<{ title: string }>;
  select: Stream<{ topic: TopicRef }>;
}

const addTopic = handler<
  { title: string },
  { board: Board }
>(({ title }, { board }) => {
  board.add("topics", Topic({ title, mentions: [], board }));
});

// The reference comes from a listing row and is stored as it arrived: nothing
// here reads the topic it names.
const selectTopic = handler<
  { topic: TopicRef },
  { selected: Writable<SelectedTopic | undefined> }
>(({ topic }, { selected }) => selected.set(topic));

// A listing row's button carries the row's reference, which a click's own
// event does not.
const selectListed = handler<
  unknown,
  { topic: TopicRef; selected: Writable<SelectedTopic | undefined> }
>((_event, { topic, selected }) => selected.set(topic));

/**
 * The count a write to the board also advances, which `addTopic` alone may
 * write. A topic holds the board's handle so that it can ask it a question,
 * and this is what keeps it from adding to the board as well.
 */
type BoardGuard = WriteAuthorizedBy<number, typeof addTopic>;

export default pattern<Record<string, never>, BoardOutput>(() => {
  const guard = new Writable<BoardGuard>(0);
  const board = indexedCollections<{ topics: TopicFields }>({
    topics: {
      columns: { title: "text" },
      relations: ["mentions"],
      indexes: [["title"]],
    },
  }, { guard });
  const selected = new Writable<SelectedTopic | undefined>(undefined);

  const titles = board.query<ListedTopic>(
    "SELECT member_cf_link AS topic, title FROM topics " +
      "ORDER BY title LIMIT 100",
  );
  const counts = board.query<{ n: number }>(
    "SELECT count(*) AS n FROM topics",
  );
  const topicCount = resultOf(counts).rows[0].n;
  const listingStatus = queryStatus(titles);
  const listed = resultOf(titles).rows;

  return {
    [NAME]: "Indexed topics",
    [UI]: (
      <cf-screen title="Indexed topics">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <cf-label id="topic-count">{topicCount} topics</cf-label>
          <cf-vstack gap="1" id="topic-list">
            {listed.map((row) => (
              <cf-button
                onClick={selectListed({ topic: row.topic, selected })}
              >
                {row.title}
              </cf-button>
            ))}
          </cf-vstack>
        </cf-vstack>
      </cf-screen>
    ),
    titles: {
      pending: listingStatus.pending,
      error: listingStatus.error,
      result: listed,
    },
    topicCount,
    selected,
    addTopic: addTopic({ board }),
    select: selectTopic({ selected }),
  };
});
