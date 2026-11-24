/**
 * Scoring for the pattern index's retrieval quality: given a labelled query
 * set and what `searchPatterns` actually ranked for each query, how good was
 * the answer.
 *
 * The scoring lives apart from the script that fetches, because the
 * interesting judgements here are arithmetic on labels and want to be tested
 * without a network. `scripts/score-retrieval.ts` is the caller.
 *
 * Three decisions worth stating, because a reader will otherwise assume the
 * usual ones:
 *
 *   * **`partial` is not relevant.** An entry with the right subject and the
 *     wrong behaviour — a static picture of a tracker where a tracker was
 *     asked for — is scored as a miss and counted separately as MISLEADING.
 *     Partial credit would report the corpus as half-answering a need that
 *     nothing in it answers, which is the failure this instrument exists to
 *     find.
 *   * **Two cut-offs, because the tool has two.** `search_patterns` reports
 *     ten hits to the model but fetches declared shapes only for the first
 *     five, so a hit at rank 7 reaches the model without the argument and
 *     result types it would need to wire the thing in. Ranks 6-10 are scored
 *     as `buried` rather than as found.
 *   * **Hit rate leads, not mean precision.** The decision a session makes is
 *     reuse or rebuild, and one answering entry at a readable rank settles
 *     it. Precision is reported too, but a mean over queries hides the
 *     individual failures, so every failure is also emitted by name.
 */

/** Where the tool stops fetching declared shapes. */
export const DETAILED_RANK_CUTOFF = 5;

/** Where the tool stops reporting hits at all. */
export const REPORTED_RANK_CUTOFF = 10;

export interface LabelledCapability {
  id: string;
  need: string;

  /** Entries a session could use for `need` without rewriting behaviour. */
  answers: readonly string[];

  /** Entries with the right subject and the wrong behaviour. */
  partial: readonly string[];

  evidence: string;
}

export interface LabelledQuery {
  id: string;
  capability: string;
  register: string;
  text: string;
}

export interface NegativeQuery {
  id: string;
  kind: string;
  text: string;
  why: string;
}

/** One query's ranked answer, best first, as `searchPatterns` returned it. */
export interface RankedAnswer {
  queryId: string;
  patternIds: readonly string[];
}

export type FailureKind =
  /** The capability has answering entries and none reached rank 10. */
  | "miss"
  /** An answering entry reached ranks 6-10, so the model sees it without shapes. */
  | "buried"
  /** A `partial` entry outranked every answering entry inside the top 5. */
  | "misleading"
  /** A query nothing should answer returned something. */
  | "false-positive";

export interface QueryFailure {
  queryId: string;
  kind: FailureKind;
  detail: string;
}

export interface QueryScore {
  queryId: string;
  capability: string;
  register: string;

  /** 1-based rank of the first answering entry, or `undefined` for none. */
  firstAnswerRank?: number;

  answersInTop5: number;
  answersInTop10: number;
  partialsInTop5: number;
  relevantTotal: number;
  returned: number;
  failures: readonly QueryFailure[];
}

export interface NegativeScore {
  queryId: string;
  kind: string;
  returned: number;
  returnedInTop5: number;
  failures: readonly QueryFailure[];
}

export interface Aggregate {
  queries: number;

  /** Queries whose first answering entry reached rank 5 or better. */
  hitAt5: number;

  /** Queries whose first answering entry reached rank 10 or better. */
  hitAt10: number;

  /** Mean over queries of 1/rank of the first answering entry, 0 for none. */
  meanReciprocalRank: number;

  /** Mean over queries of answering entries in the top 5, divided by 5. */
  precisionAt5: number;

  /** Mean over queries of the share of answering entries reaching the top 5. */
  recallAt5: number;
}

export interface RetrievalReport {
  overall: Aggregate;
  byRegister: Readonly<Record<string, Aggregate>>;
  byCapability: Readonly<Record<string, Aggregate>>;
  queryScores: readonly QueryScore[];
  negativeScores: readonly NegativeScore[];
  failures: readonly QueryFailure[];

  /** Negative queries that correctly returned nothing. */
  negativesClean: number;
}

const rankOf = (
  ranked: readonly string[],
  members: ReadonlySet<string>,
): number | undefined => {
  const index = ranked.findIndex((id) => members.has(id));
  return index === -1 ? undefined : index + 1;
};

