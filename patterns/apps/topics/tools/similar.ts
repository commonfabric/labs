import { matches, type SearchScope, type Topic } from "./mirror.ts";

/** A Topic like a text, how like it, and the words they share. */
export interface SimilarHit {
  topic: Topic;

  /**
   * How alike the Topic and the text are, from 0, sharing no word, to 1, the
   * same words in the same proportions.
   */
  similarity: number;

  /** The words the Topic and the text share, those that count most first. */
  shared: string[];
}

/** Shared words named for each Topic listed. */
const SHARED_PER_TOPIC = 5;

/**
 * The Topics among `topics` that share a word with `text`, most similar first
 * and then most recently active first, less those whose titles match a pattern
 * of `exclude`.
 *
 * A Topic is compared by its title, which counts twice, and its body, not by
 * its comments. Similarity is the cosine of the angle between the two texts'
 * word weights (TF-IDF), so it rewards shared words that few Topics use, and
 * nothing else: a word the Topic puts another way, or in another form, adds
 * nothing. The tools' `README.md` gives the weights.
 */
export function similarTopics(
  topics: readonly Topic[],
  text: string,
  { exclude = [] }: Pick<SearchScope, "exclude"> = {},
): SimilarHit[] {
  const counts = topics.map((topic) =>
    wordCounts(`${topic.title}\n${topic.title}\n${topic.body}`)
  );
  const using = new Map<string, number>();
  for (const words of counts) {
    for (const word of words.keys()) {
      using.set(word, (using.get(word) ?? 0) + 1);
    }
  }
  const weigh = (words: Map<string, number>) =>
    unitWeights(
      words,
      (word) => Math.log((topics.length + 1) / ((using.get(word) ?? 0) + 1)),
    );
  const asked = weigh(wordCounts(text));
  const hits: SimilarHit[] = [];
  topics.forEach((topic, index) => {
    if (exclude.some((pattern) => matches(topic.title, pattern))) return;
    const weights = weigh(counts[index]);
    const shared = [...asked].flatMap(([word, weight]) => {
      const product = weight * (weights.get(word) ?? 0);
      return product > 0 ? [{ word, product }] : [];
    }).sort((a, b) => b.product - a.product);
    if (shared.length === 0) return;
    hits.push({
      topic,
      similarity: shared.reduce((sum, { product }) => sum + product, 0),
      shared: shared.slice(0, SHARED_PER_TOPIC).map(({ word }) => word),
    });
  });
  return hits.sort((a, b) =>
    b.similarity - a.similarity ||
    b.topic.lastActivityAt - a.topic.lastActivityAt
  );
}

/**
 * How many times `text` uses each word, a run of letters, their marks, and
 * digits, compared without case or Unicode compatibility differences.
 */
function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const normal = text.normalize("NFKC").toLowerCase();
  for (const [word] of normal.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Helper for {@link similarTopics}, which weighs each word of `counts` by its
 * count and its `rarity`, scaled so the weights' squares sum to 1. A word
 * every Topic uses weighs nothing and is left out.
 */
function unitWeights(
  counts: Map<string, number>,
  rarity: (word: string) => number,
): Map<string, number> {
  const weights = new Map<string, number>();
  let squares = 0;
  for (const [word, count] of counts) {
    const weight = (1 + Math.log(count)) * rarity(word);
    if (weight > 0) {
      weights.set(word, weight);
      squares += weight * weight;
    }
  }
  const length = Math.sqrt(squares);
  for (const [word, weight] of weights) weights.set(word, weight / length);
  return weights;
}
