/**
 * Measures client-visible `searchPatterns` against the labeled query set in
 * `pattern-index-retrieval-queries.json` and writes a report.
 *
 * Uses `listPatterns`, `searchPatterns`, and metadata-only `getPattern` reads
 * for successor resolution. It publishes nothing and records no event, so it
 * can be run against a live corpus while that corpus is being written to.
 *
 * Usage, from `packages/cf-harness`:
 *
 *   PATTERN_INDEX_BASE_URL=https://index.example \
 *   CF_IDENTITY="$HOME/.cf/my-key.pkcs8" \
 *   deno run -A scripts/score-retrieval.ts --out=report.json
 *
 * Exits non-zero when the run falls below `--min-hit-at-5` or leaves more
 * than `--max-dirty-negatives` negative queries returning something. The
 * thresholds are arguments rather than constants because the corpus moves,
 * and a gate whose expected value is baked in stops being readable the first
 * time someone publishes.
 */

import { Identity } from "@commonfabric/identity";
import {
  PatternIndexClient,
  type PatternIndexListedPattern,
} from "../src/pattern-index/client.ts";
import {
  contentWords,
  descriptionOverlap,
  indiscriminateTerms,
  type LabelledCapability,
  type LabelledQuery,
  type NegativeQuery,
  REPORTED_RANK_CUTOFF,
  scoreRetrieval,
} from "../src/pattern-index/retrieval-scoring.ts";

/**
 * Words dropped before overlap is computed. This list is the SCORER's, not
 * the index's — the index has no stop list at all, which is the defect the
 * `indiscriminateTerms` column exists to quantify.
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "that",
  "this",
  "it",
  "its",
  "is",
  "are",
  "be",
  "can",
  "so",
  "as",
  "at",
  "by",
  "my",
  "me",
  "i",
  "we",
  "you",
  "your",
  "want",
  "need",
  "make",
  "give",
  "build",
  "show",
  "put",
  "have",
  "has",
  "each",
  "them",
  "they",
  "their",
  "one",
  "up",
  "out",
  "into",
  "when",
  "what",
  "how",
  "should",
  "would",
  "there",
  "then",
  "from",
  "some",
  "just",
  "like",
  "able",
  "page",
  "thing",
  "something",
  "somewhere",
  "part",
  "user",
  "little",
]);

interface QuerySet {
  capabilities: LabelledCapability[];
  queries: LabelledQuery[];
  negativeQueries: NegativeQuery[];
  unlabelledObservedQueries: { id: string; text: string; why: string }[];
}

const flag = (
  args: readonly string[],
  name: string,
  fallback: string,
): string =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  ) ??
    fallback;

const requireEnv = (
  name: string,
  readEnv: (name: string) => string | undefined,
): string => {
  const value = readEnv(name);
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
};

/**
 * The visible-metadata haystack used by pattern-index #10 and later:
 * description, keywords, and hashtags.
 */
const searchableText = (entry: PatternIndexListedPattern): string =>
  [entry.description, ...entry.keywords, ...entry.hashtags].join("\n")
    .toLowerCase();

/**
 * Runs the retrieval measurement command and returns its process exit code.
 */
