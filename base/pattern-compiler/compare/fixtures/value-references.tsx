/// <cts-enable />
import { lift, pattern, type Writable } from "commonfabric";

interface Topic {
  title: string;
  mentions: Writable<Topic>[];
}

interface Pair {
  from: Writable<Topic>;
  to: Writable<Topic>;
}

// Plain values that hold references, generated from scratch by a `lift`:
// one pair for each mention, with a reference to the topic that mentions
// and one to the topic mentioned. A `map` over the pairs reads the title of
// the topic that mentions. The topics refer to each other through their
// mentions, so the value behind a pair with every reference followed is a
// tree as large as the number of paths through the mentions.
const pairsOf = lift(({ topics }: { topics: Writable<Topic>[] }): Pair[] =>
  topics.flatMap((from) =>
    (from.get().mentions ?? []).map((to) => ({ from, to }))
  )
);

export default pattern<
  { topics: Writable<Topic>[] },
  { titles: string[] }
>(({ topics }) => {
  const pairs = pairsOf({ topics });
  return { titles: pairs.map((pair) => pair.from.title) };
});
