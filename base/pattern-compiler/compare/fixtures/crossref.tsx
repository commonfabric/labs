/// <cts-enable />
import { type GroupIndex, pattern, type Writable } from "commonfabric";

interface Topic {
  title: string;
  shortName?: string;
  mentions: Writable<Topic>[];
}

interface Pair {
  from: Topic;
  to: Writable<Topic>;
}

interface Row {
  topic: Writable<Topic>;
  name?: string;
  mentionedBy: Writable<Topic>[];
}

// The inverse of a relation that each member holds as a list of
// references. Each topic is spread into one pair for each topic it
// mentions, a `flatMap` over an array of references whose rows are plain
// values in place; the pairs are grouped by the topic mentioned, a cell;
// and a `map` over the array of references looks up, for each topic, the
// pairs that mention it. The parameter of the key function is annotated:
// the crate does not resolve the type of a row of a `map` in the body of a
// `flatMap`, and the class a key is observed in follows its type. The rows are then grouped by the name each
// carries, and the result keeps that index. The number of topics stands
// beside the rows, so that the result holds a plain value as well.
export default pattern<
  { topics: Writable<Topic[]> },
  { count: number; rows: Row[]; byName: GroupIndex<string, Row> }
>(({ topics }) => {
  const pairs = topics.flatMap((from) =>
    from.mentions.map((to) => ({ from, to }))
  );
  const byMentioned = pairs.groupBy((pair: Pair) => pair.to);
  const rows = topics.map((topic) => ({
    topic,
    name: topic.shortName,
    mentionedBy: byMentioned.lookup(topic).map((pair) => pair.from),
  }));
  return {
    count: topics.get().length,
    rows,
    byName: rows.groupBy((row) => row.name),
  };
});