const countWithin = (
  ranked: readonly string[],
  members: ReadonlySet<string>,
  cutoff: number,
): number => ranked.slice(0, cutoff).filter((id) => members.has(id)).length;

/**
 * Scores one query. `ranked` is the search result in the order the index
 * returned it, truncated by the caller to what the tool would have reported.
 */
export function scoreQuery(
  query: LabelledQuery,
  capability: LabelledCapability,
  ranked: readonly string[],
): QueryScore {
  const answers = new Set(capability.answers);
  const partials = new Set(capability.partial);
  const firstAnswerRank = rankOf(ranked, answers);
  const firstPartialRank = rankOf(ranked, partials);
  const answersInTop5 = countWithin(ranked, answers, DETAILED_RANK_CUTOFF);
  const answersInTop10 = countWithin(ranked, answers, REPORTED_RANK_CUTOFF);
  const partialsInTop5 = countWithin(ranked, partials, DETAILED_RANK_CUTOFF);

  const failures: QueryFailure[] = [];
  if (answers.size > 0) {
    if (firstAnswerRank === undefined) {
      failures.push({
        queryId: query.id,
        kind: "miss",
        detail:
          `no entry answering "${capability.need}" appeared in ${ranked.length} results`,
      });
    } else if (firstAnswerRank > DETAILED_RANK_CUTOFF) {
      failures.push({
        queryId: query.id,
        kind: "buried",
        detail:
          `first answering entry at rank ${firstAnswerRank}, past the cut-off where declared shapes stop being fetched`,
      });
    }
  }
  // A partial ahead of every answer inside the detailed window is the case
  // where the model is handed the wrong thing WITH its shapes, which is more
  // expensive than being handed nothing.
  if (
    firstPartialRank !== undefined &&
    firstPartialRank <= DETAILED_RANK_CUTOFF &&
    (firstAnswerRank === undefined || firstPartialRank < firstAnswerRank)
  ) {
    failures.push({
      queryId: query.id,
      kind: "misleading",
      detail:
        `a partial match ranked ${firstPartialRank}, ahead of any entry that answers the need`,
    });
  }

  return {
    queryId: query.id,
    capability: query.capability,
    register: query.register,
    ...(firstAnswerRank !== undefined ? { firstAnswerRank } : {}),
    answersInTop5,
    answersInTop10,
    partialsInTop5,
    relevantTotal: answers.size,
    returned: ranked.length,
    failures,
  };
}

/**
 * Scores a query nothing in the corpus should answer. Anything returned is a
 * false positive; the count is reported because five confident hits and one
 * marginal hit are different failures.
 */
export function scoreNegative(
  query: NegativeQuery,
  ranked: readonly string[],
): NegativeScore {
  const returnedInTop5 = Math.min(ranked.length, DETAILED_RANK_CUTOFF);
  const failures: QueryFailure[] = ranked.length === 0 ? [] : [{
    queryId: query.id,
    kind: "false-positive" as const,
    detail:
      `${ranked.length} results for a query nothing should answer; ${returnedInTop5} of them inside the detailed window`,
  }];
  return {
    queryId: query.id,
    kind: query.kind,
    returned: ranked.length,
    returnedInTop5,
    failures,
  };
}

const aggregate = (scores: readonly QueryScore[]): Aggregate => {
  if (scores.length === 0) {
    return {
      queries: 0,
      hitAt5: 0,
      hitAt10: 0,
      meanReciprocalRank: 0,
      precisionAt5: 0,
      recallAt5: 0,
    };
  }
  const hitAt5 = scores.filter((score) =>
    score.firstAnswerRank !== undefined &&
    score.firstAnswerRank <= DETAILED_RANK_CUTOFF
  ).length;
  const hitAt10 =
    scores.filter((score) =>
      score.firstAnswerRank !== undefined &&
      score.firstAnswerRank <= REPORTED_RANK_CUTOFF
    ).length;
  const reciprocal = scores.reduce(
    (sum, score) =>
      sum +
      (score.firstAnswerRank === undefined ? 0 : 1 / score.firstAnswerRank),
    0,
  );
  const precision = scores.reduce(
    (sum, score) => sum + score.answersInTop5 / DETAILED_RANK_CUTOFF,
    0,
  );
  // A capability with no answering entry contributes nothing to recall
  // rather than a zero: there was nothing to recall, and averaging in a zero
  // would report the corpus as failing to return what it does not hold.
  const recallable = scores.filter((score) => score.relevantTotal > 0);
  const recall = recallable.reduce(
    (sum, score) => sum + score.answersInTop5 / score.relevantTotal,
    0,
  );
  return {
    queries: scores.length,
    hitAt5,
    hitAt10,
    meanReciprocalRank: reciprocal / scores.length,
    precisionAt5: precision / scores.length,
    recallAt5: recallable.length === 0 ? 0 : recall / recallable.length,
  };
};

