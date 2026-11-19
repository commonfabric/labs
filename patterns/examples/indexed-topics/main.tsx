/// <cts-enable />
/**
 * A board of topics that mention one another, held in an indexed collection
 * rather than in a list. The board never reads all of its topics: the runtime
 * mirrors each topic's title and mentions into a SQLite database, and both
 * the board's listing and each topic's "mentioned by" are queries over it.
 * A topic is identified by its cell reference throughout, in the tables as
 * much as in the pattern.
 */
import {
  type Cell,
  computed,
  type Default,
  handler,
  type IndexedCollection,
  indexedCollection,
  NAME,
  pattern,
  SELF,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** What the collection mirrors of a topic. */
interface TopicFields {
  title: string;
  mentions: unknown[];
}

interface TopicInput {
  title: Writable<string>;
  mentions: Writable<Default<unknown[], []>>;
  board: IndexedCollection<TopicFields>;
}

/** A row naming one topic. */
interface TitleRow {
  title: string;
}

/** The settled or pending rows of a query for topic titles. */
interface TitleRows {
  pending: boolean;
  result?: TitleRow[];
  error?: unknown;
}

export interface TopicOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  mentions: unknown[];
  mentionedBy: TitleRows;
  rename: Stream<{ title: string }>;
  mention: Stream<{ topic: Cell<TopicFields> }>;
}

const renameTopic = handler<{ title: string }, { title: Writable<string> }>(
  ({ title: next }, { title }) => title.set(next),
);

const mentionTopic = handler<
  { topic: Cell<TopicFields> },
  { mentions: Writable<unknown[]> }
>(({ topic }, { mentions }) => mentions.push(topic));

export const Topic = pattern<TopicInput, TopicOutput>(
  ({ title, mentions, board, [SELF]: self }) => {
    // Every topic whose `mentions` holds this one, read off the relation
    // table by this topic's own reference.
    const mentionedBy = board.query<TitleRow>(
      "SELECT m.title AS title FROM mentions e JOIN members m " +
        "ON m.member_cf_link = e.source_cf_link " +
        "WHERE e.target_cf_link = :self_cf_link ORDER BY m.title",
      { params: { self_cf_link: self } },
    );
    const mentionedByTitles = computed<string[]>(() =>
      (mentionedBy.result ?? []).map((row) => row.title)
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
      mentionedBy,
      rename: renameTopic({ title }),
      mention: mentionTopic({ mentions }),
    };
  },
);

export interface BoardOutput {
  [NAME]: string;
  [UI]: VNode;
  titles: TitleRows;
  topicCount: number;
  latest: TopicOutput | undefined;
  addTopic: Stream<{ title: string }>;
}

const addTopic = handler<
  { title: string },
  {
    topics: IndexedCollection<TopicFields>;
    latest: Writable<TopicOutput | undefined>;
  }
>(({ title }, { topics, latest }) => {
  const topic = Topic({ title, mentions: [], board: topics });
  topics.add(topic);
  latest.set(topic);
});

export default pattern<Record<string, never>, BoardOutput>(() => {
  const topics = indexedCollection<TopicFields>({
    columns: { title: "text" },
    relations: ["mentions"],
    indexes: [["title"]],
  });
  const latest = new Writable<TopicOutput | undefined>(undefined);

  const titles = topics.query<TitleRow>(
    "SELECT title FROM members ORDER BY title LIMIT 100",
  );
  const counts = topics.query<{ n: number }>(
    "SELECT count(*) AS n FROM members",
  );
  const topicCount = computed<number>(() => counts.result?.[0]?.n ?? 0);
  const listed = computed<TitleRow[]>(() => titles.result ?? []);

  return {
    [NAME]: "Indexed topics",
    [UI]: (
      <cf-screen title="Indexed topics">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <cf-label id="topic-count">{topicCount} topics</cf-label>
          <cf-vstack gap="1" id="topic-list">
            {listed.map((row) => <cf-label>{row.title}</cf-label>)}
          </cf-vstack>
        </cf-vstack>
      </cf-screen>
    ),
    titles,
    topicCount,
    latest,
    addTopic: addTopic({ topics, latest }),
  };
});
