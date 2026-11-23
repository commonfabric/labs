/// <cts-enable />
import { type GroupIndex, pattern, type Writable } from "commonfabric";

interface Topic {
  title: string;
  mentions: Writable<Topic>[];
}

interface Pair {
  from: Topic;
  to: Writable<Topic>;
}

interface Row {
  topic: Writable<Topic>;
  mentionedBy: Pair[];
}

// The inverse of a relation that each member holds as a list of
// references, where each row holds the bucket it looked up and the result
// keeps the index. Each topic is spread into one pair for each topic it
// mentions, the pairs are grouped by the topic mentioned, a cell, and a
// `map` over the array of references looks up, for each topic, the pairs
// that mention it. The number of topics stands beside the rows, so that
// the result holds a plain value as well.
export default pattern<
  { topics: Writable<Topic[]> },
  { count: number; rows: Row[]; byMentioned: GroupIndex<unknown, Pair> }
>(({ topics }) => {
  const pairs = topics.flatMap((from) =>
    from.mentions.map((to) => ({ from, to }))
  );
  const byMentioned = pairs.groupBy((pair: Pair) => pair.to);
  const rows = topics.map((topic) => ({
    topic,
    mentionedBy: byMentioned.lookup(topic),
  }));
  return { count: topics.get().length, rows, byMentioned };
});