const groupBy = (
  scores: readonly QueryScore[],
  key: (score: QueryScore) => string,
): Record<string, Aggregate> => {
  const groups = new Map<string, QueryScore[]>();
  for (const score of scores) {
    const bucket = groups.get(key(score)) ?? [];
    bucket.push(score);
    groups.set(key(score), bucket);
  }
  return Object.fromEntries(
    [...groups].map(([name, bucket]) => [name, aggregate(bucket)]),
  );
};

/**
 * Scores a whole run. `answersByQuery` maps a query id to the ranked pattern
 * ids the index returned for it; a query with no entry there is scored as
 * having returned nothing, so a query the runner failed to issue reports as a
 * miss rather than disappearing from the denominator.
 */
export function scoreRetrieval(
  capabilities: readonly LabelledCapability[],
  queries: readonly LabelledQuery[],
  negatives: readonly NegativeQuery[],
  answersByQuery: ReadonlyMap<string, readonly string[]>,
): RetrievalReport {
  const byId = new Map(capabilities.map((entry) => [entry.id, entry]));
  const queryScores = queries.map((query) => {
    const capability = byId.get(query.capability);
    if (capability === undefined) {
      throw new Error(
        `query ${query.id} names capability ${query.capability}, which the set does not define`,
      );
    }
    return scoreQuery(query, capability, answersByQuery.get(query.id) ?? []);
  });
  const negativeScores = negatives.map((query) =>
    scoreNegative(query, answersByQuery.get(query.id) ?? [])
  );
  return {
    overall: aggregate(queryScores),
    byRegister: groupBy(queryScores, (score) => score.register),
    byCapability: groupBy(queryScores, (score) => score.capability),
    queryScores,
    negativeScores,
    failures: [
      ...queryScores.flatMap((score) => score.failures),
      ...negativeScores.flatMap((score) => score.failures),
    ],
    negativesClean: negativeScores.filter((score) => score.returned === 0)
      .length,
  };
}

/**
 * How much of a query's wording the target entries already carry, as a share
 * of the query's content words. High overlap on a query that retrieved well
 * means the entry was found by its description rather than by its behaviour,
 * which is the confound this whole instrument is built around.
 *
 * `corpusText` is the searchable text of the entries the query targets,
 * lowercased. Matching is by substring, mirroring what the index does, so the
 * number describes the index's own notion of a match rather than a better one.
 */
export function descriptionOverlap(
  text: string,
  corpusText: string,
  stopWords: ReadonlySet<string>,
): number {
  const words = contentWords(text, stopWords);
  if (words.length === 0) return 0;
  const haystack = corpusText.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length / words.length;
}

/** A query's words with the stop list and single characters removed. */
export function contentWords(
  text: string,
  stopWords: ReadonlySet<string>,
): readonly string[] {
  return [
    ...new Set(
      text.toLowerCase().split(/[^a-z0-9]+/).filter((word) =>
        word.length > 1 && !stopWords.has(word)
      ),
    ),
  ];
}

/**
 * Terms that do not tell entries apart: those the given share or more of the
 * corpus already contains. The index counts every matched term equally, so a
 * query made mostly of these ranks on noise, and naming them is how that
 * shows up as a number rather than as an impression.
 */
export function indiscriminateTerms(
  terms: readonly string[],
  entryTexts: readonly string[],
  threshold = 0.5,
): readonly string[] {
  if (entryTexts.length === 0) return [];
  const lowered = entryTexts.map((text) => text.toLowerCase());
  return terms.filter((term) =>
    lowered.filter((text) => text.includes(term)).length / lowered.length >=
      threshold
  );
}