export const main = async (
  args: readonly string[],
  readEnv: (name: string) => string | undefined,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
  now: () => Date = () => new Date(),
): Promise<number> => {
  const setPath = flag(
    args,
    "queries",
    new URL("./pattern-index-retrieval-queries.json", import.meta.url).pathname,
  );
  const outPath = flag(args, "out", "");
  const minHitAt5Text = flag(args, "min-hit-at-5", "0");
  const minHitAt5 = Number(minHitAt5Text);
  if (!Number.isFinite(minHitAt5)) {
    logError(
      `--min-hit-at-5 must be a finite number: ${minHitAt5Text}`,
    );
    return 2;
  }
  const maxDirtyNegativesText = flag(args, "max-dirty-negatives", "99");
  const maxDirtyNegatives = Number(maxDirtyNegativesText);
  if (!Number.isFinite(maxDirtyNegatives)) {
    logError(
      `--max-dirty-negatives must be a finite number: ${maxDirtyNegativesText}`,
    );
    return 2;
  }

  const set: QuerySet = JSON.parse(await Deno.readTextFile(setPath));
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(requireEnv("CF_IDENTITY", readEnv)),
  );
  const client = new PatternIndexClient({
    baseUrl: requireEnv("PATTERN_INDEX_BASE_URL", readEnv),
    signer: identity,
  });

  // The corpus reading is taken first and reported with the numbers. It is
  // never hand-written: the corpus moves, and a report whose numbers cannot
  // be attached to a reading is not comparable to the next one.
  const listed = await client.listPatterns();
  const corpusText = listed.patterns.map(searchableText);
  const readAt = now().toISOString();

  const answersByQuery = new Map<string, readonly string[]>();
  const diagnostics: Record<string, unknown>[] = [];
  const everyQuery: { id: string; text: string; targets: string[] }[] = [
    ...set.queries.map((query) => ({
      id: query.id,
      text: query.text,
      targets: (() => {
        const capability = set.capabilities.find((entry) =>
          entry.id === query.capability
        );
        return [...(capability?.answers ?? []), ...(capability?.partial ?? [])];
      })(),
    })),
    ...set.negativeQueries.map((query) => ({
      id: query.id,
      text: query.text,
      targets: [],
    })),
    ...set.unlabelledObservedQueries.map((query) => ({
      id: query.id,
      text: query.text,
      targets: [],
    })),
  ];

  for (const query of everyQuery) {
    const response = await client.searchPatterns({
      text: query.text,
      limit: REPORTED_RANK_CUTOFF,
    });
    const ranked = response.results.map((result) => result.patternId);
    answersByQuery.set(query.id, ranked);

    const targetText = listed.patterns
      .filter((entry) => query.targets.includes(entry.patternId))
      .map(searchableText)
      .join("\n");
    const terms = contentWords(query.text, STOP_WORDS);
    diagnostics.push({
      queryId: query.id,
      text: query.text,
      returned: ranked.length,
      // Zero targets means overlap is undefined rather than zero: a negative
      // query has nothing to overlap WITH, and reporting 0 would read as
      // "shares no wording with its target" instead of "has no target".
      descriptionOverlap: query.targets.length === 0
        ? null
        : descriptionOverlap(query.text, targetText, STOP_WORDS),
      contentTerms: terms,
      indiscriminateTerms: indiscriminateTerms(terms, corpusText),
      topFive: response.results.slice(0, 5).map((result) => ({
        patternId: result.patternId,
        matchedTerms: result.matchedTerms,
        queryTerms: result.queryTerms,
        signals: result.signals,
        description: result.description,
      })),
    });
  }

  const report = scoreRetrieval(
    set.capabilities,
    set.queries,
    set.negativeQueries,
    answersByQuery,
  );
  const corpus = {
    readAt,
    discoverableEntries: listed.patterns.length,
    eventTypes: listed.eventTypes,
    note:
      "listPatterns returns discoverable entries only; hidden entries are not counted here.",
  };
  const output = { corpus, ...report, diagnostics };

  if (outPath !== "") {
    await Deno.writeTextFile(outPath, JSON.stringify(output, null, 2));
  }
  const hitRate = report.overall.queries === 0
    ? 0
    : report.overall.hitAt5 / report.overall.queries;
  const dirtyNegatives = report.negativeScores.length - report.negativesClean;
  log(JSON.stringify(
    {
      corpus,
      overall: report.overall,
      byRegister: report.byRegister,
      hitRateAt5: hitRate,
      dirtyNegatives,
      failures: report.failures.length,
    },
    null,
    2,
  ));

  const breaches: string[] = [];
  if (hitRate < minHitAt5) {
    breaches.push(
      `hit@5 ${hitRate.toFixed(3)} below --min-hit-at-5=${minHitAt5}`,
    );
  }
  if (dirtyNegatives > maxDirtyNegatives) {
    breaches.push(
      `${dirtyNegatives} negative queries returned results, above --max-dirty-negatives=${maxDirtyNegatives}`,
    );
  }
  for (const breach of breaches) logError(`FAIL: ${breach}`);
  return breaches.length === 0 ? 0 : 1;
};

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) {
  Deno.exit(await main(Deno.args, (name) => Deno.env.get(name)));
}
// deno-coverage-ignore-stop
